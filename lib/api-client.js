'use strict'

const { TcpRpc, DEFAULT_PORT } = require('./tcp-rpc')
const parser = require('./parser')
const capabilities = require('./capabilities')
const {
  fail,
  ERR_DEVICE_CONFIG_INVALID,
  ERR_API_CONNECTION,
  ERR_API_RESPONSE_INVALID,
  ERR_STATS_TRUNCATED
} = require('./errors')

// Kernel pulls `metrics` every 10s by default, which fans out to every
// telemetry handler *concurrently*. A plain TTL cache still lets that first
// burst through, so ~26 handlers would open ~26 sockets to a single-threaded
// 4028 API at once. Single-flight collapses the burst into one request.
const DEFAULT_STATS_TTL_MS = 4000
const DEFAULT_POOLS_TTL_MS = 8000

const noopLogger = () => {}

/**
 * SealMiner device client. Plain device I/O against the 4028 JSON API —
 * no MDK concepts, no base classes. Safe to use outside MDK.
 *
 * @param {object} opts
 * @param {string} opts.host miner address (`address` accepted as an alias)
 * @param {number} [opts.port=4028]
 * @param {number} [opts.timeoutMs=8000]
 * @param {string} [opts.series] 'A2'|'A3'|'A4'; declared by the site, wins
 *   over model-string inference
 * @param {number} [opts.cacheTtlMs=4000] stats/summary freshness window
 * @param {boolean} [opts.parseChips=false] also normalize per-chip data
 * @param {Function} [opts.logger] debug-style logger
 */
