'use strict'

// Standalone SealMiner 4028 API simulator. Zero MDK dependencies: this is the
// same surface a real miner on the LAN presents, so the worker (and anyone
// evaluating it) can run with no hardware.
//
// Parameterized by series, firmware, chip count, fault injection, legacy
// field types, write-permission and response truncation — the six dimensions
// the worker has to behave correctly across.

const net = require('node:net')
const s = require('./state')

// Reply codes per command (doc sections 3.x / 4.1).
const CODES = {
  version: [22, 'Bdminer versions'],
  summary: [11, 'Summary'],
  config: [33, 'Bdminer config'],
  devs: [9, '1 ASC(s)'],
  pools: [7, 'Pool(s)'],
  devdetails: [69, 'Device Details'],
  stats: [70, 'Bdminer stats'],
  coin: [78, 'Bdminer coin'],
  switchpool: [27, 'Switching to pool'],
  enablepool: [49, 'Pool already enabled'],
  disablepool: [48, 'Disabling pool'],
  addpool: [55, 'Added pool'],
  removepool: [68, 'Removed pool'],
  updatepools: [200, 'Update pools success'],
  ascset: [119, 'ASC 0 set OK']
}

const ASCSET_SUBCOMMANDS = [
  'suspend', 'resume', 'powerlimit', 'workmode', 'timezone', 'preheat',
  'fast-raise-freq', 'help', 'hostname', 'network', 'webpasswd',
  'idle-fan-timer', 'stratum-disconnect-timeout', 'miner-status'
]

// Firmware gates, mirroring the document's per-feature version notes. The
// mock enforces them so the worker's capability matrix is tested against a
// device that actually refuses, not just against its own table.
// Firmware below this build stores a mining setting and applies it at the
// next bdminer restart; at or above it, the firmware restarts bdminer itself.
// Confirmed on a real A2 (2026040101, below the threshold): workmode=sleep
// answered "ASC 0 set OK", Mining Mode stayed Normal, the miner kept hashing
// — and then slept on the next restart. Modelling it here is the whole point:
// a permissive mock is what let that behaviour be mistaken for a no-op.
const SETTINGS_AUTO_RESTART = 2026060101

const FIRMWARE_GATES = {
  hostname: (fw) => fw >= 2025062602,
  network: (fw) => fw >= 2025062602,
  webpasswd: (fw) => fw >= 2025062602,
  'idle-fan-timer': (fw) => fw >= 2025081801,
  // Removed between 2025080401 and 20260531, restored in 2026060101.
  resume: (fw) => fw >= 2026060101 || fw < 2025080401
}

const now = () => Math.floor(Date.now() / 1000)

// Firmware strings come as 8-digit dates ("20230805FF") or 10-digit
// date+build values ("2026060901"); comparing the two directly would make
// a 2026 date look older than a 2025 build. Deliberately a second, local
// implementation of the same rule as lib/capabilities.js: the mock must
// enforce gating independently, or the test only proves the worker agrees
// with itself.
const firmwareValue = (raw) => {
  const digits = /^(\d{8,10})/.exec(String(raw ?? '').trim())
  return digits ? Number(digits[1].padEnd(10, '0')) : 0
}

