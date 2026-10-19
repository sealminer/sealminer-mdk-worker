'use strict'

const client = require('../client')

// The power ceiling the firmware is currently enforcing, from stats
// Power Limit. Absent from the API document but present on real hardware,
// and the only readback for setPowerLimit — which makes that command
// verifiable instead of merely assertable. Null on firmware that does not
// report it.
module.exports = async () => (await client.stats()).settings.powerLimit