const createClient = (opts = {}) => {
  const host = opts.host || opts.address
  if (!host || typeof host !== 'string') fail(ERR_DEVICE_CONFIG_INVALID, 'host/address is required')

  const port = opts.port ?? DEFAULT_PORT
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) {
    fail(ERR_DEVICE_CONFIG_INVALID, `port: ${port}`)
  }

  const logger = opts.logger || noopLogger
  const statsTtl = opts.cacheTtlMs ?? DEFAULT_STATS_TTL_MS
  const poolsTtl = opts.poolsCacheTtlMs ?? DEFAULT_POOLS_TTL_MS
  const parseChips = Boolean(opts.parseChips)

  const rpc = new TcpRpc({ host, port: Number(port), timeoutMs: opts.timeoutMs })

  // --- single-flight cache -------------------------------------------------

  const slots = new Map()
  const slot = (key) => {
    if (!slots.has(key)) slots.set(key, { value: null, at: 0, pending: null })
    return slots.get(key)
  }

  const cached = (key, ttlMs, producer) => {
    const entry = slot(key)
    const age = Date.now() - entry.at
    if (entry.value !== null && age < ttlMs) {
      return Promise.resolve({ value: entry.value, cached: true, ageMs: age })
    }
    if (entry.pending) return entry.pending
    entry.pending = producer()
      .then((value) => {
        entry.value = value
        entry.at = Date.now()
        return { value, cached: false, ageMs: 0 }
      })
      .finally(() => { entry.pending = null })
    return entry.pending
  }

  /** Drop cached reads. Called after every successful write. */
  const invalidate = () => {
    for (const [key, entry] of slots) {
      if (key === 'version') continue // firmware cannot change while running
      // The subcommand list cannot change because of a write, and refetching
      // it after every command would add a round trip to each one.
      if (key.startsWith('help:')) continue
      entry.value = null
      entry.at = 0
    }
  }

  // --- raw request with bounded retry for reads ---------------------------

  // A real A2 returned one malformed stats reply in roughly forty reads —
  // valid-looking JSON cut off mid-key. It is transient, so one retry turns a
  // visible channel error into a non-event. Writes are never retried.
  const RETRYABLE = new Set([ERR_API_CONNECTION, ERR_API_RESPONSE_INVALID])

  const read = async (command, parameter) => {
    const request = parameter === undefined ? { command } : { command, parameter }
    let lastError
    // One retry, connection errors only. A timeout is never retried: the
    // miner may simply be busy, and hammering it makes that worse.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { body, truncated } = await rpc.request(request)
        parser.assertOk(body, command)
        return { body, truncated }
      } catch (err) {
        lastError = err
        if (!RETRYABLE.has(err.code) || attempt === 1) throw err
        logger('retrying %s after %s', command, err.code)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    throw lastError
  }

  /**
   * Writes are never retried. A timeout after a physical write leaves the
   * outcome unknown, and repeating it can duplicate the operation.
   */
  const write = async (command, parameter) => {
    const request = parameter === undefined ? { command } : { command, parameter }
    const { body } = await rpc.request(request)
    parser.assertOk(body, command)
    invalidate()
    return body
  }

  // --- reads --------------------------------------------------------------

  const statsRaw = () => cached('stats', statsTtl, async () => {
    const { body, truncated } = await read('stats')
    return parser.parseStats(parser.section(body, 'STATS'), { truncated, parseChips })
  })

  const stats = async () => (await statsRaw()).value

  const statsWithMeta = async () => {
    const { value, cached: fromCache, ageMs } = await statsRaw()
    return { stats: value, cached: fromCache, ageMs }
  }

  const summary = async () => (await cached('summary', statsTtl, async () => {
    const { body } = await read('summary')
    return parser.parseSummary(parser.section(body, 'SUMMARY'))
  })).value

  const pools = async () => (await cached('pools', poolsTtl, async () => {
    const { body } = await read('pools')
    return parser.parsePools(parser.section(body, 'POOLS', { list: true }))
  })).value

  const version = async () => (await cached('version', Infinity, async () => {
    const { body } = await read('version')
    return parser.parseVersion(parser.section(body, 'VERSION'))
  })).value

  const config = async () => (await cached('config', poolsTtl, async () => {
    const { body } = await read('config')
    return parser.parseConfig(parser.section(body, 'CONFIG'))
  })).value

  const devDetails = async () => (await cached('devdetails', Infinity, async () => {
    const { body } = await read('devdetails')
    return parser.parseDevDetails(parser.section(body, 'DEVDETAILS'))
  })).value

  /** Capability descriptor for this device, derived from stats + config. */
  /**
   * Ask the device which `ascset` subcommands it actually has.
   *
   * Cached under the firmware string, so the answer is fetched once per
   * device and refetched by itself if the miner is upgraded underneath a
   * running worker — the subcommand list cannot change without the firmware
   * changing, and the firmware version arrives with every `stats`.
   *
   * Failure is not an error here. An unreachable miner, a firmware that
   * refuses `ascset` (reply code 45), a reworded help line: all of them mean
   * "no discovery this time", and the capability table answers instead. This
   * must never turn into "no commands are supported".
   */
  const discoverSubcommands = async (firmware) => {
    try {
      return (await cached(`help:${firmware}`, Infinity, async () => {
        const status = await readStatus()
        return status && typeof status.msg === 'string' ? status.msg : null
      })).value
    } catch (err) {
      logger('capability discovery unavailable, using the version table: %s', err.code || err.message)
      return null
    }
  }

  const getCapabilities = async () => {
    const s = await stats()
    return capabilities.resolve({
      series: opts.series,
      model: s.identity.model,
      firmware: s.firmware.firmware,
      softwareVersion: s.firmware.softwareVersion,
      helpMessage: await discoverSubcommands(s.firmware.firmware)
    })
  }

  /**
   * Board-level view, or null when the reply was clipped and the boards are
   * incomplete. Callers must not treat a short array as the whole miner.
   */
  const boards = async () => {
    const s = await stats()
    if (!s.boardsComplete) return null
    return s.boards
  }

  /** Throws when board-level data is unusable, for channels that need it. */
  const boardsOrThrow = async () => {
    const s = await stats()
    if (!s.boardsComplete) {
      fail(ERR_STATS_TRUNCATED, `${s.boards.length}/${s.declaredBoardCount} boards returned`)
    }
    return s.boards
  }

  /** Everything in one object, for the `snap` channel. */
  const snapshot = async () => {
    const [{ stats: s, cached: fromCache, ageMs }, sum, pl, ver, cfg] = await Promise.all([
      statsWithMeta(), summary(), pools(), version(), config()
    ])
    return {
      ts: Date.now(),
      cached: fromCache,
      ageMs,
      truncated: s.truncated,
      boardsComplete: s.boardsComplete,
      stats: s,
      summary: sum,
      pools: pl,
      version: ver,
      config: cfg
    }
  }

  // --- writes -------------------------------------------------------------

  // Every ascset value must be a JSON STRING. Verified against a real A2
  // (firmware 2026040101): a number or a boolean is refused with
  // 'Missing "<key>"', even where the document calls the field an int or a
  // boolean. Booleans go as "1"/"0" — "true"/"false" are refused as invalid.
  const ascsetValue = (value) => {
    if (typeof value === 'boolean') return value ? '1' : '0'
    return String(value)
  }

  const ascsetParameter = (sub, args) => {
    const base = `0,${sub}`
    if (args === undefined || args === null) return base
    const stringified = Object.fromEntries(
      Object.entries(args).map(([key, value]) => [key, ascsetValue(value)])
    )
    return `${base},${JSON.stringify(stringified)}`
  }

  const ascset = (sub, args) => write('ascset', ascsetParameter(sub, args))

  // `ascset help` has no effect on the device and is the one write-shaped
  // call that is safe to issue for information.
  const readStatus = () => read('ascset', ascsetParameter('help')).then(({ body }) => parser.readStatus(body))

  return {
    host,
    port: Number(port),

    // reads
    stats,
    statsWithMeta,
    summary,
    pools,
    version,
    config,
    devDetails,
    boards,
    boardsOrThrow,
    getCapabilities,
    snapshot,

    // writes — one method per documented operation
    reboot: () => write('reboot'),
    restartMiner: () => write('restart'),
    suspend: () => ascset('suspend'),
    resume: () => ascset('resume'),
    setPowerLimit: (watts) => ascset('powerlimit', { value: String(watts) }),
    setWorkMode: (mode) => ascset('workmode', { mode }),
    setTimezone: (tz) => ascset('timezone', { value: tz }),
    setHostname: (hostname) => ascset('hostname', { value: hostname }),
    setNetwork: (network) => ascset('network', network),
    setPreheat: (preheat) => ascset('preheat', preheat),
    setFastRaiseFreq: (enabled) => ascset('fast-raise-freq', { value: Boolean(enabled) }),
    setIdleFanTimer: (timer) => ascset('idle-fan-timer', timer),
    setStratumDisconnectTimeout: (seconds) => ascset('stratum-disconnect-timeout', { value: String(seconds) }),
    updatePools: (poolList) => write('updatepools', JSON.stringify({ pools: poolList })),
    ascsetHelp: () => readStatus(),

    // lifecycle / test seams
    invalidate,
    ascset,
    stop: () => rpc.stop()
  }
}

module.exports = { createClient, DEFAULT_STATS_TTL_MS, DEFAULT_POOLS_TTL_MS }
