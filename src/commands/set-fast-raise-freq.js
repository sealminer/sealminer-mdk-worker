'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')
const { describeSettingWrite } = require('./_write-result')

// The firmware takes the flag as the string "1" or "0"; a JSON boolean is
// refused with 'Missing "value"' and "true"/"false" with
// 'Invalid "enable_fast_raise_freq"'. lib/api-client.js does that conversion.
//
// Every write on this API is asynchronous: the firmware replies first and
// executes afterwards, so 'ASC 0 set OK' means ACCEPTED, not applied. This
// handler therefore never adjudicates whether the effect landed — it reports
// what was accepted and where to look for it. Confirming belongs to the
// caller, a telemetry cycle or two later.
//
// When it takes effect is not reported per device. Older builds store a
// mining setting and apply it at the next bdminer restart, and the API cannot
// read the pending value back, so that was a version-table guess rather than
// anything the device could answer. A lagging readback therefore means armed,
// not ignored — stated in the contract's constraints for this command.
const describeWrite = describeSettingWrite('snap.stats.settings.fastRaiseFreq')

module.exports = guard({
  name: 'setFastRaiseFreq',
  danger: DANGER.REVERSIBLE,
  cooldownMs: 60 * 1000,
  validate: (params) => ({ enabled: v.boolean(params, 'enabled') }),
  describe: (params) => describeWrite(params.enabled)
})(({ enabled }) => client.setFastRaiseFreq(enabled))
