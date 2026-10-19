'use strict'

// Which commands and modes a given SealMiner actually accepts.
//
// The A2/A3/A4 API is otherwise identical, so the two axes that matter are
// the series (only A2 has low_power) and the firmware version (five features
// are version-gated, and `resume` was removed for a range of builds and then
// restored). One table, used in three places: the `capabilities` telemetry
// channel, the command guard's gating check, and the guard's enum check.

const debug = require('debug')('sealminer:capabilities')

const SERIES = ['A2', 'A3', 'A4']

// Firmware strings appear both as 8-digit dates ("20230805FF") and as
// 10-digit date+build values ("2026060101"), including inside the document's
// own gate descriptions. Normalize everything to 10 digits so comparisons
// cannot silently compare a date against a date+build.
const normalizeFirmware = (raw) => {
  const digits = /^(\d{8,10})/.exec(String(raw ?? '').trim())
  if (!digits) return { raw: raw ?? null, value: null, resolved: false }
  const padded = digits[1].padEnd(10, '0')
  return { raw: String(raw), value: Number(padded), resolved: true }
}

const FW = {
  // V0.2 added set hostname / set network / set webpasswd.
  IDENTITY_AND_NETWORK: 2025062602,
  // V0.3 added set idle-fan-timer.
  IDLE_FAN_TIMER: 2025081801,
  // "sleep" mining mode supported in 2025101601 and later.
  SLEEP_MODE: 2025101601,
  // resume was removed from 2025080401 through 20260531 and restored in
  // 2026060101 (doc 4.1.2). Below the removal window it still exists.
  RESUME_RESTORED: 2026060101,
  RESUME_REMOVED_FROM: 2025080401
}

// DELIBERATELY NOT GATED: whether a mining-setting write applies at once or
// waits for the next bdminer restart. Firmware below roughly 2026060101
// stores the value instead of applying it, and the API cannot read the
// pending one back — so this was never something the device could answer,
// only something a version table could guess. By decision it is no longer
// reported per device: every write says what was accepted and which channel
// confirms it, and the caller reads that channel. The family-level fact is
// kept in the contract's prose for setPowerMode, setPowerLimit and
// setFastRaiseFreq, because an operator who does not know it can read a
// stale value back and conclude a write failed when it is in fact armed.

// Firmware gate predicates. A gate returns false only when we are *certain*
// the feature is missing; an unresolved firmware version yields
// `supported: false` with `resolved: false` so the reason is visible rather
// than guessed either way.
const GATES = {
  identityAndNetwork: (fw) => fw >= FW.IDENTITY_AND_NETWORK,
  idleFanTimer: (fw) => fw >= FW.IDLE_FAN_TIMER,
  sleepMode: (fw) => fw >= FW.SLEEP_MODE,
  resume: (fw) => fw >= FW.RESUME_RESTORED || fw < FW.RESUME_REMOVED_FROM
}

const GATE_REASON = {
  identityAndNetwork: `requires firmware >= ${FW.IDENTITY_AND_NETWORK}`,
  idleFanTimer: `requires firmware >= ${FW.IDLE_FAN_TIMER}`,
  sleepMode: `requires firmware >= ${FW.SLEEP_MODE}`,
  resume: `requires firmware >= ${FW.RESUME_RESTORED} (removed in ${FW.RESUME_REMOVED_FROM}..2026053100)`
}

// Every command the contract declares, with its gate, the fallback to name
// when it is unavailable, and the `ascset` subcommand whose presence proves
// it exists on this firmware.
//
// `sub` is what makes discovery possible. `ascset help` returns the list of
// subcommands a given firmware actually has, so for those commands the
// device itself is the authority and the version table below is only a
// fallback. Verified against three real miners: an A2 on 2026040101 omits
// `resume` — matching the documented removal window — while an A3 on
// 2026073000 and an A4 on 2026083100 both list it.
//
// reboot, restartMiner and setupPools have no `sub`: they are top-level 4028
// commands (`reboot`, `restart`, `updatepools`), not ascset subcommands, so
// `ascset help` says nothing about them and they stay table-only.
const COMMANDS = {
  reboot: {},
  restartMiner: {},
  suspend: { sub: 'suspend' },
  resume: { gate: 'resume', fallback: 'restartMiner', sub: 'resume' },
  setPowerMode: { sub: 'workmode' },
  setPowerLimit: { sub: 'powerlimit' },
  setupPools: {},
  setTimezone: { sub: 'timezone' },
  setPreheat: { sub: 'preheat' },
  setFastRaiseFreq: { sub: 'fast-raise-freq' },
  setHostname: { gate: 'identityAndNetwork', sub: 'hostname' },
  setNetwork: { gate: 'identityAndNetwork', sub: 'network' },
  setIdleFanTimer: { gate: 'idleFanTimer', sub: 'idle-fan-timer' },
  // Added in API doc V0.5; the document does not state a lower firmware
  // bound, so it is reported as supported with the caveat attached.
  // TODO(sealminer-firmware): confirm the minimum firmware version.
  setStratumDisconnectTimeout: { note: 'minimum firmware version unconfirmed', sub: 'stratum-disconnect-timeout' }
}

