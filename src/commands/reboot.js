'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')

// Reboots the controller, not just the mining process. 5 minutes between
// attempts, enforced here rather than only declared in the contract.
module.exports = guard({
  name: 'reboot',
  danger: DANGER.DISRUPTIVE,
  cooldownMs: 5 * 60 * 1000
})(() => client.reboot())
