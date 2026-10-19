'use strict'

const client = require('../client')

// Null rather than a short array when the stats reply was clipped: a partial
// list would understate how many boards the miner has, and a fleet view that
// silently loses a board is worse than one that reports "unknown".
// snap.truncated and warn.stats_truncated carry the reason.
module.exports = async () => client.boards()
