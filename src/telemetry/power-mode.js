'use strict'

const client = require('../client')

// Canonical mode token, or null on firmware that reports this field as an
// undocumented integer (see lib/parser/legacy-enums.js).
module.exports = async () => (await client.stats()).state.miningMode
