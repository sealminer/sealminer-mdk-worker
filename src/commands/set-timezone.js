'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')

// IANA zone name, e.g. America/New_York. No physical effect and fully
// reversible, which makes it the right first write to try against real
// hardware (see scripts/test-live-timezone.js).
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/

const { describeBlindWrite } = require('./_write-result')

const describeWrite = describeBlindWrite('the timezone')

module.exports = guard({
  name: 'setTimezone',
  danger: DANGER.SAFE,
  exclusive: false,
  validate: (params) => ({ tz: v.string(params, 'tz', { pattern: IANA_ZONE, maxLength: 64 }) }),
  describe: (params) => describeWrite(params)
})(({ tz }) => client.setTimezone(tz))