const createServer = (opts = {}) => {
  const state = s.createState(opts)
  const fw = firmwareValue(state.firmware)

  const envelope = (command, section, payload, over = {}) => {
    const [code, msg] = CODES[command] || [0, command]
    const body = {
      STATUS: [{
        STATUS: over.letter || 'S',
        When: now(),
        Code: over.code ?? code,
        Msg: over.msg || msg,
        Description: `bdminer ${state.cfg.bdminerVersion}`
      }],
      id: 1
    }
    if (section) body[section] = Array.isArray(payload) ? payload : [payload]
    return body
  }

  const errorReply = (code, msg) => ({
    STATUS: [{
      STATUS: 'E',
      When: now(),
      Code: code,
      Msg: msg,
      Description: `bdminer ${state.cfg.bdminerVersion}`
    }],
    id: 1
  })

  // --- ascset -------------------------------------------------------------

  // "0,workmode,{"mode":"normal"}" — the JSON blob can contain commas, so
  // only the first two separators are structural.
  const splitAscset = (parameter) => {
    const text = String(parameter || '')
    const first = text.indexOf(',')
    if (first === -1) return { deviceId: text.trim(), sub: '', json: null }
    const second = text.indexOf(',', first + 1)
    if (second === -1) {
      return { deviceId: text.slice(0, first).trim(), sub: text.slice(first + 1).trim(), json: null }
    }
    return {
      deviceId: text.slice(0, first).trim(),
      sub: text.slice(first + 1, second).trim(),
      json: text.slice(second + 1).trim()
    }
  }

  const ascset = (parameter) => {
    const { sub, json } = splitAscset(parameter)
    if (!ASCSET_SUBCOMMANDS.includes(sub)) return errorReply(14, `ASC 0 set failed: unknown ${sub}`)

    if (sub === 'help') {
      // A real miner lists only the subcommands its firmware actually has:
      // the A2 on 2026040101 omitted `resume`, matching the documented
      // removal window, while the A3 and A4 on newer builds listed it. The
      // mock filtered nothing here, so `help` advertised gated subcommands
      // the same mock would then refuse — which let the worker's discovery
      // look like it was overriding a gate correctly when it was only
      // reading an over-generous list.
      const fw = firmwareValue(state.firmware)
      const available = ASCSET_SUBCOMMANDS
        .filter((x) => x !== 'help')
        .filter((x) => !FIRMWARE_GATES[x] || FIRMWARE_GATES[x](fw))
      return envelope('ascset', null, null, {
        letter: 'I',
        code: 118,
        msg: `ASC 0 set help: ${available.join(' & ')}`
      })
    }

    const gate = FIRMWARE_GATES[sub]
    if (gate && !gate(fw)) return errorReply(14, `ASC 0 set failed: ${sub} not supported on firmware ${state.firmware}`)

    if (!state.cfg.writesEnabled) return errorReply(45, 'Access denied')

    let args = {}
    if (json) {
      try {
        args = JSON.parse(json)
      } catch {
        return errorReply(23, 'Invalid JSON format')
      }
    }

    const result = applyAscset(state, sub, args, fw, fw >= SETTINGS_AUTO_RESTART)
    if (result !== true) return errorReply(120, `ASC 0 set failed: ${result}`)
    return envelope('ascset', null, null, {})
  }

  // --- pools --------------------------------------------------------------

  const updatepools = (parameter) => {
    if (!state.cfg.writesEnabled) return errorReply(45, 'Access denied')
    let parsed
    try {
      parsed = JSON.parse(String(parameter || ''))
    } catch {
      return errorReply(23, 'Invalid JSON format')
    }
    const pools = parsed?.pools
    if (!Array.isArray(pools) || pools.length === 0) return errorReply(8, 'No available pool')
    if (pools.some((p) => !p || typeof p.url !== 'string' || p.url === '')) {
      return errorReply(201, 'Update fail')
    }
    state.pools = pools.map((p, i) => ({
      index: i,
      url: p.url,
      user: p.user || '',
      status: 'Alive',
      priority: i,
      stratumActive: i === 0,
      accepted: 0,
      rejected: 0
    }))
    return envelope('updatepools', null, null, {})
  }

  // --- dispatch -----------------------------------------------------------

  const handle = (request) => {
    const command = String(request?.command || '')
    switch (command) {
      case 'version': return envelope(command, 'VERSION', s.buildVersion(state))
      case 'summary': return envelope(command, 'SUMMARY', s.buildSummary(state))
      case 'config': return envelope(command, 'CONFIG', s.buildConfig(state))
      case 'devs': return envelope(command, 'DEVS', s.buildDevs(state))
      case 'pools': return envelope(command, 'POOLS', s.buildPools(state))
      case 'devdetails': return envelope(command, 'DEVDETAILS', s.buildDevDetails(state))
      case 'stats': return envelope(command, 'STATS', s.buildStats(state))
      case 'coin': return envelope(command, 'COIN', s.buildCoin(state))
      case 'restart':
        if (!state.cfg.writesEnabled) return errorReply(45, 'Access denied')
        state.startupTimes += 1
        state.tuneStatus = 'coarse_tuning'
        applyPending(state)
        return { STATUS: 'RESTART', id: 1 }
      case 'reboot':
        if (!state.cfg.writesEnabled) return errorReply(45, 'Access denied')
        state.systemUptime = 0
        state.startupTimes += 1
        state.pmState = 'initializing'
        applyPending(state)
        return { STATUS: 'REBOOT', id: 1 }
      case 'updatepools': return updatepools(request.parameter)
      case 'ascset': return ascset(request.parameter)
      case 'switchpool':
      case 'enablepool':
      case 'disablepool':
      case 'addpool':
      case 'removepool':
        if (!state.cfg.writesEnabled) return errorReply(45, 'Access denied')
        return envelope(command, null, null, {})
      default:
        return errorReply(14, 'Invalid command')
    }
  }

  // --- wire ---------------------------------------------------------------

  const serialize = (body) => {
    let text = JSON.stringify(body)
    const limit = state.cfg.truncateAt
    if (limit && text.length > limit) {
      // The firmware signals a clipped answer with id: 0. Reproduce that:
      // cut the payload, then re-close the JSON so it still parses.
      const clipped = { ...body, id: 0 }
      text = JSON.stringify(clipped)
      const head = text.slice(0, limit)
      const lastComma = head.lastIndexOf(',"')
      text = `${head.slice(0, lastComma === -1 ? head.length : lastComma)}}],"id":0}`
    }
    return text
  }

  const server = net.createServer((socket) => {
    const chunks = []
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', () => socket.destroy())
    socket.once('end', () => {
      let request
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim())
      } catch {
        socket.end(JSON.stringify(errorReply(23, 'Invalid JSON format')))
        return
      }
      socket.end(serialize(handle(request)))
    })
  })

  server.listen(opts.port ?? 0, opts.host || '127.0.0.1')

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address()))
    server.once('error', reject)
  })

  return {
    server,
    state,
    ready,
    get port () { return server.address()?.port ?? null },
    /** Inject or clear a fault at runtime, then rebuild derived state. */
    setFault (name, on = true) {
      if (on) state.faults.add(name)
      else state.faults.delete(name)
      const fresh = s.createState({ ...opts, faults: [...state.faults] })
      state.boards = fresh.boards
      state.fans = fresh.fans
      state.temp = fresh.temp
      state.errorCode = fresh.errorCode
      state.stratumDisconnect = fresh.stratumDisconnect
      state.pools = fresh.pools
    },
    close () {
      server.close()
    },
    exit () {
      server.close()
    }
  }
}

