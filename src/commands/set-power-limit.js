'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')
const { describeSettingWrite } = require('./_write-result')
const { POWER_LIMIT_W } = require('../../lib/provisional')

// RANGE IS ENFORCED HERE, and only here. MDK's build guide requires it —
// "the command handler must reject missing, wrong-type, out-of-range, or
// disallowed values" — and nothing else does: the firmware answers
// 'ASC 0 set OK' to settings it silently ignores, so it does not range-check
// at all. A real A2 accepted 3000, 4200 and 4400 W and changed nothing.
//
// That makes the bound a typo guard rather than a correctness guarantee, and
// makes the error one-sided: too wide only catches absurd values, too narrow
// refuses a legitimate setting. The latter has happened twice, so the
// envelope in lib/provisional.js is deliberately generous. A success reply
// still proves nothing about the value having applied — that is what the
// power_limit readback named by confirmWith is for.
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
const describeWrite = describeSettingWrite('power_limit')

module.exports = guard({
  name: 'setPowerLimit',
  danger: DANGER.REVERSIBLE,
  cooldownMs: 60 * 1000,
  validate: (params) => ({ watts: v.number(params, 'watts', POWER_LIMIT_W) }),
  describe: (params) => describeWrite(params.watts)
})(({ watts }) => client.setPowerLimit(watts))
