'use strict'

// PROVISIONAL CONSTANTS — placeholders awaiting confirmation from SealMiner,
// collected in one module so that confirming a value is a one-line change.
// The validator prints a loud warning for each entry still provisional.
//
// Two kinds of value live here, and the difference matters:
//
//   PARAMETER ENVELOPES bound a writable setting. They exist because MDK's
//   build guide requires the handler to reject out-of-range values, and
//   because nothing else does: the firmware answers 'ASC 0 set OK' to
//   settings it silently ignores, so it does not range-check at all.
//   The error is therefore one-sided. Too wide only catches a typo; too
//   narrow refuses a legitimate setting, which has happened twice against
//   real hardware. These are deliberately generous, and narrowing one is a
//   breaking change for a caller that reads a value and writes it back.
//
//   HEALTH THRESHOLDS are the points at which this worker raises an alert.
//   Those are its own judgement to make, and wrong in either direction:
//   too low is a false alarm, too high misses a fault.
//
// Bounds the vendor document actually states are NOT here — preheat's
// temperature and timeout and the fan speed percentage are in the contract
// with the document's own numbers, because they are not guesses.
//
// Do not scatter these numbers into handlers or the contract.

/**
 * `ascset powerlimit` envelope, in watts. A GUESS, and deliberately wide.
 *
 * THE RANGE CANNOT BE ESTABLISHED ON HARDWARE. `ascset powerlimit` answers
 * code 119 "ASC 0 set OK" for every value — 3000, 4200 and 4400 were all
 * accepted on a real A2 — and changes nothing. The firmware does not range
 * check, so its accepted range cannot be probed by observing what it
 * refuses, because it refuses nothing.
 *
 * So this bound is not a measurement and cannot be one. It is this layer's
 * own guard against a typo, which MDK's build guide requires and Kernel
 * enforces pre-dispatch. Its only real failure mode is being too NARROW: a
 * caller that reads power_limit and writes the same value back must not be
 * refused. That has happened twice — [1500, 4200] against a shipped A2 at
 * 4300 W, then 4600 against an A4 Ultra Hydro at 10800 W.
 *
 * The maximum is 20000 W, which is well above anything measured (10800 W on
 * an A4 Ultra Hydro) and chosen that way on purpose. 12000 was tried first
 * and left only about 11% of headroom, which is the same thin margin that
 * caused both earlier failures — and products do shift upward: an A2 Pro
 * Hydro moved from 7800 to 9500 W across a single firmware upgrade. At 20000
 * the bound still rejects a typo (a missing or extra digit) while leaving no
 * plausible product outside it. Widening again is safe; narrowing is a
 * breaking change for a caller that reads a value and writes it back.
 *
 * TODO(sealminer-firmware): confirm whether a value the firmware will not
 * apply can be refused at the device instead of accepted. That, rather than a
 * bound declared up here, is what would make the firmware the authority in
 * fact.
 */
const POWER_LIMIT_W = { min: 2000, max: 20000, confirmed: false }

/**
 * `ascset stratum-disconnect-timeout` envelope, in seconds. A GUESS.
 * The document shows a value of 120 and states no range, so this is one
 * second to one day — wide enough to be a typo guard and nothing more. The
 * previous 30..3600 was narrower with no evidence behind either end.
 * TODO(sealminer-hardware): confirm the accepted range.
 */
const STRATUM_DISCONNECT_TIMEOUT_S = { min: 1, max: 86400, confirmed: false }

/**
 * `ascset idle-fan-timer` envelopes, in seconds. GUESSES, and previously an
 * oversight: the contract carried 1..3600 and 0..3600 while nothing here
 * declared them, so they were unmarked guesses that `unconfirmed()` never
 * listed. The document gives the units and the three behaviours but no
 * numeric range; only `speed` is documented (0..100, in the contract).
 * TODO(sealminer-hardware): confirm the accepted interval range.
 */
const IDLE_FAN_TIMER_INTERVAL_S = { min: 1, max: 86400, confirmed: false }
const IDLE_FAN_TIMER_ON_DURATION_S = { min: 0, max: 86400, confirmed: false }

