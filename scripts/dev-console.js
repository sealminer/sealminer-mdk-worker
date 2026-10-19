#!/usr/bin/env node
'use strict'

// Worker development console.
//
//   MDK_REPO=../mdk node scripts/dev-console.js [--port 7070]
//                                                [--live <address>]...
//
// --live adds a real miner alongside the mocks. Its telemetry is read for
// real; fault injection is unavailable for it (there is no mock to poke) and
// the page disables those controls.
//
// Boots a mock SealMiner per device, hosts this package on the real
// WorkerRuntimeV2, and serves a page that drives it through real MDK protocol
// envelopes — the same path Kernel uses.
//
// This is a DEVELOPMENT TOOL for this package, not an MDK site UI. A fleet
// dashboard is a different MDK extension point (a Gateway plugin plus the UI
// devkit) and belongs to whoever operates the site, not to a device worker.
// What this console is for:
//
//   - watching every declared telemetry channel update live, and reading any
//     one of them on its own — a named pull is a different route through the
//     runtime than the `metrics` fan-out, and the only one that can carry a
//     per-channel parameter
//   - firing all 14 commands, with the form built from the contract itself
//   - running every test layer, from lint to the Kernel chain
//   - injecting faults and seeing health/alerts react
//   - watching the command guard's audit events stream
//   - comparing A2, A3 Air and A4 Ultra Hydro, each mock carrying that
//     product's measured hardware, plus old/new firmware side by side
//
// It ships with the package because it is genuinely useful to whoever picks
// this worker up, but nothing in it is loaded by the runtime.

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { createServer: createMock } = require('../mock/server')

const MDK_REPO = process.env.MDK_REPO
  ? path.resolve(process.env.MDK_REPO)
  : path.resolve(__dirname, '../../mdk')

let WorkerRuntimeV2
try {
  WorkerRuntimeV2 = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/worker-runtime-v2'))
} catch (err) {
  console.error(`Could not load WorkerRuntimeV2 from ${MDK_REPO}`)
  console.error('Clone MDK as a sibling directory, or set MDK_REPO. See README.md.')
  process.exit(1)
}

// Envelopes come from Kernel's own builder when the kernel package is
// installed, so the shape driven into the runtime is the real one rather than
// a local imitation that could drift. The console still runs with only
// mdk-worker installed, on a hand-built envelope, and says which it is using.
let kernelProtocol = null
try {
  const { build } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/envelope'))
  const { ACTIONS, MESSAGE_TYPES } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/actions'))
  kernelProtocol = { build, ACTIONS, MESSAGE_TYPES }
} catch {
  kernelProtocol = null
}

const WORKER_DIR = path.resolve(__dirname, '..')

// Product photos, keyed by product — series AND cooling — because cooling is
// not a property of the series: every series ships an air and a water
// variant. Keying by series alone showed the air A2's photo for an A2 Pro
// Hydro and the hydro A4's for an A4 Pro Air, which is a misleading picture
// of the machine being inspected.
//
// Only these three products have been photographed. A product with no photo
// shows none: the caption carries the device's own `Model` string either way,
// and an illustrative photo of the wrong cooling type is worse than no photo.
//
// Served from a fixed map keyed by product, never by joining a request path
// onto a directory: that is how a dev server ends up serving /etc/passwd.
const MINER_PHOTOS = {
  'A2-air': 'a2.png',
  'A3-air': 'a3-air.png',
  'A4-hydro': 'a4-hydro.png'
}
const PHOTO_DIR = path.join(WORKER_DIR, 'assets', 'miners')

// --- test suites the page can run -------------------------------------------
//
// Every layer of the test pyramid, runnable from the page, so evaluating this
// worker does not require knowing which npm script proves what. None of them
// needs a SealMiner: the mock covers every layer including the Kernel chain.
//
// This is a strict allowlist. The page sends an id and nothing else — no
// command string, no arguments, no shell. Adding a suite means editing this
// array, which is the point: a dev console that can run what a caller names
// is a remote shell with a nicer font.
const SMOKE_HARNESS = 'packages/mdk-skill/src/skills/mdk-worker-plugin/scripts/worker-smoke.mjs'

// Resolve a dev dependency's executable from its own package.json rather than
// hardcoding a path inside node_modules — brittle's entry is bin/node.js and
// standard's is bin/cmd.cjs, and neither is ours to pin.
const binOf = (pkg, name = pkg) => {
  const manifest = path.join(WORKER_DIR, 'node_modules', pkg, 'package.json')
  const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const rel = typeof bin === 'string' ? bin : bin[name]
  return path.join(WORKER_DIR, 'node_modules', pkg, rel)
}

// Suites are spawned without a shell, so a glob would arrive at the runner
// literally. Expand it here; an explicit file list is also what makes the
// command shown on the page the command that actually ran.
const testFiles = (dir) => fs
  .readdirSync(path.join(WORKER_DIR, dir))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => `${dir}/${f}`)

const SUITES = [
  {
    id: 'lint',
    title: 'Lint',
    layer: 'static',
    seconds: 10,
    needsMdk: false,
    what: 'Code style, over every file.',
    proves: 'Enforced by a tool, so nobody argues about it in review.',
    cmd: process.execPath,
    args: [binOf('standard')]
  },
  {
    id: 'contract',
    title: 'Contract validation',
    layer: 'static',
    seconds: 5,
    needsMdk: false,
    what: 'Checks mdk-contract.json against MDK\'s own schema.',
    proves: 'The contract is all MDK ever sees of this worker. Every handler exists, every number has a min and max, every error code is real.',
    cmd: process.execPath,
    args: [path.join(WORKER_DIR, 'scripts/validate-contract.js')]
  },
  {
    id: 'unit',
    title: 'Unit',
    layer: 'no MDK, no hardware',
    seconds: 5,
    needsMdk: false,
    what: 'The parsing, caching and safety logic on its own.',
    proves: 'This is the code that decides what a reading means. Most of these tests exist because real hardware surprised us.',
    cmd: process.execPath,
    args: [binOf('brittle'), ...testFiles('tests/unit')],
    env: { NODE_ENV: 'test' }
  },
  {
    id: 'integration',
    title: 'Integration',
    layer: 'real runtime, mock miners',
    seconds: 110,
    needsMdk: true,
    what: 'A real MDK runtime hosting this package over mock miners.',
    proves: 'The plugin loads and answers the way MDK really calls it — not the way we imagine it does.',
    cmd: process.execPath,
    args: [binOf('brittle'), ...testFiles('tests/integration')],
    env: { NODE_ENV: 'test' }
  },
  {
    id: 'e2e',
    title: 'End-to-end through Kernel',
    layer: 'Kernel + HRPC + client SDK',
    seconds: 45,
    needsMdk: true,
    what: 'A real Kernel on the network, addressed the way a user would.',
    proves: 'Kernel throws out bad values before they can reach a miner. Nothing else here can show that.',
    cmd: process.execPath,
    args: [path.join(WORKER_DIR, 'tests/e2e/kernel-chain.js')]
  },
  {
    id: 'smoke',
    title: 'MDK\'s own smoke harness',
    layer: 'MDK\'s code, not ours',
    seconds: 30,
    needsMdk: true,
    what: 'MDK\'s own test harness, run against this package.',
    proves: 'The most independent check here: not a test we wrote, MDK checking us.',
    cmd: process.execPath,
    args: [path.join(MDK_REPO, SMOKE_HARNESS), '.'],
    env: { MDK_WORKER_BASE: path.join(MDK_REPO, 'backend/core/mdk-worker') }
  }
]

const SUITE_BY_ID = new Map(SUITES.map((s) => [s.id, s]))

/**
 * The command a suite runs, written the way someone would type it. Absolute
 * paths into node_modules are noise, and a thirteen-file argument list is
 * unreadable, so runner paths collapse to their tool name and long file
 * lists to a count — while staying truthful about what is being run.
 */
