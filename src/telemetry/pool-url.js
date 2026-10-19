'use strict'

const client = require('../client')
const { activePool } = require('../../lib/parser/pools')

// The pool the miner is actually mining to. Null means no pool is alive,
// which is a real alarm rather than missing data — see alert.pool_disconnected.
module.exports = async () => {
  const pool = activePool(await client.pools())
  if (!pool) return null
  return pool.stratum.url || pool.url
}
