'use strict'

const client = require('../client')

// Power-manager state. Only "running" means the miner is hashing;
// "suspended" is operator-requested, not a fault.
module.exports = async () => (await client.stats()).state.pmState