const describeCommand = ({ cmd, args, env }) => {
  const shorten = (arg) => {
    if (!path.isAbsolute(arg)) return arg
    if (arg.startsWith(path.join(WORKER_DIR, 'node_modules'))) {
      return path.relative(path.join(WORKER_DIR, 'node_modules'), arg).split(path.sep)[0]
    }
    if (arg.startsWith(WORKER_DIR)) return path.relative(WORKER_DIR, arg)
    if (arg.startsWith(MDK_REPO)) return `<mdk>/${path.relative(MDK_REPO, arg)}`
    return arg
  }

  const parts = args.map(shorten)
  const files = parts.filter((p) => p.endsWith('.test.js'))
  const shown = files.length > 2
    ? [...parts.filter((p) => !p.endsWith('.test.js')), `${path.dirname(files[0])}/*.test.js`]
    : parts

  const prefix = Object.entries(env || {}).map(([k, v]) => `${k}=${shorten(v)}`)
  const suffix = files.length > 2 ? `   # ${files.length} files` : ''
  // `node brittle …` is how it is spawned but not how anyone writes it; when
  // the first argument is a tool from node_modules, it is the command.
  const viaTool = args.length && args[0].startsWith(path.join(WORKER_DIR, 'node_modules'))
  const head = viaTool ? [] : [path.basename(cmd)]
  return [...prefix, ...head, ...shown].join(' ') + suffix
}
const mdkPresent = fs.existsSync(path.join(MDK_REPO, 'backend/core/mdk-worker'))

/**
 * Run one allowlisted suite, streaming its output as server-sent events.
 * Output is forwarded verbatim: a suite's own reporter is more informative
 * than anything this page could summarize.
 */
