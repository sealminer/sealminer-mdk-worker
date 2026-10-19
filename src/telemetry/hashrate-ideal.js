'use strict'

const client = require('../client')

// What the firmware targets for the active mode: stats MHS(Ideal).
// The right denominator for achievement; MHS(Rated) is the nameplate.
module.exports = async () => (await client.stats()).hashrate.ideal
