'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')

// All four fields are REQUIRED, verified against a real A2 (firmware
// 2026040101): omitting any one is refused with 'Missing "<key>"', even
// though the API document presents temp/timeout as incidental. The client
// sends every value as a string, which the firmware also requires.
//
// The firmware does NOT enforce the documented 0..35 range on
// boot_preheat_temp — "99" is accepted — so the range declared in the
// contract and checked here is the only protection there is.
//
// bootPreheatTimeout is -1 ("wait until the target temperature is reached",
// still capped at 600s by the firmware) or at least 300; the firmware
// silently raises anything in 0..300 to 300, so that range is rejected here
// rather than accepted and quietly changed.
const { describeBlindWrite } = require('./_write-result')

const describeWrite = describeBlindWrite('the preheat settings')

module.exports = guard({
  name: 'setPreheat',
  danger: DANGER.REVERSIBLE,
  cooldownMs: 30 * 1000,
  validate: (params) => ({
    enableBootPreheat: v.boolean(params, 'enableBootPreheat'),
    // Both bounds are the vendor document's own (section 4.1.6), not guesses.
    // The firmware does NOT enforce the temperature itself — 99 is accepted —
    // so this check is the only thing honouring the documented limit. And a
    // positive timeout in 0-300 is silently RAISED to 300 by the firmware, so
    // that band is refused here rather than accepted and quietly changed.
    bootPreheatTemp: v.number(params, 'bootPreheatTemp', { min: 0, max: 35 }),
    bootPreheatTimeout: v.number(params, 'bootPreheatTimeout', { min: 300, max: 600, allow: [-1] }),
    enableTunePreheat: v.boolean(params, 'enableTunePreheat')
  }),
  describe: (params) => describeWrite(params)
})((p) => client.setPreheat({
  enable_boot_preheat: p.enableBootPreheat,
  boot_preheat_temp: p.bootPreheatTemp,
  boot_preheat_timeout: p.bootPreheatTimeout,
  enable_tune_preheat: p.enableTunePreheat
}))
