'use strict'

const client = require('../client')

// Real-time hashrate: stats MHS(1m), already converted to TH/s.
module.exports = async () => (await client.stats()).hashrate.m1