// The newest firmware this table was written against. A device above it is
// not refused anything — it is simply flagged, because every gate here is
// `fw >= X` and that assumes features only ever get added. This firmware has
// already broken that assumption once: `resume` was removed for ten months
// and then restored. So a build newer than anything measured gets a warning
// rather than a silent promise that everything works.
const NEWEST_KNOWN_FIRMWARE = Math.max(...Object.values(FW))

// `ascset help` answers with one free-text line:
//
//   ASC 0 set help: suspend & resume & powerlimit & workmode & ...
//
// Parsing firmware prose is itself a maintenance surface, so the failure mode
// matters more than the happy path. A wording or separator change must
// degrade to "discovery unavailable, use the table" — never to "nothing is
// supported", which would disable every gated command across a whole fleet.
// The floor below is that safeguard: a real reply carries 12-13 subcommands,
// so a handful of tokens means the parse went wrong, not that the firmware
// shrank.
const MIN_PLAUSIBLE_SUBCOMMANDS = 5

/**
 * Parse the subcommand list out of an `ascset help` reply.
 * @returns {string[]|null} null when the reply cannot be trusted
 */
const parseSubcommands = (helpMessage) => {
  if (typeof helpMessage !== 'string') return null
  const afterColon = helpMessage.includes(':') ? helpMessage.slice(helpMessage.indexOf(':') + 1) : helpMessage
  const found = afterColon.split('&').map((part) => part.trim().toLowerCase()).filter(Boolean)
  if (found.length < MIN_PLAUSIBLE_SUBCOMMANDS) {
    debug('ascset help looks unparseable (%d token(s)): %o', found.length, helpMessage)
    return null
  }
  return found
}

// `workmode` values per series (doc 4.1.4). `sleep` is additionally
// firmware-gated for every series.
const SERIES_MODES = {
  A2: ['low_power', 'normal', 'high_performance'],
  A3: ['normal', 'high_performance'],
  A4: ['normal', 'high_performance']
}
// Used when the series cannot be resolved: the intersection, so an unknown
// miner is never offered a mode its firmware might reject.
const CONSERVATIVE_MODES = ['normal', 'high_performance']

// `Model` is a PRODUCT name, not a series. Confirmed on six real miners —
// every series ships both an air-cooled and a water-cooled product, so
// nothing may be inferred about cooling from the series or vice versa:
//
//   A2               -> A2   air    firmware 2026040101
//   "A2 Pro Hydro"   -> A2   water  firmware 2026092000
//   "A3 Air"         -> A3   air    firmware 2026073000
//   "A3 Pro Hydro"   -> A3   water  firmware 2026091400
//   "A4 Pro Air"     -> A4   air    firmware 20260915FF
//   "A4 Ultra Hydro" -> A4   water  firmware 2026083100
//
// Only the A2 happened to report a bare series, which is what made the first
// version of this table — exact matches only — look sufficient. It was not:
// "A3 Air" matched nothing, so the series came back unresolved on every real
// A3 and A4. The fallback was graceful rather than wrong (A3/A4's own mode
// set equals the conservative intersection), but `series: null` is still bad
// information, and an A2 sold under a product name would have had
// `low_power` withheld.
//
// Exact aliases first, then the leading series token, which is how the
// product names are built. A site can always declare `series` in the device
// config, and that still wins over anything inferred here.
const MODEL_SERIES = {
  a2: 'A2',
  a3: 'A3',
  a4: 'A4',
  k10pro: 'A2'
}

// "a3 air", "a4 ultra hydro", "a2" — the series is the first token.
const MODEL_SERIES_PREFIX = /^(a[234])(?:\s|$)/

