'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')

// Restarts bdminer only; system uptime survives. Also the documented
// fallback for resume on firmware where resume was removed.
module.exports = guard({
  name: 'restartMiner',
  danger: DANGER.DISRUPTIVE,
  cooldownMs: 60 * 1000
})(() => client.restartMiner())
