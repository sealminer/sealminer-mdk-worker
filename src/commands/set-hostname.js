'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')

// Firmware-gated (2025062602+). RFC 1123 label: letters, digits and hyphens,
// not starting or ending with a hyphen, at most 63 characters.
const { describeBlindWrite } = require('./_write-result')

const describeWrite = describeBlindWrite('the hostname')

module.exports = guard({
  name: 'setHostname',
  danger: DANGER.REVERSIBLE,
  cooldownMs: 30 * 1000,
  validate: (params) => ({
    hostname: v.string(params, 'hostname', { pattern: v.HOSTNAME, maxLength: 63 })
  }),
  describe: (params) => describeWrite(params)
})(({ hostname }) => client.setHostname(hostname))