const resolveSeries = ({ series, model }) => {
  if (series) {
    const upper = String(series).trim().toUpperCase()
    if (SERIES.includes(upper)) return { series: upper, resolved: true, source: 'config' }
    debug('ignoring unknown configured series: %o', series)
  }
  const key = String(model ?? '').trim().toLowerCase()
  if (key && MODEL_SERIES[key]) return { series: MODEL_SERIES[key], resolved: true, source: 'model' }

  const prefix = MODEL_SERIES_PREFIX.exec(key)
  if (prefix) return { series: prefix[1].toUpperCase(), resolved: true, source: 'model-prefix' }

  if (key) debug('model not in MODEL_SERIES and has no series prefix: %o', model)
  return { series: null, resolved: false, source: null }
}

/**
 * @param {object} input
 * @param {string} [input.series] series declared in the device config (wins)
 * @param {string} [input.model] `stats.Model`
 * @param {string} [input.firmware] `stats.Firmware`
 * @param {string} [input.softwareVersion] `stats.Software Version`
 * @returns {object} capability descriptor; also the `capabilities` channel value
 */
const resolve = (input = {}) => {
  const series = resolveSeries(input)
  const firmware = normalizeFirmware(input.firmware)

  const gateState = {}
  for (const [name, predicate] of Object.entries(GATES)) {
    gateState[name] = firmware.resolved ? predicate(firmware.value) : false
  }

  const modes = series.resolved ? SERIES_MODES[series.series] : CONSERVATIVE_MODES
  const powerModes = gateState.sleepMode ? [...modes, 'sleep'] : [...modes]

  // What the device itself said, when a caller supplied an `ascset help`
  // reply. Null means discovery did not happen or could not be trusted, and
  // every verdict then comes from the table.
  const discovered = parseSubcommands(input.helpMessage)

  const commands = {}
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const gated = spec.gate ? gateState[spec.gate] : true

    // The device wins where it can answer. That is the whole point: the table
    // encodes what was true of the builds someone measured, while the
    // firmware knows what is true of this one. A command the table would
    // allow but the firmware no longer lists is refused, which is exactly the
    // case a version table cannot catch.
    const askable = Boolean(discovered && spec.sub)
    const supported = askable ? discovered.includes(spec.sub) : gated

    const entry = { supported, source: askable ? 'discovered' : 'table' }
    if (!supported) {
      entry.reason = askable
        ? `this firmware does not offer ascset ${spec.sub} (asked the device)`
        : firmware.resolved
          ? GATE_REASON[spec.gate]
          : `firmware version could not be determined (reported ${JSON.stringify(firmware.raw)})`
      if (spec.fallback) entry.fallback = spec.fallback
    }
    if (spec.note) entry.note = spec.note
    if (name === 'setPowerMode') {
      entry.enum = powerModes
      if (!series.resolved) {
        entry.note = 'series unresolved — only the modes common to A2/A3/A4 are offered'
      }
    }
    commands[name] = entry
  }

  // A build newer than anything this table was written against. Nothing is
  // refused on that basis — the flag exists so a consumer is told the
  // capability view may be stale instead of being quietly assured it is
  // complete. Discovery removes most of the doubt but not all of it: the
  // device can say which subcommands exist, never which mode values they
  // accept.
  const firmwareNewerThanKnown = firmware.resolved && firmware.value > NEWEST_KNOWN_FIRMWARE

  return {
    firmwareNewerThanKnown,
    newestKnownFirmware: NEWEST_KNOWN_FIRMWARE,
    // Where the command verdicts came from. 'device' when the firmware's own
    // subcommand list was used, 'table' when it was not available.
    capabilitySource: discovered ? 'device' : 'table',
    discoveredSubcommands: discovered,
    series: series.series,
    seriesResolved: series.resolved,
    seriesSource: series.source,
    model: input.model ?? null,
    firmware: firmware.raw,
    firmwareValue: firmware.value,
    firmwareResolved: firmware.resolved,
    softwareVersion: input.softwareVersion ?? null,
    powerModes,
    commands
  }
}

/** True when this device accepts `command`. */
const supportsCommand = (caps, command) => Boolean(caps?.commands?.[command]?.supported)

/** True when this device accepts `mode` for setPowerMode. */
const supportsPowerMode = (caps, mode) => Array.isArray(caps?.powerModes) && caps.powerModes.includes(mode)

module.exports = {
  resolve,
  supportsCommand,
  supportsPowerMode,
  normalizeFirmware,
  parseSubcommands,
  NEWEST_KNOWN_FIRMWARE,
  SERIES,
  SERIES_MODES,
  CONSERVATIVE_MODES,
  MODEL_SERIES,
  COMMANDS,
  FW
}