/**
 * Power limits read from real hardware, per product:
 *
 *   A2               4300 W   firmware 2026040101   air
 *   A3 Air           4300 W   firmware 2026073000   air
 *   A4 Pro Air       4300 W   firmware 20260915FF   air
 *   A2 Pro Hydro     9500 W   firmware 2026092000   water
 *   A3 Pro Hydro    10000 W   firmware 2026091400   water
 *   A4 Ultra Hydro  10800 W   firmware 2026083100   water
 *
 * The A2 Pro Hydro settles the question of whether a per-device range could
 * ever replace the envelope. It was read twice in one session: 7800 W on
 * firmware 2026071500, then 9500 W on 2026092000 after an upgrade landed
 * under us mid-session. The same physical miner changed its own power limit
 * across a firmware upgrade, so even a range pinned per device would go
 * stale without anyone touching the machine.
 *
 * This range has now been wrong twice in the same way, and the failure mode is
 * worth stating once: the contract's declared min/max is what **Kernel**
 * validates against before dispatch, and it is static — one declaration for
 * every model this worker supports. If a shipped miner is already set above
 * the declared max, then reading `power_limit` and writing the same number
 * back is refused with ERR_PARAM_RANGE. A perfectly ordinary round-trip
 * becomes impossible.
 *
 * First it was [1500, 4200] against an A2 sitting at 4300. Widening it to
 * 4600 fixed the A2 and still excluded the A4 Ultra Hydro at 10800 — a
 * water-cooled machine drawing 2.5x the air-cooled models — because at that
 * point no A4 had been measured. The pattern that has since held on six
 * products is that cooling, not series, sets the scale: every air product
 * measured sits at 4300 W and every water one between 9500 and 10800 W.
 *
 * So the declared range is deliberately an ENVELOPE across every supported
 * product, not any one product's real range. It is Kernel's coarse outer
 * guard; it cannot be per-device, because the contract is published once for
 * the whole family. tests/unit/provisional.test.js asserts the envelope
 * contains every observed value.
 *
 * The API document is no help here, and this has now been checked end to
 * end: SealMinerAPI_V0.5 §4.1.3 is three lines — a one-sentence summary, the
 * send format {"value":"power_value"}, and a reply example. No range, no
 * units, and no per-model or per-cooling distinction. The document
 * differentiates products in exactly one place, §4.1.4's mining-mode lists
 * (A2 has low_power, A3 and A4 do not), and nowhere else. `Liquid Cooling`
 * appears only as a bare line in a sample reply, never explained, and
 * `Power Limit` itself is absent from the document's stats example although
 * every measured miner reports it.
 *
 * Confirmed 2026-09-24 by Bitdeer engineering: the accepted range does
 * differ between air-cooled and water-cooled products, which matches the
 * measurements above (air 4300 W, water 9500-10800 W). The exact per-product
 * bounds are still needed.
 *
 * TODO(sealminer-firmware): the true per-product accepted range. Until then
 * no per-series ceiling is enforced: inventing one would reject legitimate
 * settings on hardware nobody here has measured, which is the opposite of
 * the bug being fixed.
 */
const OBSERVED_POWER_LIMITS_W = {
  A2: 4300,
  'A3 Air': 4300,
  'A4 Pro Air': 4300,
  'A2 Pro Hydro': 9500,
  'A3 Pro Hydro': 10000,
  'A4 Ultra Hydro': 10800
}

/** Highest power limit seen on real hardware; the envelope must contain it. */
const OBSERVED_POWER_LIMIT_W = Math.max(...Object.values(OBSERVED_POWER_LIMITS_W))

/**
 * Values a real A2 (firmware 2026040101) reported as accepted while changing
 * nothing. Kept so the finding is not lost: it is the reason
 * src/commands/set-power-limit.js verifies by readback instead of trusting
 * the reply.
 */
const OBSERVED_INERT_POWER_LIMITS_W = [3000, 4200, 4400]

/**
 * Maximum pools accepted by `updatepools`. RECORDED, NOT ENFORCED: nothing
 * caps the list any more — `updatepools` answers code 201 or 8 when it
 * refuses one. Kept because the contract's prose cites it.
 *
 * CONFIRMED 2026-09-24 by Bitdeer engineering: the limit is three.
 *
 * The API document does not state it — SealMinerAPI_V0.5 §3.5.7 says only
 * "at least one pool and the priority decided by the order" — but §3.3's
 * own `config` example reports "Pool Count":3, and the A2, A3 and A4
 * measured here were each running three.
 */
const MAX_POOLS = { value: 3, confirmed: true }

/**
 * PSU hot-spot temperature that raises alert.psu_overheat, in Celsius.
 *
 * NOTE: no measured product reports "PSU Temp HOT" at all — only
 * "PSU Temp AMB" (ambient). Checked on all six products across six builds,
 * 2026040101 through 20260915FF, air and water cooled: every one reports
 * ambient only, so psu_info.tempHot is null and this alert cannot fire on
 * any of them.
 *
 * The threshold is kept for firmware that does report a hot spot, and the
 * alert-coverage test reaches it by injecting the fault, which synthesises
 * the field. That proves the code path, not that the condition occurs: the
 * mock emits "PSU Temp HOT" only under an injected fault, deliberately
 * matching firmware that never sends it.
 *
 * Observed ambient, for scale: 27-33C on the air products, 49-56C on the
 * water-cooled ones, and 71C on an A4 Ultra Hydro. Ambient is NOT compared
 * against this constant — it is a different measurement, and reusing a
 * hot-spot limit for it would alert on healthy hydro machines.
 * TODO(sealminer-hardware): confirm which builds report a hot-spot
 * temperature, and its derating/alarm point.
 */