const streamSuite = (suite, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const started = Date.now()
  const child = spawn(suite.cmd, suite.args, {
    cwd: WORKER_DIR,
    env: { ...process.env, MDK_REPO, ...(suite.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let tail = ''
  const onChunk = (chunk) => {
    tail += chunk.toString('utf8')
    const lines = tail.split('\n')
    tail = lines.pop()
    for (const line of lines) send('line', line)
  }
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)

  const finish = (code, error) => {
    if (tail) send('line', tail)
    send('done', { code, error: error ?? null, ms: Date.now() - started })
    res.end()
  }
  child.on('error', (err) => finish(null, err.message))
  child.on('close', (code) => finish(code))
  res.on('close', () => child.kill())
}

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const PORT = Number(flag('port', 7070))

// Repeatable: --live 10.0.0.21 --live 10.0.0.22
// SEALMINER_LIVE=10.0.0.21,10.0.0.22 does the same without retyping the flag.
const LIVE = [
  ...argv.reduce((acc, arg, i) => (arg === '--live' ? [...acc, argv[i + 1]] : acc), []),
  ...String(process.env.SEALMINER_LIVE || '').split(',')
].map((value) => String(value || '').trim()).filter(Boolean)

// Every product, every time. Seven mocks: the three series, each in both its
// air-cooled and water-cooled form, plus one product twice on two firmware
// builds. Ordered by series so the fleet reads as a grid rather than a list.
//
//   A2             current fw   air     nothing is restricted
//   A2 Pro Hydro   current fw   water   same series, no fans at all
//   A3 Air         current fw   air     the series removes low_power
//   A3 Pro Hydro   current fw   water
//   A4 Pro Air     current fw   air     reports MHS(Rated) as 0
//   A4 Ultra Hydro 2025090101   water   this build has no sleep and no resume
//   A4 Ultra Hydro 20250620     water   the SAME product, an OLDER build
//
// The last two are the point of the whole fleet. The OLDER build HAS `resume`
// while the newer one does not, because resume was removed from 2025080401 to
// 2026053100 and restored in 2026060101. That is the case a `firmware >= X`
// table gets wrong, since such a table assumes features are only ever added —
// and it is why capability is asked of the device first. Both report
// capabilitySource: device.
//
// Each series appearing twice makes visible what a series-shaped fleet hid:
// cooling is not a property of the series. Every series ships both an air and
// a water product — one with fans and a target-relative thermal rule, one
// reporting `Liquid Cooling` with no fan keys at all.
//
// These seven used to be four, with the rest behind `--all`. A reviewer
// following the README got the short fleet, which was missing both halves of
// the firmware pair and the MHS(Rated)-reports-zero product — the three
// devices that demonstrate the most. The flag is still accepted and now does
// nothing, so any command or script that passes it keeps working.
//
// Every device here carries a real product's measured profile. A clipped
// stats reply used to be offered as a synthetic member and was dropped: no
// measured miner clips, and the handling is covered by tests — parser-stats,
// tcp-rpc, api-client, runtime-v2 and health's alert-coverage battery —
// rather than by asking a reviewer to trust a fabricated device.
// scripts/run-mock.js --truncate still reproduces it on demand.
const FLEET = [
  {
    deviceId: 'SM-A2-001',
    series: 'a2',
    cooling: 'air',
    firmware: '2026060901',
    label: 'A2 — air cooled, current firmware, nothing restricted'
  },
  {
    deviceId: 'SM-A2-006',
    series: 'a2',
    cooling: 'hydro',
    firmware: '2026060901',
    label: 'A2 Pro Hydro — the A2 series, water cooled: no fans, 840 chips on 2 boards'
  },
  {
    deviceId: 'SM-A3-002',
    series: 'a3',
    cooling: 'air',
    firmware: '2026060901',
    label: 'A3 Air — air cooled, and the series removes low_power'
  },
  {
    deviceId: 'SM-A3-007',
    series: 'a3',
    cooling: 'hydro',
    firmware: '2026060901',
    label: 'A3 Pro Hydro — water cooled, 792 chips on 2 boards'
  },
  {
    deviceId: 'SM-A4-008',
    series: 'a4',
    cooling: 'air',
    firmware: '2026060901',
    label: 'A4 Pro Air — the A4 series, air cooled: 4 fans, and MHS(Rated) reported as 0'
  },
  {
    deviceId: 'SM-A4-003',
    series: 'a4',
    cooling: 'hydro',
    firmware: '2025090101',
    label: 'A4 Ultra Hydro on firmware 2025090101 — water cooled; this build has no sleep mode and no resume'
  },
  {
    deviceId: 'SM-A4-004',
    series: 'a4',
    cooling: 'hydro',
    firmware: '20250620',
    label: 'A4 Ultra Hydro on firmware 20250620 — the SAME product, an OLDER build: it HAS resume, and lacks hostname/network/idle-fan-timer'
  }
]

// --- audit capture ---------------------------------------------------------

const audit = []
const originalInfo = console.info
console.info = (line) => {
  try {
    const event = JSON.parse(line)
    if (event.event === 'physical_command') {
      audit.unshift(event)
      if (audit.length > 300) audit.pop()
      return
    }
  } catch { /* not ours */ }
  originalInfo(line)
}

// --- boot ------------------------------------------------------------------

const mocks = new Map()
// deviceId -> { address, reachable, checkedAt, detail }
const live = new Map()

// A real miner can be missing at boot or disappear later. WorkerRuntimeV2's
// device list is fixed at construction, so the device stays registered and
// its reachability is tracked here instead: the page drops it from the
// selector while it is down and brings it back when it answers, with no
// restart. `version` is the cheapest read the API has.
const splitTarget = (target) => {
  const [host, port] = String(target).split(':')
  return { host, port: port ? Number(port) : 4028 }
}

const probe = async (target) => {
  const { TcpRpc } = require('../lib/tcp-rpc')
  const { host, port } = splitTarget(target)
  const rpc = new TcpRpc({ host, port, timeoutMs: 4000 })
  try {
    const { body } = await rpc.request({ command: 'version' })
    const v = body?.VERSION?.[0]
    return { reachable: true, detail: `bdminer ${v?.BDMiner ?? v?.Bdminer ?? '?'}, API ${v?.API ?? '?'}` }
  } catch (err) {
    return { reachable: false, detail: err.code || err.message }
  } finally {
    rpc.stop()
  }
}

const refreshReachability = async () => {
  await Promise.all([...live.entries()].map(async ([deviceId, entry]) => {
    const result = await probe(entry.address)
    const changed = entry.reachable !== result.reachable
    entry.reachable = result.reachable
    entry.detail = result.detail
    entry.checkedAt = Date.now()
    if (changed) {
      console.log(`  ${deviceId}: ${result.reachable ? 'reachable' : 'UNREACHABLE'} — ${result.detail}`)
    }
  }))
}

const main = async () => {
  const fleet = FLEET
  const specs = []

  for (const entry of fleet) {
    const mock = createMock({
      series: entry.series,
      cooling: entry.cooling,
      firmware: entry.firmware,
      // Leave chipCount to the product profile unless an entry pins it. It
      // used to default to 36, which overrode every measured count for no
      // benefit: the per-chip keys are what make a reply large, and those
      // stay off unless an entry asks for them.
      ...(entry.chipCount ? { chipCount: entry.chipCount, includeChips: true } : {}),
      truncateAt: entry.truncateAt ?? null
    })
    const address = await mock.ready
    mocks.set(entry.deviceId, { mock, entry })
    specs.push({
      deviceId: entry.deviceId,
      config: { address: '127.0.0.1', port: address.port, series: entry.series.toUpperCase() }
    })
  }

  for (const target of LIVE) {
    const { host, port } = splitTarget(target)
    const deviceId = `live-${target}`
    live.set(deviceId, { address: target, reachable: false, checkedAt: 0, detail: 'not probed yet' })
    specs.push({ deviceId, config: { address: host, port } })
  }
  await refreshReachability()

  const runtime = new WorkerRuntimeV2(WORKER_DIR, { workerId: 'sealminer-dev-console', devices: specs })
  await runtime.start()

  const envelope = (action, deviceId, payload) => {
    if (kernelProtocol) {
      return kernelProtocol.build({
        action,
        type: kernelProtocol.MESSAGE_TYPES.REQUEST,
        sender: 'sealminer-dev-console',
        target: 'sealminer-dev-console',
        deviceId,
        payload
      })
    }
    return {
      id: `console-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      version: '0.2.0',
      type: 'request',
      action,
      sender: 'sealminer-dev-console',
      target: 'sealminer-dev-console',
      deviceId,
      timestamp: Date.now(),
      payload
    }
  }

  const api = {
    async state () {
      return {
        workerId: 'sealminer-dev-console',
        devices: [
          ...[...mocks.entries()].map(([deviceId, { mock, entry }]) => ({
            deviceId,
            label: entry.label,
            live: false,
            reachable: true,
            series: entry.series.toUpperCase(),
            liquidCooling: mock.state.cfg.liquidCooling,
            firmware: entry.firmware,
            port: mock.port,
            faults: [...mock.state.faults],
            pmState: mock.state.pmState,
            miningMode: mock.state.miningMode
          })),
          ...[...live.entries()].map(([deviceId, entry]) => ({
            deviceId,
            label: `REAL HARDWARE — ${entry.address}`,
            live: true,
            reachable: entry.reachable,
            reachabilityDetail: entry.detail,
            checkedAt: entry.checkedAt,
            // Unknown until the metrics refresh reads the miner's own
            // firmware_info; the console must not guess either from the id.
            series: null,
            liquidCooling: null,
            firmware: null,
            port: splitTarget(entry.address).port,
            faults: []
          }))
        ]
      }
    },

    async contract () {
      const res = await runtime.handleRequest(envelope('capability.request', null, {}))
      return res.payload.contract
    },

    async metrics (query) {
      const res = await runtime.handleRequest(
        envelope('telemetry.pull', query.device, { query: { type: 'metrics' } })
      )
      return res.payload
    },

    // A single named channel. This is a different route through the runtime
    // than `metrics` — query.type selects one handler and the reply is
    // { name, value } rather than { metrics: {...} } — and it is the only
    // path that can carry per-channel parameters, such as history's limit.
    async read (body) {
      const started = Date.now()
      const res = await runtime.handleRequest(
        envelope('telemetry.pull', body.deviceId, {
          query: { type: body.channel, ...(body.params || {}) }
        })
      )
      return { ...res.payload, ms: Date.now() - started }
    },

    // Every declared read interface, one row each, checked two ways.
    //
    // The `metrics` fan-out and a named pull are different routes through the
    // runtime, so this reads both and reports each channel individually
    // rather than as one aggregate "29 checked, 0 wrong".
    //
    // What it asserts is deliberately narrow. Values legitimately differ
    // between two calls — the mock's hashrate jitters, `history` grows by a
    // row, `snap.ts` moves — so this compares the declared type and the
    // observed shape, and flags a channel only when one route errors and the
    // other does not, or when the shape disagrees. Claiming value equality
    // here would produce a red row on a healthy miner.
    async channels (query) {
      const shapeOf = (v) => {
        if (v === null || v === undefined) return 'null'
        if (Array.isArray(v)) return 'array'
        return typeof v
      }
      const matches = { number: 'number', string: 'string', boolean: 'boolean', array: 'array', object: 'object' }

      const contract = (await runtime.handleRequest(envelope('capability.request', null, {}))).payload.contract
      const fanout = (await runtime.handleRequest(
        envelope('telemetry.pull', query.device, { query: { type: 'metrics' } })
      )).payload.metrics || {}

      const rows = []
      for (const entry of contract.capabilities.telemetry) {
        const started = Date.now()
        const res = await runtime.handleRequest(
          envelope('telemetry.pull', query.device, { query: { type: entry.name } })
        )
        const ms = Date.now() - started
        const named = res.payload

        const fanoutValue = fanout[entry.name]
        const fanoutErr = fanoutValue && typeof fanoutValue === 'object' && fanoutValue.error
          ? fanoutValue.error
          : null
        const namedErr = named.error ?? null

        const shape = shapeOf(named.value)
        // `null` is a legitimate answer everywhere: it is how this worker
        // reports a field the firmware did not send, and never a 0 stand-in.
        const typeOk = namedErr ? null : shape === 'null' || shape === matches[entry.type]
        const routesAgree = Boolean(namedErr) === Boolean(fanoutErr) &&
          (namedErr ? true : shape === shapeOf(fanoutErr ? undefined : fanoutValue) || shape === 'null')

        rows.push({
          name: entry.name,
          declaredType: entry.type,
          unit: entry.unit || '',
          description: entry.description,
          value: named.value ?? null,
          shape,
          ms,
          namedError: namedErr,
          fanoutError: fanoutErr,
          typeOk,
          routesAgree,
          ok: !namedErr && typeOk !== false && routesAgree
        })
      }

      return {
        deviceId: query.device,
        total: rows.length,
        passed: rows.filter((r) => r.ok).length,
        errored: rows.filter((r) => r.namedError).length,
        // Counted separately because a null is a pass, not a fault — but it
        // is the difference between "the miner told us" and "it did not", and
        // a table that renders it like any other value hides that.
        nulls: rows.filter((r) => !r.namedError && r.value === null).length,
        rows
      }
    },

    async command (body) {
      const res = await runtime.handleRequest(
        envelope('command.request', body.deviceId, { command: body.command, params: body.params || {} })
      )
      return res.payload
    },

    async fault (body) {
      if (live.has(body.deviceId)) throw new Error('fault injection is mock-only')
      const target = mocks.get(body.deviceId)
      if (!target) throw new Error('unknown device')
      target.mock.setFault(body.fault, Boolean(body.on))
      return { faults: [...target.mock.state.faults] }
    },

    async audit () {
      return { events: audit.slice(0, 120) }
    }

  }

  const FAULTS = [
    'fan_stopped', 'psu_error', 'psu_overheat', 'board_offline',
    'board_low_hash', 'bad_chip', 'overheat', 'device_error', 'stratum_disconnect',
    'powerlimit_noop', 'fastraisefreq_noop'
  ]

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE
          .replace('__FAULTS__', JSON.stringify(FAULTS))
          .replace('__PHOTOS__', JSON.stringify(Object.keys(MINER_PHOTOS))))
        return
      }
      if (url.pathname === '/api/state') return json(200, await api.state())
      if (url.pathname === '/api/contract') return json(200, await api.contract())
      if (url.pathname === '/api/metrics') {
        return json(200, await api.metrics({ device: url.searchParams.get('device') }))
      }
      if (url.pathname === '/api/audit') return json(200, await api.audit())
      if (url.pathname === '/api/channels') {
        return json(200, await api.channels({ device: url.searchParams.get('device') }))
      }

      if (url.pathname.startsWith('/photo/')) {
        const file = MINER_PHOTOS[url.pathname.slice('/photo/'.length)]
        if (!file) return json(404, { error: 'no photo for that product' })
        const body = fs.readFileSync(path.join(PHOTO_DIR, file))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' })
        return res.end(body)
      }

      if (url.pathname === '/api/suites') {
        return json(200, {
          mdkPresent,
          mdkRepo: MDK_REPO,
          suites: SUITES.map((suite) => {
            const { cmd, args, env, ...meta } = suite
            return { ...meta, command: describeCommand(suite) }
          })
        })
      }

      if (url.pathname === '/api/suites/run') {
        const suite = SUITE_BY_ID.get(url.searchParams.get('id'))
        if (!suite) return json(404, { error: 'no such suite' })
        if (suite.needsMdk && !mdkPresent) {
          return json(409, { error: `this suite needs an MDK checkout; none found at ${MDK_REPO}` })
        }
        return streamSuite(suite, res)
      }

      const POSTS = { '/api/command': api.command, '/api/fault': api.fault, '/api/read': api.read }
      if (req.method === 'POST' && POSTS[url.pathname]) {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        return json(200, await POSTS[url.pathname](body))
      }

      json(404, { error: 'not found' })
    } catch (err) {
      json(500, { error: String(err.message || err) })
    }
  })

  // A port clash is the most likely first-run failure, and an unhandled
  // 'error' event would answer it with a Node stack trace. Say what is wrong
  // and how to get past it instead.
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('')
      console.error(`  Port ${PORT} is already in use — most likely another dev console.`)
      console.error('')
      console.error(`    lsof -nP -iTCP:${PORT} -sTCP:LISTEN     # see what has it`)
      console.error('    pkill -f dev-console.js                 # stop a stray console')
      console.error(`    node scripts/dev-console.js --port ${PORT + 1}   # or just use another port`)
      console.error('')
    } else {
      console.error(`  Could not listen on ${PORT}: ${err.code || err.message}`)
    }
    for (const { mock } of mocks.values()) mock.close()
    await runtime.stop()
    process.exit(1)
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log('')
    console.log(`  SealMiner worker dev console   http://127.0.0.1:${PORT}`)
    console.log('')
    for (const [deviceId, { mock, entry }] of mocks) {
      console.log(`  ${deviceId.padEnd(14)} ${entry.label.padEnd(30)} mock on 127.0.0.1:${mock.port}`)
    }
    for (const [deviceId, entry] of live) {
      const status = entry.reachable ? 'REAL HARDWARE' : 'REAL HARDWARE (unreachable)'
      console.log(`  ${deviceId.padEnd(22)} ${status.padEnd(30)} ${entry.address} — ${entry.detail}`)
    }
    if (live.size) {
      console.log('')
      console.log('  Live devices are re-probed every 15s; the page adds and drops them as they come and go.')
    }
    console.log('')
    console.log(kernelProtocol
      ? '  Real WorkerRuntimeV2, envelopes built by Kernel\'s own protocol module.'
      : '  Real WorkerRuntimeV2, hand-built envelopes (install backend/core/kernel to use Kernel\'s).')
    console.log('  Kernel itself, HRPC and the Gateway are not in the loop: this console')
    console.log('  calls handleRequest directly, which is what Kernel would do.')
    console.log('  Ctrl-C to stop.')
    console.log('')
  })

  // Re-probe in the background so a miner that comes back reappears, and one
  // that dies drops out, without restarting the console.
  const probeTimer = live.size ? setInterval(() => { refreshReachability() }, 15000) : null
  if (probeTimer) probeTimer.unref()

  const shutdown = async () => {
    if (probeTimer) clearInterval(probeTimer)
    server.close()
    await runtime.stop()
    for (const { mock } of mocks.values()) mock.close()
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown)
}

// --- page ------------------------------------------------------------------

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SealMiner Worker Console</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #fff; --line: #e2e5ea; --ink: #14161a;
    --muted: #6b7280; --accent: #b4530a; --ok: #157347; --warn: #9a6700;
    --alert: #b02a37; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14161a; --panel: #1b1e24; --line: #2c3139; --ink: #e8eaed;
      --muted: #9aa1ab; --accent: #f7931a; --ok: #4ade80; --warn: #fbbf24;
      --alert: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  h1 { font-size: 15px; margin: 0; font-weight: 650; }
  h1 span { color: var(--accent); }
  select { max-width: 360px; min-width: 0; }
  select, button, input, textarea { font: inherit; color: var(--ink);
    background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .wrap > div { min-width: 0; }
  .wrap { display: grid; grid-template-columns: minmax(0,1.5fr) minmax(0,1fr); gap: 16px; padding: 16px; }
  @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px; margin-bottom: 16px; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 0 0 10px; font-weight: 650; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap: 10px; }
  .tile { border: 1px solid var(--line); border-radius: 8px; padding: 10px; min-width: 0; }
  /* Values are not all numbers: tune_status reads fine_tuning_done and
     power_mode reads high_performance, which overflow a tile at the size the
     numbers want. Wrap rather than clip, and step the size down by length so
     a long token stays on one or two lines instead of escaping the box. */
  .tile b { display: block; font-size: 21px; font-weight: 650; font-variant-numeric: tabular-nums;
    line-height: 1.15; overflow-wrap: anywhere; }
  .tile b.long { font-size: 15px; }
  .tile b.longer { font-size: 13px; }
  .tile small { display: block; color: var(--muted); font-size: 11px; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
  td.v { font-family: var(--mono); font-size: 12px; word-break: break-word; }
  td.code { font-family: var(--mono); font-size: 12px; white-space: nowrap; }
  .null { color: var(--muted); font-style: italic; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 11px;
    font-weight: 650; border: 1px solid currentColor; }
  .b-ok { color: var(--ok); } .b-warn { color: var(--warn); } .b-alert { color: var(--alert); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 99px; border: 1px solid var(--line);
    cursor: pointer; user-select: none; }
  .chip.on { background: var(--alert); border-color: var(--alert); color: #fff; }
  .cmd { border: 1px solid var(--line); border-radius: 8px; padding: 9px; margin-bottom: 8px; }
  .cmd summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  .cmd .fields { display: grid; gap: 6px; margin: 8px 0; }
  .cmd label { font-size: 11px; color: var(--muted); display: block; }
  .cmd label span { color: var(--alert); }
  .cmd .hint { font-size: 11px; color: var(--muted); margin: 4px 0 8px; }
  .unsupported { opacity: .55; }
  .log { font-family: var(--mono); font-size: 11px; max-height: 260px; overflow: auto; }
  .log div { padding: 2px 0; border-bottom: 1px solid var(--line); }
  .out { font-family: var(--mono); font-size: 11px; white-space: pre-wrap; margin-top: 6px; }
  .pass { color: var(--ok); } .fail { color: var(--alert); }
  .dim { color: var(--muted); font-size: 11px; }
  .live { padding: 16px 16px 0; }
  .rig { display: flex; align-items: center; gap: 8px; }
  .rig img { width: 54px; height: 40px; object-fit: contain; border: 1px solid var(--line);
    border-radius: 6px; background: #fff; padding: 2px; flex: none; }
  .rig b { font-size: 13px; font-weight: 650; white-space: nowrap; }
  .live > details { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .live > details > summary { cursor: pointer; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .live > details > summary b { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .live .peek { font-family: var(--mono); font-size: 12px; margin-left: auto; }
  .live .peek span { margin-left: 12px; }
  .live .tiles { margin-top: 12px; }
  .suite { border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  .suite.running { border-color: var(--accent); }
  .suite.pass { border-left: 3px solid var(--ok); }
  .suite.fail { border-left: 3px solid var(--alert); }
  .suite .top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .suite .top b { font-size: 13px; font-weight: 650; }
  .suite .st { margin-left: auto; font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .suite .what { font-size: 12px; margin: 5px 0 0; }
  .suite .proves { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
  .suite .ran { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-top: 5px;
    overflow-wrap: anywhere; }
  .suite pre { font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-word;
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
    max-height: 300px; overflow: auto; padding: 8px; margin: 8px 0 0; }
  .suite .bar { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
  details.api { border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  details.api > summary { cursor: pointer; font-size: 13px; }
  details.api > summary .st { float: right; font-weight: 650; }
  details.api > .hint { font-size: 12px; color: var(--muted); margin: 8px 0; }
  details.api > .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .rd { border: 1px solid var(--line); border-radius: 8px; padding: 9px; margin-bottom: 8px; }
  .rd summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  .rd summary .t { color: var(--muted); font-weight: 400; font-family: var(--mono); font-size: 11px; }
  .rd .desc { font-size: 12px; color: var(--muted); margin: 8px 0; }
  .rd .bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .rd input { flex: 1; min-width: 150px; }
</style>
</head>
<body>
<header>
  <h1><span>SealMiner</span> Worker Console</h1>
  <select id="device"></select>
  <span id="devmeta" class="dim"></span>
  <label class="dim"><input type="checkbox" id="auto" checked> auto-refresh 2s</label>
  <button id="refresh">Refresh</button>
  <span class="rig"><img id="rig-photo" alt="" hidden><b id="rig-model"></b></span>
  <span class="chips" id="dropped"></span>
</header>

<div class="live">
  <details id="live-panel">
    <summary><b>Live readings</b>
      <span class="dim" id="chancount"></span>
      <span class="peek" id="live-peek"></span></summary>
    <div class="tiles" id="tiles"></div>
    <p class="dim" style="margin:12px 0 6px">
      One <code>metrics</code> pull, refreshed every 2s — the watch view. To call an interface and see its raw
      reply, use <b>The API surface</b>.
    </p>
    <table><thead><tr><th>Channel</th><th>Value</th></tr></thead><tbody id="channels"></tbody></table>
  </details>
</div>

<div class="wrap">
  <div>
    <div class="panel">
      <h2>Test suites <span class="dim">every layer, no hardware required</span></h2>
      <p class="dim" style="margin:0 0 10px">
        Every layer, runnable from here. No miner needed — the bundled mock covers all of it, Kernel included.
      </p>
      <div class="bar" style="display:flex;gap:6px;align-items:center;margin-bottom:10px">
        <button class="primary" id="run-all">Run all</button>
        <button id="stop-all">Stop</button>
        <span class="dim" id="suites-note"></span>
      </div>
      <div id="suites"></div>
    </div>
  </div>

  <div>
    <div class="panel">
      <h2>Health</h2>
      <div id="health"></div>
    </div>
    <div class="panel">
      <h2>Inject a fault on the mock</h2>
      <div class="chips" id="faults"></div>
      <p class="dim" style="margin:8px 0 0">Toggles change the mock miner, then watch Health and the errors channel react.</p>
    </div>
    <div class="panel">
      <h2>The API surface <span class="dim">everything this worker exposes, and a way to call it</span></h2>
      <p class="dim" style="margin:0 0 10px">
        Built from <code>mdk-contract.json</code>, so this is exactly what MDK publishes to a user.
      </p>

      <details class="api" id="api-read">
        <summary><b>Read interfaces</b> <span class="dim" id="read-count"></span>
          <span class="st dim" id="st-channels"></span></summary>
        <p class="hint">
          Everything this worker can report. Open one to read it now; <code>history</code> takes a
          <code>limit</code>.
        </p>
        <div class="bar"><button id="btn-channels">Check all</button>
          <span class="dim">reads every channel and checks it against the contract</span></div>
        <div id="channels-out"></div>
        <div id="reads"></div>
      </details>

      <details class="api" id="api-write">
        <summary><b>Write interfaces</b> <span class="dim" id="write-count"></span></summary>
        <p class="hint">
          Everything this worker can change on a miner. Each form is built from the contract, so a bad value is
          refused before it is sent.
        </p>
        <div id="commands"></div>
      </details>
    </div>
    <div class="panel">
      <h2>Audit events <span class="dim">from the command guard</span></h2>
      <div class="log" id="audit"></div>
    </div>
  </div>
</div>

<script>
const FAULTS = __FAULTS__
// Products that have a photo. Anything else shows no image rather than one
// of the wrong cooling type.
const PHOTO_KEYS = __PHOTOS__
const $ = (id) => document.getElementById(id)
let contract = null
let caps = null
let current = null
let currentIsLive = false

const get = (p) => fetch(p).then((r) => r.json())
const post = (p, body) => fetch(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
}).then((r) => r.json())

// snap and the other object channels are large; showing them in full makes
// the page taller than the screen. Collapse anything long behind a summary.
const LONG = 200
const fmt = (v) => {
  if (v === null || v === undefined) return '<span class="null">null</span>'
  if (typeof v !== 'object') return escapeHtml(String(v))
  const text = JSON.stringify(v, null, 1)
  if (text.length <= LONG) return escapeHtml(JSON.stringify(v))
  return '<details><summary class="dim">' + escapeHtml(JSON.stringify(v).slice(0, LONG)) +
    '… <b>' + text.length + ' chars</b></summary><pre class="out">' + escapeHtml(text) + '</pre></details>'
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const TILES = [
  ['hashrate_rt', 'TH/s', 'hashrate'],
  ['power', 'W', 'power'],
  ['temperature', 'C', 'temp'],
  ['efficiency', 'W/TH', 'efficiency'],
  ['hashrate_pr', '%', 'perf ratio'],
  ['fan_speed', 'RPM', 'fan max'],
  ['power_mode', '', 'mode'],
  ['status', '', 'state'],
  ['tune_status', '', 'tuning']
]

// Shorter wording for the tiles only.
//
// The contract's tokens are deliberately verbose — fine_tuning_done,
// high_performance, coarse_tuning_done — and at the size the numbers want,
// sixteen characters will not fit a tile. Abbreviating the DISPLAY keeps
// every everyday value at one font size; the token itself is untouched,
// stays in the channel table below, and is on the tile's hover title, so
// nothing a consumer depends on is hidden.
//
// Each tile already carries its own label, so the redundant half of the
// token is what goes: under "mode", high_performance only has to say "high".
const TILE_WORDING = {
  power_mode: {
    low_power: 'low',
    high_performance: 'high',
    ultra_low_power: 'ultra low',
    smartboost: 'boost'
  },
  status: {
    initializing: 'starting',
    resume_failed: 'resume fail',
    suspend_failed: 'suspend fail'
  },
  tune_status: {
    tuning_idle: 'idle',
    coarse_tuning: 'coarse',
    coarse_tuning_done: 'coarse done',
    fine_tuning: 'fine',
    fine_tuning_done: 'done'
  }
}

// The photo is chosen by series; the caption is the device's own Model
// string, so an A4 that is not a Hydro still reads correctly even though the
// only A4 photo to hand is the Hydro one.
//
// /api/state reports series: null for live devices — the console cannot know
// it without asking the miner — so this is driven by the capabilities channel
// that the 2s metrics refresh already carries. No extra device I/O, and real
// hardware gets its real model name rather than a guess from the device id.
function showRig (opts) {
  const img = $('rig-photo')
  const series = opts.series ? String(opts.series).toUpperCase() : null
  // The device's own flag decides, not our configuration: liquidCooling comes
  // from firmware_info, so a real miner is classified by what it reports.
  // null means the firmware did not say, and an unknown cooling type must not
  // pick a photo by guessing.
  const cooling = opts.liquidCooling === true
    ? 'hydro'
    : opts.liquidCooling === false ? 'air' : null
  const key = series && cooling ? series + '-' + cooling : null
  if (key && PHOTO_KEYS.includes(key)) {
    img.src = '/photo/' + key
    img.hidden = false
    img.alt = opts.model || 'SealMiner ' + series
  } else {
    img.hidden = true
  }
  // Only the model name here: devmeta beside it already reports whether this
  // is real hardware, its address, and the firmware.
  $('rig-model').textContent = opts.model || (series ? 'SealMiner ' + series : '')
}

async function loadDevices () {
  const state = await get('/api/state')

  // An unreachable real miner is dropped from the selector rather than left
  // in it to produce a wall of channel errors. It reappears on its own when
  // the next probe succeeds.
  const usable = state.devices.filter((d) => d.reachable !== false)
  const dropped = state.devices.filter((d) => d.reachable === false)

  // A live device's id is 'live-<address>' and its label repeats the address,
  // so the option text used to carry it twice and made the select wide enough
  // to push the rest of the header onto a second row.
  $('device').innerHTML = usable
    .map((d) => '<option value="' + d.deviceId + '">' +
      escapeHtml(d.live ? d.deviceId.replace(/^live-/, '') + ' — real hardware' : d.deviceId + ' — ' + d.label) +
      '</option>').join('')

  if (!usable.some((d) => d.deviceId === current)) current = usable[0]?.deviceId
  $('device').value = current

  $('dropped').innerHTML = dropped.length
    ? dropped.map((d) => '<span class="chip" style="cursor:default">' + escapeHtml(d.deviceId) +
        ' unreachable · ' + escapeHtml(d.reachabilityDetail || '') + '</span>').join('')
    : ''
  const d = usable.find((x) => x.deviceId === current)
  if (d) {
    $('devmeta').textContent = d.live
      ? 'real hardware · ' + d.deviceId.replace(/^live-/, '')
      : 'series ' + d.series + ' · firmware ' + d.firmware + ' · mock :' + d.port
    $('devmeta').style.color = d.live ? 'var(--accent)' : ''
    currentIsLive = Boolean(d.live)
    showRig({
      series: d.series,
      // From /api/state for a mock, which knows its own product; null for a
      // real miner until the metrics refresh reads its firmware_info.
      liquidCooling: d.liquidCooling,
      live: d.live,
      deviceId: d.deviceId,
      firmware: d.firmware
    })
  }
  renderFaults(d ? d.faults : [], d ? d.live : false)
}

function renderFaults (active, isLive) {
  if (isLive) {
    $('faults').innerHTML =
      '<span class="dim">fault injection is mock-only — this is a real miner</span>'
    return
  }
  $('faults').innerHTML = FAULTS.map((f) =>
    '<span class="chip' + (active.includes(f) ? ' on' : '') + '" data-f="' + f + '">' + f + '</span>').join('')
  for (const chip of $('faults').querySelectorAll('.chip')) {
    chip.onclick = async () => {
      const on = !chip.classList.contains('on')
      await post('/api/fault', { deviceId: current, fault: chip.dataset.f, on })
      chip.classList.toggle('on', on)
      refresh()
    }
  }
}

function renderHealth (m) {
  const h = m.health
  if (!h) { $('health').innerHTML = '<span class="null">unavailable</span>'; return }
  const cls = h.status === 'OK' ? 'b-ok' : h.status === 'OFFLINE' ? 'b-alert' : 'b-alert'
  const rows = (h.details || []).map((d) =>
    '<tr><td><span class="badge b-' + (d.severity === 'alert' ? 'alert' : d.severity === 'warn' ? 'warn' : 'ok') +
    '">' + d.severity + '</span></td><td class="code">' + escapeHtml(d.code) + '</td><td>' + escapeHtml(d.detail || '') + '</td></tr>').join('')
  $('health').innerHTML =
    '<p><span class="badge ' + cls + '">' + h.status + '</span> ' +
    (h.alerts && h.alerts.length ? h.alerts.length + ' alert(s)' : '<span class="dim">no alerts</span>') + '</p>' +
    (rows ? '<table>' + rows + '</table>' : '')
}

function inputFor (cmd, p) {
  const id = 'p-' + cmd + '-' + p.name
  const req = p.required ? ' <span>*</span>' : ''
  let field
  if (p.enum) {
    const allowed = (cmd === 'setPowerMode' && caps && caps.powerModes) ? caps.powerModes : p.enum
    field = '<select id="' + id + '">' + allowed.map((v) => '<option>' + v + '</option>').join('') + '</select>'
  } else if (p.type === 'number') {
    const mid = p.min !== undefined && p.max !== undefined ? Math.round((p.min + p.max) / 2) : 0
    field = '<input id="' + id + '" type="number" value="' + mid + '" min="' + p.min + '" max="' + p.max + '">'
  } else if (p.type === 'boolean') {
    field = '<select id="' + id + '"><option value="false">false</option><option value="true">true</option></select>'
  } else if (p.type === 'object') {
    const sample = p.name === 'pools'
      ? '{"pools":[{"url":"stratum+tcp://pool.example.com:3333","user":"sealminer.001","pass":"x"}]}'
      : '{"network":{"dhcp":"1"}}'
    field = '<textarea id="' + id + '" rows="3">' + escapeHtml(sample) + '</textarea>'
  } else {
    const v = p.name === 'tz' ? 'Asia/Singapore' : p.name === 'hostname' ? 'sealminer-001' : ''
    field = '<input id="' + id + '" value="' + v + '">'
  }
  const bounds = p.min !== undefined ? ' <span class="dim">[' + p.min + ', ' + p.max + ']</span>' : ''
  return '<label>' + p.name + ' <span class="dim">' + p.type + '</span>' + req + bounds + '</label>' + field
}

function readParams (cmd, params) {
  const out = {}
  for (const p of params) {
    const el = $('p-' + cmd + '-' + p.name)
    if (!el) continue
    const raw = el.value
    if (raw === '') continue
    if (p.type === 'number') out[p.name] = Number(raw)
    else if (p.type === 'boolean') out[p.name] = raw === 'true'
    else if (p.type === 'object') Object.assign(out, JSON.parse(raw))
    else out[p.name] = raw
  }
  return out
}

let commandsBuilt = false

// Built once. The refresh loop only updates the gating badge and the note,
// in place: rebuilding the panel every 2s would close whatever the operator
// had open and wipe half-typed parameters.
function renderCommands () {
  if (!contract) return
  if (commandsBuilt) return updateGating()

  $('commands').innerHTML = contract.capabilities.commands.map((c) =>
    '<details class="cmd" data-block="' + c.name + '"><summary>' + c.name +
      '<span data-gate="' + c.name + '"></span></summary>' +
      '<p class="hint" data-note="' + c.name + '"></p>' +
      '<div class="fields">' + (c.params || []).map((p) => inputFor(c.name, p)).join('') + '</div>' +
      '<button class="primary" data-cmd="' + c.name + '">Send</button>' +
      '<div class="out" id="out-' + c.name + '"></div></details>').join('')

  for (const btn of $('commands').querySelectorAll('button[data-cmd]')) {
    btn.onclick = async () => {
      const name = btn.dataset.cmd
      const def = contract.capabilities.commands.find((c) => c.name === name)
      const out = $('out-' + name)
      out.textContent = 'sending…'
      try {
        const params = readParams(name, def.params || [])
        const res = await post('/api/command', { deviceId: current, command: name, params })
        out.textContent = (res.status === 'SUCCESS' ? '✓ ' : '✗ ') + JSON.stringify(res, null, 1)
        out.style.color = res.status === 'SUCCESS' ? 'var(--ok)' : 'var(--alert)'
      } catch (err) {
        out.textContent = '✗ ' + err.message
        out.style.color = 'var(--alert)'
      }
      refresh()
      loadAudit()
    }
  }

  commandsBuilt = true
  updateGating()
}

function updateGating () {
  if (!contract) return
  for (const c of contract.capabilities.commands) {
    const cap = caps && caps.commands ? caps.commands[c.name] : null
    const blocked = Boolean(cap && cap.supported === false)
    const block = document.querySelector('[data-block="' + c.name + '"]')
    const gate = document.querySelector('[data-gate="' + c.name + '"]')
    const note = document.querySelector('[data-note="' + c.name + '"]')
    if (!block) continue

    block.classList.toggle('unsupported', blocked)
    gate.innerHTML = blocked ? ' <span class="badge b-alert">gated</span>' : ''
    if (blocked) {
      note.style.color = 'var(--alert)'
      note.innerHTML = 'unsupported on this device: ' + escapeHtml(cap.reason || '') +
        (cap.fallback ? ' — use <b>' + escapeHtml(cap.fallback) + '</b>' : '')
    } else {
      note.style.color = ''
      note.textContent = c.constraints || c.description || ''
    }
  }

  // setPowerMode's accepted values depend on series and firmware; keep the
  // select in step without disturbing a valid selection.
  const select = $('p-setPowerMode-mode')
  if (select && caps && caps.powerModes) {
    const wanted = caps.powerModes.join(',')
    if (select.dataset.modes !== wanted) {
      const previous = select.value
      select.innerHTML = caps.powerModes.map((v) => '<option>' + v + '</option>').join('')
      if (caps.powerModes.includes(previous)) select.value = previous
      select.dataset.modes = wanted
    }
  }
}

async function loadAudit () {
  const { events } = await get('/api/audit')
  $('audit').innerHTML = events.length
    ? events.map((e) => {
        const color = e.outcome === 'succeeded' ? 'var(--ok)'
          : e.outcome === 'rejected' || e.outcome === 'failed' ? 'var(--alert)' : 'var(--muted)'
        return '<div><span style="color:' + color + '">' + e.outcome.padEnd(10) + '</span> ' +
          escapeHtml(e.command) + ' <span class="dim">' + escapeHtml(e.deviceId) + ' ' + e.class +
          (e.errorCode ? ' ' + e.errorCode : '') + (e.remainingMs ? ' ' + e.remainingMs + 'ms' : '') + '</span></div>'
      }).join('')
    : '<span class="dim">no commands issued yet</span>'
}

async function refresh () {
  if (!current) return
  const payload = await get('/api/metrics?device=' + encodeURIComponent(current))
  const m = payload.metrics || {}
  caps = m.capabilities || null

  if (caps) {
    showRig({
      series: caps.series,
      model: caps.model,
      firmware: caps.firmware,
      liquidCooling: m.firmware_info ? m.firmware_info.liquidCooling : null,
      live: currentIsLive,
      deviceId: current
    })
  }

  $('tiles').innerHTML = TILES.map(([k, unit, label]) => {
    const v = m[k]
    const missing = v === null || v === undefined
    const broken = !missing && typeof v === 'object'
    const token = missing ? '—' : broken ? 'err' : String(v)
    const text = (TILE_WORDING[k] && TILE_WORDING[k][token]) || token
    const shown = missing || broken ? '<span class="null">' + text + '</span>' : escapeHtml(text)
    // Every token the contract declares now fits at the full size — measured,
    // not counted: 'suspend fail' is twelve characters and 117px, while
    // '9999999.99' is ten and 127px, because tabular digits are wide. So the
    // step-down is only a fallback for a string the firmware invented and the
    // parser passed through, and anything longer still wraps rather than
    // escaping the tile.
    const size = text.length > 22 ? ' class="longer"' : text.length > 14 ? ' class="long"' : ''
    const full = text === token ? '' : ' title="' + escapeHtml(token) + '"'
    return '<div class="tile"' + full + '><b' + size + '>' + shown + '</b><small>' +
      label + (unit ? ' · ' + unit : '') + '</small></div>'
  }).join('')

  const names = contract ? contract.capabilities.telemetry.map((t) => t.name) : Object.keys(m)
  $('chancount').textContent = names.length + ' channels'

  // Collapsed, the bar still has to be worth glancing at, so the numbers an
  // operator actually watches go in the summary line. An absent reading
  // shows as a dash rather than being skipped: that is information too.
  const peek = (label, key, unit) => {
    const v = m[key]
    const shown = v === null || v === undefined || typeof v === 'object' ? '—' : v
    return '<span>' + shown + (unit ? ' ' + unit : '') + ' <span class="dim">' + label + '</span></span>'
  }
  const health = m.health && m.health.status ? m.health.status : '—'
  const healthColor = health === 'OK' ? 'var(--ok)' : health === '—' ? 'var(--muted)' : 'var(--alert)'
  $('live-peek').innerHTML =
    peek('TH/s', 'hashrate_rt') + peek('W', 'power') + peek('C', 'temperature') +
    '<span style="color:' + healthColor + ';font-weight:650">' + health + '</span>'

  $('channels').innerHTML = names.map((n) => {
    const v = m[n]
    const errored = v && typeof v === 'object' && v.error
    return '<tr><td>' + n + (errored ? ' <span class="badge b-alert">error</span>' : '') +
      '</td><td class="v">' + fmt(v) + '</td></tr>'
  }).join('')

  renderHealth(m)
  renderReads()
  renderCommands()
}


// --- read interfaces, one expandable tester each ---------------------------

let readsBuilt = false

// Channels that accept a query parameter. The contract declares params for
// commands but not for channels, so this is the one place the page needs to
// know something the contract does not say. Keep it in step with the
// handlers under src/telemetry/.
const CHANNEL_PARAMS = { history: '{"limit": 5}' }

function renderReads () {
  if (!contract || readsBuilt) return
  const channels = contract.capabilities.telemetry
  $('read-count').textContent = '· ' + channels.length + ' channels'
  $('write-count').textContent = '· ' + contract.capabilities.commands.length + ' commands'

  $('reads').innerHTML = channels.map((t) =>
    '<details class="rd" data-chan="' + t.name + '"><summary>' + t.name +
      ' <span class="t">' + t.type + (t.unit ? ' · ' + escapeHtml(t.unit) : '') + '</span>' +
      '<span data-mark="' + t.name + '"></span></summary>' +
      '<p class="desc">' + escapeHtml(t.description) + '</p>' +
      '<div class="bar">' +
        (CHANNEL_PARAMS[t.name]
          ? '<input data-p="' + t.name + '" placeholder="params, e.g. ' +
            escapeHtml(CHANNEL_PARAMS[t.name]) + '">'
          : '') +
        '<button class="primary" data-read="' + t.name + '">Read</button></div>' +
      '<div class="out" id="rout-' + t.name + '"></div></details>').join('')

  for (const btn of $('reads').querySelectorAll('button[data-read]')) {
    btn.onclick = () => readChannel(btn.dataset.read)
  }
  readsBuilt = true
}

async function readChannel (channel) {
  const out = $('rout-' + channel)
  const input = document.querySelector('[data-p="' + channel + '"]')
  const raw = input ? input.value.trim() : ''

  let params = {}
  if (raw) {
    try {
      params = JSON.parse(raw)
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        throw new Error('params must be a JSON object')
      }
    } catch (err) {
      out.textContent = '✗ ' + err.message
      out.style.color = 'var(--alert)'
      return
    }
  }

  out.textContent = 'reading…'
  out.style.color = ''
  try {
    const res = await post('/api/read', { deviceId: current, channel, params })
    // A handler error arrives as { error } inside the payload rather than as
    // an HTTP failure — that isolation is the runtime's behaviour, so it
    // shows as this channel's own result.
    const failed = res.error !== undefined && res.error !== null
    out.textContent = (failed ? '✗ ' : '✓ ') + res.ms + 'ms\\n' + JSON.stringify(res, null, 1)
    out.style.color = failed ? 'var(--alert)' : 'var(--ok)'
  } catch (err) {
    out.textContent = '✗ ' + err.message
    out.style.color = 'var(--alert)'
  }
}

// --- the read interfaces, as a checked table -------------------------------

// Pulls every channel by name and marks each row in place, so the check and
// the per-channel tester are the same list rather than two views of it.
async function checkChannels () {
  const btn = $('btn-channels')
  const st = $('st-channels')
  const out = $('channels-out')

  btn.disabled = true
  st.textContent = 'reading…'
  st.style.color = 'var(--accent)'
  out.innerHTML = '<p class="dim">pulling every channel by name…</p>'

  try {
    const res = await get('/api/channels?device=' + encodeURIComponent(current))
    const all = res.passed === res.total
    st.textContent = res.passed + ' / ' + res.total + ' ok' + (res.nulls ? ' · ' + res.nulls + ' null' : '')
    st.style.color = all ? 'var(--ok)' : 'var(--alert)'

    for (const r of res.rows) {
      const mark = document.querySelector('[data-mark="' + r.name + '"]')
      if (!mark) continue
      // A null is a pass with a caveat: the channel answered correctly that
      // it does not know. Distinct glyph so it reads as neither a value nor
      // a fault.
      mark.innerHTML = ' ' + (
        r.namedError || !r.ok
          ? '<span class="fail" title="' + escapeHtml(r.namedError || 'declared ' + r.declaredType + ', got ' + r.shape) + '">✗</span>'
          : r.value === null
            ? '<span class="dim" title="answered null — unknown, not zero">○</span>'
            : '<span class="pass">✓</span>'
      ) + (r.routesAgree ? '' : ' <span class="badge b-warn">routes differ</span>')

      const o = $('rout-' + r.name)
      if (o && !o.textContent) {
        o.textContent = (r.namedError ? '✗ ' : '✓ ') + r.ms + 'ms   ' +
          r.declaredType + ' → ' + r.shape + '\\n' +
          (r.namedError || JSON.stringify(r.value, null, 1))
        o.style.color = r.namedError ? 'var(--alert)' : 'var(--muted)'
      }
    }

    out.innerHTML = '<p class="dim">' +
      '<b>✓</b> a reading &nbsp; <b>○</b> answered <code>null</code> — unknown, never a zero stand-in ' +
      '&nbsp; <b>✗</b> wrong type, disagreeing routes, or an error' +
      (res.nulls
        ? '<br>' + res.nulls + ' channel(s) answered null. That is a pass: this firmware does not report that ' +
          'field, or the <code>stats</code> reply was clipped and board-level channels refuse to guess — which ' +
          'shows up on the <code>health</code> channel as <code>warn.stats_truncated</code>.'
        : '') +
      (res.errored
        ? '<br>' + res.errored + ' channel(s) answered with an error. On a reachable, healthy device that is a ' +
          'finding; on gated firmware it can be the correct answer — open the row to see which.'
        : '') +
      '</p>'
  } catch (err) {
    st.textContent = 'failed'
    st.style.color = 'var(--alert)'
    out.innerHTML = '<p class="out" style="color:var(--alert)">' + escapeHtml(err.message) + '</p>'
  }
  btn.disabled = false
  btn.textContent = 'Check all again'
}

$('btn-channels').onclick = checkChannels

// --- test suites -----------------------------------------------------------

let suites = []
let hasMdk = false
let running = null   // the live EventSource, so Stop can cut it
let stopAll = false

const suiteEl = (id) => $('suite-' + id)

const renderSuites = (info) => {
  suites = info.suites
  hasMdk = info.mdkPresent
  $('suites-note').textContent = info.mdkPresent
    ? 'MDK found at ' + info.mdkRepo
    : 'no MDK checkout at ' + info.mdkRepo + ' — the last three suites need one'
  $('suites').innerHTML = suites.map((s) => {
    const blocked = s.needsMdk && !info.mdkPresent
    return '<div class="suite" id="suite-' + s.id + '">' +
      '<div class="top"><b>' + escapeHtml(s.title) + '</b>' +
      '<span class="badge">' + escapeHtml(s.layer) + '</span>' +
      '<span class="st dim" id="st-' + s.id + '">' +
        (blocked ? 'needs MDK' : '~' + s.seconds + 's') + '</span></div>' +
      '<p class="what">' + escapeHtml(s.what) + '</p>' +
      '<p class="proves">' + escapeHtml(s.proves) + '</p>' +
      '<div class="ran">$ ' + escapeHtml(s.command) + '</div>' +
      '<div class="bar"><button ' + (blocked ? 'disabled' : '') +
        ' id="btn-' + s.id + '">Run</button></div>' +
      '<pre id="out-' + s.id + '" hidden></pre>' +
      '</div>'
  }).join('')

  for (const s of suites) {
    const btn = $('btn-' + s.id)
    if (btn) btn.onclick = () => runSuite(s.id)
  }
}

const runSuite = (id) => new Promise((resolve) => {
  const card = suiteEl(id)
  const out = $('out-' + id)
  const st = $('st-' + id)
  const btn = $('btn-' + id)

  card.className = 'suite running'
  st.textContent = 'running…'
  st.style.color = 'var(--accent)'
  out.hidden = false
  out.textContent = ''
  if (btn) btn.disabled = true

  // Output can be long; follow the tail unless the reader has scrolled up.
  const follow = () => {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40
    if (atBottom) out.scrollTop = out.scrollHeight
  }

  const es = new EventSource('/api/suites/run?id=' + encodeURIComponent(id))
  running = es

  es.addEventListener('line', (e) => {
    out.textContent += JSON.parse(e.data) + '\\n'
    follow()
  })

  es.addEventListener('done', (e) => {
    const { code, error, ms } = JSON.parse(e.data)
    es.close()
    running = null
    const ok = code === 0
    card.className = 'suite ' + (ok ? 'pass' : 'fail')
    st.textContent = (ok ? 'passed' : error ? 'could not start' : 'failed (exit ' + code + ')') +
      ' · ' + (ms / 1000).toFixed(1) + 's'
    st.style.color = ok ? 'var(--ok)' : 'var(--alert)'
    if (error) out.textContent += error + '\\n'
    // standard says nothing when it is happy; hide the box rather than show
    // an empty one, which reads as a broken stream.
    if (!out.textContent.trim()) out.hidden = true
    if (btn) { btn.disabled = false; btn.textContent = 'Run again' }
    resolve(ok)
  })

  es.onerror = () => {
    // Fires on a normal close too; only act while still open.
    if (running !== es) return
    es.close()
    running = null
    card.className = 'suite fail'
    st.textContent = 'stream interrupted'
    st.style.color = 'var(--alert)'
    if (btn) btn.disabled = false
    resolve(false)
  }
})

$('run-all').onclick = async () => {
  const all = $('run-all')
  stopAll = false
  all.disabled = true
  all.textContent = 'Running…'
  // Sequentially on purpose: the integration and e2e suites each boot their
  // own runtime, mocks and DHT, and racing them would make a timeout look
  // like a failure.
  let passed = 0
  let ran = 0
  for (const s of suites) {
    if (stopAll) break
    if (s.needsMdk && !hasMdk) continue
    ran++
    if (await runSuite(s.id)) passed++
  }
  all.disabled = false
  all.textContent = 'Run all again'
  $('suites-note').textContent = stopAll
    ? 'stopped after ' + ran + ' suite(s)'
    : passed + ' / ' + ran + ' suites passed'
}

$('stop-all').onclick = () => {
  stopAll = true
  if (running) running.close()
  // The server kills the child when the stream closes.
  for (const s of suites) {
    const card = suiteEl(s.id)
    if (card && card.classList.contains('running')) {
      card.className = 'suite'
      $('st-' + s.id).textContent = 'stopped'
      $('st-' + s.id).style.color = 'var(--muted)'
      const btn = $('btn-' + s.id)
      if (btn) btn.disabled = false
    }
  }
  running = null
}

$('device').onchange = async (e) => {
  current = e.target.value
  // The read results and marks belong to the device they came from; leaving
  // them on screen would attribute one miner's readings to another.
  for (const el of document.querySelectorAll('[id^=rout-]')) el.textContent = ''
  for (const el of document.querySelectorAll('[data-mark]')) el.innerHTML = ''
  $('st-channels').textContent = ''
  $('channels-out').innerHTML = ''
  $('btn-channels').textContent = 'Check all'
  await loadDevices()
  refresh()
}
$('refresh').onclick = refresh

;(async () => {
  contract = await get('/api/contract')
  renderSuites(await get('/api/suites'))
  await loadDevices()
  await refresh()
  await loadAudit()
  setInterval(() => { if ($('auto').checked) { refresh(); loadAudit() } }, 2000)
  // Live devices are re-probed server-side every 15s; pick the change up.
  setInterval(() => { loadDevices() }, 5000)
})()
</script>
</body>
</html>`

// The page's browser script lives inside this file's own template literal, so
// an escape that is right in one layer is wrong in the other: a `\n` meant for
// the browser becomes a real newline inside a delivered string literal, the
// whole inline script fails to parse, and every panel silently renders empty.
// That failure mode is invisible from the server side and cost two debugging
// rounds, so parse the script at startup. `new Function` compiles without
// executing, which is exactly the check wanted — no browser globals needed.
const assertPageScriptParses = () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(PAGE.replace('__FAULTS__', '[]').replace('__PHOTOS__', '[]'))
  if (!match) {
    console.error('  dev-console: the page has no inline <script> — refusing to serve a dead page.')
    process.exit(1)
  }
  try {
    // eslint-disable-next-line no-new-func
    const compiled = new Function(match[1])
    if (typeof compiled !== 'function') throw new Error('did not compile')
  } catch (err) {
    console.error('')
    console.error(`  The console page script does not parse: ${err.message}`)
    console.error('  Almost certainly an escape inside the PAGE template literal:')
    console.error('  a newline for the browser must be written \\\\n, not \\n.')
    console.error('')
    process.exit(1)
  }
}

assertPageScriptParses()
main().catch((err) => { console.error(err); process.exitCode = 1 })
