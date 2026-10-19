'use strict'

const client = require('../client')

// Control temperature the firmware regulates against: stats Temp.
// Per-board temperatures live in the hashboards channel.
module.exports = async () => (await client.stats()).thermal.temp
