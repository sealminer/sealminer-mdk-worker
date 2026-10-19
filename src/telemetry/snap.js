'use strict'

const client = require('../client')

// Full structured snapshot plus freshness metadata. Because the runtime pulls
// every channel on a fixed cadence, device reads are briefly cached and
// shared; ts/cached/ageMs let a consumer judge how stale this view is, and
// truncated/boardsComplete say whether the miner answered in full.
module.exports = async () => client.snapshot()
