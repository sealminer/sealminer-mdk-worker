'use strict'

const client = require('../client')

// Power-supply identity, electrical input/output, temperatures and error word.
module.exports = async () => (await client.stats()).psu