const PSU_TEMP_HOT_ALERT_C = { value: 80, confirmed: false }

/**
 * Bad-chip ratio that raises alert.bad_chip (0..1).
 * TODO(sealminer-hardware): confirm the ratio at which a board needs service.
 */
const BAD_CHIP_RATIO_ALERT = { value: 0.05, confirmed: false }

/**
 * Hashrate performance ratio (PR, percent) below which alert.hashrate_low
 * fires — suppressed while the miner is tuning.
 * TODO(sealminer-hardware): confirm the acceptable steady-state PR floor.
 */
const HASHRATE_PR_ALERT_PCT = { value: 90, confirmed: false }

/**
 * Degrees above `Target Ctrl Temp` that raise alert.overheat.
 * TODO(sealminer-hardware): confirm the intervention threshold.
 */
const OVERHEAT_MARGIN_C = { value: 5, confirmed: false }

/**
 * Absolute overheat threshold for LIQUID-cooled miners, in degrees C.
 *
 * Air-cooled models regulate the reported `Temp` to within a degree of
 * `Target Ctrl Temp` (A2: 70/70, A3 Air: 66/65, A4 Pro Air: 70/70), so the
 * target-relative rule works for them. Water-cooled models do not track the
 * target at all: measured healthy, all in fine_tuning_done, an A2 Pro Hydro
 * runs 46C against a target of 60, an A3 Pro Hydro 50C against 60, and an
 * A4 Ultra Hydro 67C against 60 — spanning 21C, on both sides of the target.
 * The shared rule raised alert.overheat on a production miner.
 *
 * An absolute threshold is used instead. Half of the uncertainty is now
 * settled and half is not. Three healthy hydro machines sit between 46C and
 * 67C, so 85C is comfortably clear of normal operation and will not
 * false-alarm — that part is evidenced. Whether it is LOW enough to catch a
 * real thermal fault is still a GUESS: it has never been validated against
 * an actually overheating water-cooled miner. It is deliberately not pulled
 * down to just above the observed 67C, because a thermal alarm that fires
 * during normal load variation is one operators learn to ignore.
 *
 * TODO(sealminer-firmware): the real thermal limit for the hydro models, and
 * what `Target Ctrl Temp` is supposed to mean on them — if it is the water
 * inlet target rather than a chip target, the right rule is a different
 * comparison rather than a different constant.
 */
const LIQUID_OVERHEAT_ALERT_C = { value: 85, confirmed: false }

/**
 * Seconds after a bdminer restart during which low hashrate is expected, so
 * alert.hashrate_low stays suppressed.
 *
 * Observed on a real A2: recovering from suspend took about 4.5 minutes
 * before the API answered at all, and hashrate then climbed from 52 TH/s
 * toward 240 over several more minutes. Reported as info.starting meanwhile.
 * TODO(sealminer-hardware): confirm the worst-case ramp for each series.
 */
const STARTUP_RAMP_S = { value: 900, confirmed: false }

const ALL = {
  STARTUP_RAMP_S,
  POWER_LIMIT_W,
  STRATUM_DISCONNECT_TIMEOUT_S,
  IDLE_FAN_TIMER_INTERVAL_S,
  IDLE_FAN_TIMER_ON_DURATION_S,
  MAX_POOLS,
  PSU_TEMP_HOT_ALERT_C,
  BAD_CHIP_RATIO_ALERT,
  HASHRATE_PR_ALERT_PCT,
  OVERHEAT_MARGIN_C,
  LIQUID_OVERHEAT_ALERT_C
}

/** Names of the constants still awaiting confirmation. */
const unconfirmed = () =>
  Object.entries(ALL).filter(([, v]) => v.confirmed !== true).map(([k]) => k)

module.exports = {
  STARTUP_RAMP_S,
  POWER_LIMIT_W,
  STRATUM_DISCONNECT_TIMEOUT_S,
  IDLE_FAN_TIMER_INTERVAL_S,
  IDLE_FAN_TIMER_ON_DURATION_S,
  OBSERVED_POWER_LIMIT_W,
  OBSERVED_POWER_LIMITS_W,
  OBSERVED_INERT_POWER_LIMITS_W,
  MAX_POOLS,
  PSU_TEMP_HOT_ALERT_C,
  BAD_CHIP_RATIO_ALERT,
  HASHRATE_PR_ALERT_PCT,
  OVERHEAT_MARGIN_C,
  LIQUID_OVERHEAT_ALERT_C,
  ALL,
  unconfirmed
}
