'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')

// Stops mining and shuts down the PSU output and the fans. Because the fans
// stop, this is never the right response to overheating — reduce power
// instead. Recovery needs resume, or restartMiner on firmware without it.
module.exports = guard({
  name: 'suspend',
  danger: DANGER.DISRUPTIVE,
  cooldownMs: 60 * 1000
})(() => client.suspend())
