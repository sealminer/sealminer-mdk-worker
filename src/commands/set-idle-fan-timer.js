'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')
const P = require('../../lib/provisional')
const { fail, ERR_PARAM_RANGE } = require('../../lib/errors')

// Firmware-gated (2025081801+). onDuration must not exceed interval: the
// firmware's own semantics are "run for onDuration out of every interval
// seconds", so a larger onDuration has no meaning.
const { describeBlindWrite } = require('./_write-result')

const describeWrite = describeBlindWrite('the idle fan timer')

module.exports = guard({
  name: 'setIdleFanTimer',
  danger: DANGER.REVERSIBLE,
  cooldownMs: 30 * 1000,
  validate: (params) => {
    // speed's 0-100 is the vendor document's own number. The two second
    // counts are wide envelopes: the document gives units and behaviour but
    // no numeric range, so they are typo guards.
    const interval = v.number(params, 'interval', { ...P.IDLE_FAN_TIMER_INTERVAL_S, integer: true })
    const onDuration = v.number(params, 'onDuration', { ...P.IDLE_FAN_TIMER_ON_DURATION_S, integer: true })
    const speed = v.number(params, 'speed', { min: 0, max: 100, integer: true })
    if (onDuration > interval) {
      fail(ERR_PARAM_RANGE, `onDuration ${onDuration} exceeds interval ${interval}`)
    }
    return { interval, onDuration, speed }
  },
  describe: (params) => describeWrite(params)
})(({ interval, onDuration, speed }) => client.setIdleFanTimer({
  // The firmware takes these as strings (doc 4.1.12).
  interval: String(interval),
  on_duration: String(onDuration),
  speed: String(speed)
}))
