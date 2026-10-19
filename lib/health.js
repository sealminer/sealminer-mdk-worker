'use strict'

const p = require('./provisional')

// Fleet-grade health evaluation.
//
// Two design rules, both aimed at the failure mode that actually wastes
// operator time in a mining farm — false alarms:
//
//   1. Expected states are states, not faults. A tuning miner and a
//      deliberately suspended miner stay OK and are reported as info.*
//   2. info.tuning suppresses alert.hashrate_low. Reduced hashrate during a
//      tuning cycle is normal; alerting on it trains operators to ignore
//      the channel.

const SEVERITY = { alert: 'alert', warn: 'warn', info: 'info' }

const TUNING_STATES = new Set(['coarse_tuning', 'fine_tuning'])
const HASHING_STATE = 'running'

/**
 * @param {object} input
 * @param {object} input.stats parsed stats (lib/parser/stats.js)
 * @param {object} [input.summary] parsed summary
 * @param {object[]} [input.pools] parsed pools
 * @param {object} [input.capabilities] resolved capability descriptor
 *   (lib/capabilities.js). Supplied separately because it is not part of a
 *   stats reply — it is derived from one, plus what the device answered when
 *   asked which subcommands it has.
 * @returns {{status: string, alerts: string[], details: object[], checkedAt: number}}
 */
// Device-level stats keys that all six measured products reported, on every
// firmware from 2026040101 to 20260915FF, in every state including suspended.
// Fields that are legitimately absent are NOT here: `Fan Count` and the fan
// list are missing on water-cooled miners by design, `PSU Temp HOT` is sent
// by no measured product, and `MHS(Rated)` reads 0 on two of them.
const ALWAYS_REPORTED = [
  ['temperature', (s) => s.thermal.temp],
  ['target_temperature', (s) => s.thermal.targetCtrlTemp],
  ['power_limit', (s) => s.settings.powerLimit],
  ['model', (s) => s.identity.model],
  ['firmware', (s) => s.firmware.firmware],
  ['chip_count', (s) => s.chip.count],
  ['board_count', (s) => s.declaredBoardCount],
  ['uptime', (s) => s.state.systemUptime],
  ['psu_model', (s) => s.psu.model]
]

// A temperature for a message, without rendering null as "nullC".
const degrees = (value) => (value === null ? 'an unreadable value' : `${value}C`)

