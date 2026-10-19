'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')
const { MAX_POOLS } = require('../../lib/provisional')

// Changes where the miner's work is credited. Kernel does not validate
// object parameters at all, so the whole shape is checked here: every entry
// needs a stratum URL and a worker name, and the list is capped.
module.exports = guard({
  name: 'setupPools',
  danger: DANGER.DISRUPTIVE,
  cooldownMs: 30 * 1000,
  // Three, confirmed by Bitdeer engineering. The document says only "at least
  // one pool"; its own config example reports "Pool Count":3.
  validate: (params) => ({ pools: v.poolList(params.pools, MAX_POOLS.value) })
})(({ pools }) => client.updatePools(pools))
