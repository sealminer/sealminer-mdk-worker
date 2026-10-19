'use strict'

const client = require('../client')

// Per-fan PWM and RPM. Fan count comes from the firmware’s Fan Count.
module.exports = async () => (await client.stats()).fans
