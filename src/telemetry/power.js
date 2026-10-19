'use strict'

const client = require('../client')

// Mains-side draw: stats PSU Input Power. PSU Output Power is the DC
// side and reads ~6% lower — billing and site totals want this one.
module.exports = async () => (await client.stats()).psu.inputPower