// Every ascset value must be a JSON STRING. A real A2 (firmware 2026040101)
// refuses a number or a boolean with 'Missing "<key>"', even where the
// document calls the field an int or a boolean. The mock enforces that: it is
// what caught two encoding bugs in this worker that the document's own
// wording had hidden.
const str = (args, key) => (typeof args[key] === 'string' ? args[key] : undefined)

/**
 * A bdminer restart makes every stored mining setting take effect. That is
 * how a miner set to sleep an hour ago stops hashing the moment someone
 * restarts it.
 */
const applyPending = (state) => {
  const p = state.pending
  if (p.miningMode !== undefined) {
    // "sleep" is a workmode the firmware accepts but never reports back:
    // Mining Mode's documented values contain no Sleep, and a sleeping miner
    // shows up as PM State Suspended instead. That is what a real A2 looked
    // like after a restart applied a stored sleep — Suspended, 0 hashrate,
    // ~95 W. So the reported mode is left alone.
    if (p.miningMode === 'sleep') state.pmState = 'suspended'
    else state.miningMode = p.miningMode
  }
  if (p.powerLimit !== undefined) state.powerLimit = p.powerLimit
  if (p.fastRaiseFreq !== undefined) state.fastRaiseFreq = p.fastRaiseFreq
  state.pending = {}
}

/**
 * Apply one ascset subcommand. Returns true or a failure reason string.
 * @param {boolean} live whether this firmware applies mining settings at once
 */