const evaluate = ({ stats, summary, pools, capabilities } = {}) => {
  const details = []
  const add = (code, severity, detail) => details.push({ code, severity, detail })

  if (!stats) {
    add('alert.unreachable', SEVERITY.alert, 'no telemetry could be read from the device')
    return finish(details)
  }

  const running = stats.state.pmState === HASHING_STATE
  const tuning = TUNING_STATES.has(stats.state.tuneStatus)
  const suspended = stats.state.pmState === 'suspended'
  // bdminer's own uptime, which a restart resets while the controller's does
  // not. Inside the ramp window, low hashrate is expected.
  const elapsed = stats.state.elapsed
  const starting = elapsed !== null && elapsed < p.STARTUP_RAMP_S.value

  // --- expected states, reported so consumers can suppress on them --------

  if (tuning) {
    add('info.tuning', SEVERITY.info, `tune_status=${stats.state.tuneStatus}; reduced hashrate is expected for up to 15 minutes`)
  }
  if (suspended) {
    add('info.suspended', SEVERITY.info, 'mining is suspended by request; PSU output and fans are off')
  }
  if (starting && !suspended) {
    add('info.starting', SEVERITY.info,
      `bdminer has been up ${elapsed}s; hashrate ramps for up to ${p.STARTUP_RAMP_S.value}s after a restart`)
  }

  // --- data-quality warnings ----------------------------------------------

  if (stats.truncated || !stats.boardsComplete) {
    add('warn.stats_truncated', SEVERITY.warn,
      `stats reply clipped: ${stats.boards.length}/${stats.declaredBoardCount ?? '?'} boards returned; board-level channels are null this cycle`)
  }
  if (stats.state.pmState === null || stats.state.miningMode === null) {
    add('warn.enum_unreadable', SEVERITY.warn,
      'firmware reports mode/state as undocumented integers; power_mode, status and tune_status read null')
  }

  // A field that every measured product reports, in every state, coming back
  // null. The parser reads named keys, so the usual cause is a firmware that
  // renamed one — which has happened repeatedly (`Chip voltage` to
  // `Chip Voltage`, `BDMiner` to `Bdminer`) and is the one kind of firmware
  // drift capability discovery cannot catch: `ascset help` answers which
  // commands exist, never which keys a stats reply uses.
  //
  // Without this the failure is silent. The channel simply reads null, which
  // is the honest answer for "not reported" and indistinguishable from it, so
  // a rename shows up as an empty dashboard rather than as a problem. Saying
  // it out loud is what makes the diff in FIRMWARE.md worth running.
  //
  // Only device-level fields, and only when the reply was complete: a clipped
  // reply legitimately nulls board-level values, and warn.stats_truncated
  // already covers that.
  //
  // A warning, not an alert, for the same reason as warn.firmware_unverified:
  // the miner is fine, our description of it is not.
  if (!stats.truncated && stats.boardsComplete) {
    const missing = ALWAYS_REPORTED
      .filter(([, read]) => read(stats) === null)
      .map(([key]) => key)
    if (missing.length > 0) {
      add('warn.fields_unreadable', SEVERITY.warn,
        `${missing.join(', ')} read null although every measured product reports them; the firmware may have renamed a stats key — diff a capture against mock/fixtures/ (see FIRMWARE.md)`)
    }
  }

  // A build newer than the capability table was written against. Nothing is
  // wrong with the miner; what is uncertain is this worker's description of
  // it. Every firmware gate is `fw >= X`, which assumes features are only
  // ever added — and this firmware has already removed one and restored it
  // ten months later. So say so rather than let a stale capability view pass
  // for a complete one.
  //
  // The severity is deliberate. This is a warning about our own knowledge,
  // not a device fault, so it must not degrade a healthy miner: an operator
  // who sees DEGRADED on a fleet that just took a firmware update learns to
  // ignore the channel.
  const caps = capabilities
  if (caps && caps.firmwareNewerThanKnown) {
    const asked = caps.capabilitySource === 'device'
    add('warn.firmware_unverified', SEVERITY.warn,
      asked
        ? `firmware ${stats.firmware.firmware} is newer than ${caps.newestKnownFirmware}; which commands exist was read from the device, but mode values and whether settings apply immediately are still assumed`
        : `firmware ${stats.firmware.firmware} is newer than ${caps.newestKnownFirmware} and the device could not be asked what it supports; the capability view may be stale`)
  }

  // --- thermal -------------------------------------------------------------

  // A water-cooled miner does not regulate the reported `Temp` against
  // `Target Ctrl Temp` the way an air-cooled one does. Measured on healthy
  // production hardware, every one in fine_tuning_done:
  //
  //   A2               air    temp 70, target 70   delta  0
  //   A3 Air           air    temp 66, target 65   delta +1
  //   A4 Pro Air       air    temp 70, target 70   delta  0
  //   A2 Pro Hydro     water  temp 46, target 60   delta -14
  //   A3 Pro Hydro     water  temp 50, target 60   delta -10
  //   A4 Ultra Hydro   water  temp 67, target 60   delta +7
  //
  // Both cooling types occur on all three series, so the split is keyed off
  // `Liquid Cooling` and never off the series or the product name.
  //
  // The air machines track their target to within a degree; the hydro one
  // sits well above it and is fine. Applying the same margin to both raised
  // alert.overheat on a healthy 845 TH/s miner. Widening the margin globally
  // would have silenced that alarm by desensitising the air machines, where
  // +5 over target is a real signal — so the two are judged separately, on
  // the firmware's own `Liquid Cooling` flag rather than on a guess from the
  // model name.
  const { temp, targetCtrlTemp, liquidCooling } = stats.thermal

  if (liquidCooling === true) {
    add('info.liquid_cooled', SEVERITY.info,
      `liquid cooled: no fans are expected, and temp ${degrees(temp)} is not regulated against target ${degrees(targetCtrlTemp)}`)
    if (temp !== null && temp >= p.LIQUID_OVERHEAT_ALERT_C.value) {
      add('alert.overheat', SEVERITY.alert,
        `temp ${temp}C at or above ${p.LIQUID_OVERHEAT_ALERT_C.value}C on a liquid-cooled miner`)
    }
  } else if (temp !== null && targetCtrlTemp !== null && temp >= targetCtrlTemp + p.OVERHEAT_MARGIN_C.value) {
    // Also the path taken when `Liquid Cooling` is absent (null) on older
    // firmware: the target-relative rule is the conservative choice, because
    // it alerts rather than staying quiet when the cooling type is unknown.
    add('alert.overheat', SEVERITY.alert, `temp ${temp}C is ${temp - targetCtrlTemp}C over target ${targetCtrlTemp}C`)
  }
  if (!suspended && stats.psu.tempHot !== null && stats.psu.tempHot >= p.PSU_TEMP_HOT_ALERT_C.value) {
    add('alert.psu_overheat', SEVERITY.alert, `PSU hot-spot ${stats.psu.tempHot}C at or above ${p.PSU_TEMP_HOT_ALERT_C.value}C`)
  }

  // --- PSU -----------------------------------------------------------------

  if (stats.psu.errorWord && !/^0x0+$/i.test(stats.psu.errorWord)) {
    // A suspended miner has had its PSU output deliberately shut down, and a
    // real A2 then reports a non-zero error word. Observed on hardware: this
    // fired alert.psu_error and degraded a miner that an operator had just
    // suspended on purpose. It cannot be told apart from a genuine PSU fault
    // while the output is off, so it is reported without degrading health and
    // will alert again as soon as the miner is back to running.
    if (suspended) {
      add('info.psu_output_off', SEVERITY.info,
        `PSU error word ${stats.psu.errorWord} while suspended, which is expected with the output shut down`)
    } else {
      add('alert.psu_error', SEVERITY.alert, `PSU error word ${stats.psu.errorWord}`)
    }
  }

  // --- fans ----------------------------------------------------------------

  // Only meaningful while the miner should be cooling itself: a suspended
  // miner stops its fans on purpose, and a starting one runs them at full
  // tilt before settling.
  // A liquid-cooled miner reports no `Fan Count` and an empty fan list, which
  // is byte-for-byte what a miner whose every fan has died would report. The
  // rule currently passes on hydro hardware only because there is nothing to
  // iterate — correct by accident. Gating it explicitly means a future change
  // to the fan list cannot turn a water-cooled machine into a permanent
  // alert.fan_failure.
  if (running && !starting && liquidCooling !== true) {
    const stopped = stats.fans.filter((f) => f.speed === 0).map((f) => f.index)
    if (stopped.length) {
      add('alert.fan_failure', SEVERITY.alert, `fan(s) ${stopped.join(', ')} at 0 RPM while running — mechanical failure`)
    }
  }

  // --- hashboards ----------------------------------------------------------

  if (stats.boardsComplete) {
    const offline = stats.boards.filter((b) => b.online === false).map((b) => b.index)
    if (offline.length) {
      add('alert.hashboard_offline', SEVERITY.alert, `board(s) ${offline.join(', ')} not reporting`)
    }
    const lowHash = stats.boards.filter((b) => b.lowHash === true).map((b) => b.index)
    if (lowHash.length) {
      add('alert.hashboard_low_hash', SEVERITY.alert, `board(s) ${lowHash.join(', ')} report low hash`)
    }
    const badChip = stats.boards
      .filter((b) => b.badChipRatio !== null && b.badChipRatio > p.BAD_CHIP_RATIO_ALERT.value)
      .map((b) => `${b.index}=${(b.badChipRatio * 100).toFixed(1)}%`)
    if (badChip.length) {
      add('alert.bad_chip', SEVERITY.alert,
        `bad-chip ratio over ${(p.BAD_CHIP_RATIO_ALERT.value * 100).toFixed(0)}% on board(s) ${badChip.join(', ')}`)
    }
  }

  // --- pool ----------------------------------------------------------------

  if (stats.state.stratumDisconnect === true) {
    add('alert.pool_disconnected', SEVERITY.alert, 'firmware reports the stratum connection is down')
  } else if (Array.isArray(pools) && pools.length > 0 && !pools.some((pool) => pool.stratum.active === true)) {
    add('alert.pool_disconnected', SEVERITY.alert, 'no configured pool has an active stratum connection')
  }

  // --- firmware-reported fault --------------------------------------------

  if (stats.state.errorCode) {
    add('alert.device_error', SEVERITY.alert, `firmware error code ${stats.state.errorCode}`)
  }
  if (stats.state.errorChip) {
    add('alert.device_error', SEVERITY.alert, `firmware error chip ${stats.state.errorChip}`)
  }

  // --- performance ---------------------------------------------------------

  // Suppressed while tuning, and irrelevant when the miner is not hashing
  // at all — that case is already covered by info.suspended or a state alert.
  // Also suppressed during the post-restart ramp: observed on hardware
  // reporting alert.hashrate_low on a miner that had come back up seconds
  // earlier and was behaving correctly.
  const pr = stats.pr.avg
  if (running && !tuning && !starting && pr !== null && pr < p.HASHRATE_PR_ALERT_PCT.value) {
    add('alert.hashrate_low', SEVERITY.alert,
      `performance ratio ${pr.toFixed(1)}% below ${p.HASHRATE_PR_ALERT_PCT.value}% with no tuning in progress`)
  }

  // A failed state transition is a fault even though nothing else looks wrong.
  if (stats.state.pmState === 'resume_failed' || stats.state.pmState === 'suspend_failed') {
    add('alert.device_error', SEVERITY.alert, `power manager reports ${stats.state.pmState}`)
  }

  // Reject rate is informational: it usually indicts the pool or the network
  // rather than the miner, so it never degrades device health on its own.
  const rejectPct = summary?.rates?.poolRejectedPct
  if (rejectPct !== null && rejectPct !== undefined && rejectPct > 5) {
    add('warn.reject_rate_high', SEVERITY.warn, `pool reject rate ${rejectPct}%`)
  }

  return finish(details)
}

const finish = (details) => {
  const unreachable = details.some((d) => d.code === 'alert.unreachable')
  const degraded = details.some((d) => d.severity === SEVERITY.alert)
  return {
    status: unreachable ? 'OFFLINE' : degraded ? 'DEGRADED' : 'OK',
    alerts: [...new Set(details.filter((d) => d.severity === SEVERITY.alert).map((d) => d.code))],
    details,
    checkedAt: Date.now()
  }
}

module.exports = { evaluate, SEVERITY }
