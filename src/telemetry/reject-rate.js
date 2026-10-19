'use strict'

const client = require('../client')

// summary Pool Rejected%. Usually indicts the pool, not the miner.
module.exports = async () => (await client.summary()).rates.poolRejectedPct