const applyAscset = (state, sub, args, fw, live) => {
  switch (sub) {
    case 'suspend':
      state.pmState = 'suspended'
      return true
    case 'resume':
      state.pmState = 'running'
      return true
    case 'powerlimit': {
      if (str(args, 'value') === undefined) return 'Missing "value"'
      const value = Number(args.value)
      if (!Number.isFinite(value) || value <= 0) return 'bad powerlimit'
      // Reproduce what an A2 on firmware 2026040101 actually does: reply
      // "ASC 0 set OK" and change nothing. Injected as a fault so the
      // worker's readback verification is exercised in CI.
      if (state.faults.has('powerlimit_noop')) return true
      if (!live) { state.pending.powerLimit = value; return true }
      state.powerLimit = value
      state.tuneStatus = 'coarse_tuning'
      return true
    }
    case 'workmode': {
      if (str(args, 'mode') === undefined) return 'Missing "mode"'
      const mode = args.mode
      if (!s.WORKMODES[state.series].includes(mode)) return `bad workmode ${mode}`
      if (mode === 'sleep' && fw < 2025101601) return 'sleep not supported'
      if (!live) { state.pending.miningMode = mode; return true }
      if (mode === 'sleep') state.pmState = 'suspended'
      else state.miningMode = mode
      state.tuneStatus = 'coarse_tuning'
      return true
    }
    case 'timezone': {
      const value = str(args, 'value')
      if (value === undefined) return 'Missing "value"'
      // The firmware validates the zone itself and reports a real failure.
      if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value) || value === 'Not/AZone') {
        return `Failed to set timezone: ${value}`
      }
      state.timezone = value
      return true
    }
    case 'hostname': {
      const value = str(args, 'value')
      if (value === undefined) return 'Missing "value"'
      if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value)) {
        return `Failed to set hostname: ${value}`
      }
      state.hostname = value
      return true
    }
    case 'network':
      if (args.dhcp === undefined) return 'bad network'
      state.network = { ...args }
      return true
    case 'webpasswd':
      if (str(args, 'user') === undefined) return 'Missing "user"'
      if (str(args, 'new-pass') === undefined) return 'Missing "new-pass"'
      return true
    case 'preheat': {
      // All four fields are required, in this order of complaint.
      for (const key of ['enable_boot_preheat', 'boot_preheat_temp', 'boot_preheat_timeout', 'enable_tune_preheat']) {
        if (str(args, key) === undefined) return `Missing "${key}"`
      }
      for (const key of ['enable_boot_preheat', 'enable_tune_preheat']) {
        if (!['0', '1'].includes(args[key])) return `Invalid "${key}" value`
      }
      if (!Number.isFinite(Number(args.boot_preheat_temp))) return 'Invalid "boot_preheat_temp"'
      // NOTE: the firmware does NOT enforce the documented 0..35 range —
      // "99" is accepted. The worker's own range check is the only guard.
      state.preheat = { ...args }
      return true
    }
    case 'fast-raise-freq': {
      const value = str(args, 'value')
      if (value === undefined) return 'Missing "value"'
      // "1"/"0" only: "true"/"false" are refused by the real firmware.
      if (!['0', '1'].includes(value)) return 'Invalid "enable_fast_raise_freq"'
      if (state.faults.has('fastraisefreq_noop')) return true
      if (!live) { state.pending.fastRaiseFreq = value === '1'; return true }
      state.fastRaiseFreq = value === '1'
      state.tuneStatus = 'coarse_tuning'
      return true
    }
    case 'idle-fan-timer': {
      for (const key of ['interval', 'on_duration', 'speed']) {
        if (str(args, key) === undefined) return `Missing "${key}"`
      }
      const speed = Number(args.speed)
      if (!Number.isFinite(speed) || speed < 0 || speed > 100) return 'bad speed'
      state.idleFanTimer = { ...args }
      return true
    }
    case 'stratum-disconnect-timeout': {
      if (str(args, 'value') === undefined) return 'Missing "value"'
      const value = Number(args.value)
      if (!Number.isFinite(value) || value <= 0) return 'bad timeout'
      state.stratumDisconnectTimeout = value
      return true
    }
    default:
      return `unknown ${sub}`
  }
}

module.exports = { createServer, ASCSET_SUBCOMMANDS, FIRMWARE_GATES, CODES, SETTINGS_AUTO_RESTART }
