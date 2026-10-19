'use strict'

const client = require('../client')

// stats W/T(Avg) is already W/TH, so there is nothing to derive.
module.exports = async () => (await client.stats()).wattsPerTh.avg
