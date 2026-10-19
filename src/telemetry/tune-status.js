'use strict'

const client = require('../client')

// Tuning stage. While coarse_tuning/fine_tuning, low hashrate is expected
// and health suppresses alert.hashrate_low.
module.exports = async () => (await client.stats()).state.tuneStatus
