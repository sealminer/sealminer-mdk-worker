'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')
const { describeSettingWrite } = require('./_write-result')
const { supportsPowerMode } = require('../../lib/capabilities')
const { fail, ERR_MODE_NOT_SUPPORTED_ON_SERIES } = require('../../lib/errors')

// The settable modes are a subset of the reported ones: the firmware accepts
// low_power (A2 only), normal, high_performance and sleep (firmware-gated),
// while stats can also report ultra_low_power, custom and smartboost. A mode
// outside the settable set is refused by the device itself with
// 'Invalid work mode: <x>', confirmed on hardware.
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
//
// This is the command where the delay matters most: on a deferred-apply
// build, a miner set to sleep keeps hashing and keeps reporting its old mode,
// then stops the moment anything restarts bdminer. The pending flag in the
// result is the only warning the caller gets, so it is not optional.
const SETTABLE = ['low_power', 'normal', 'high_performance', 'sleep']

const describeWrite = describeSettingWrite('power_mode')

module.exports = guard({
  name: 'setPowerMode',
  danger: DANGER.REVERSIBLE,
  cooldownMs: 60 * 1000,
  // Static shape check here; the series/firmware narrowing needs the device.
  validate: (params) => ({ mode: v.string(params, 'mode', { enum: SETTABLE }) }),
  describe: (params) => describeWrite(params.mode)
})(async ({ mode }) => {
  const caps = await client.getCapabilities()
  if (!supportsPowerMode(caps, mode)) {
    fail(ERR_MODE_NOT_SUPPORTED_ON_SERIES,
      `${mode} is not accepted by series ${caps.series ?? 'unknown'} on firmware ${caps.firmware ?? 'unknown'}; accepted: ${caps.powerModes.join(', ')}`)
  }
  return client.setWorkMode(mode)
})
