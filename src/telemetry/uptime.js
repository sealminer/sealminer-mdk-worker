'use strict'

const client = require('../client')

// Seconds since the controller booted. Survives restartMiner.
module.exports = async () => (await client.stats()).state.systemUptime
