'use strict'

const client = require('../client')

// Average hashrate since boot: stats MHS(Avg) in TH/s.
module.exports = async () => (await client.stats()).hashrate.avg
