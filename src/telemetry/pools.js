'use strict'

const client = require('../client')

// Configured pools with status, priority, stratum state and share counters.
// The parser maps no password field, so none can reach a consumer.
module.exports = async () => client.pools()
