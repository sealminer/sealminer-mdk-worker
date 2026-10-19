'use strict'

const n = require('./normalize')

// Keys that could carry a secret. The 4028 `pools` reply does not document a
// password field, but an allowlist-shaped parser is the wrong place to rely
// on that: anything not mapped below simply never leaves this module.
const ALIVE = 'alive'

/**
 * Normalize one entry of a raw `pools` reply (doc 3.5.1).
 * Pool passwords are never mapped, so they can never reach a consumer.
 */
const parsePool = (p) => ({
  index: n.toNumber(p.POOL),
  url: n.toString(p.URL),
  status: n.toString(p.Status) ? n.tokenize(p.Status) : null,
  priority: n.toNumber(p.Priority),
  quota: n.toNumber(p.Quota),
  // Pool worker name. Operators need it to tell accounts apart; it is not a
  // credential. No password field is mapped anywhere in this file.
  user: n.toString(p.User),
  stratum: {
    has: n.toBoolean(p['Has Stratum']),
    active: n.toBoolean(p['Stratum Active']),
    url: n.toString(p['Stratum URL']),
    difficulty: n.toNumber(p['Stratum Difficulty'])
  },
  shares: {
    accepted: n.toNumber(p.Accepted),
    rejected: n.toNumber(p.Rejected),
    stale: n.toNumber(p.Stale),
    discarded: n.toNumber(p.Discarded),
    works: n.toNumber(p.Works),
    getworks: n.toNumber(p.Getworks),
    diff1Shares: n.toNumber(p['Diff1 Shares'])
  },
  failures: {
    get: n.toNumber(p['Get Failures']),
    remote: n.toNumber(p['Remote Failures']),
    badWork: n.toNumber(p['Bad Work'])
  },
  rejectedPct: n.toNumber(p['Pool Rejected%']),
  stalePct: n.toNumber(p['Pool Stale%']),
  bestShare: n.toNumber(p['Best Share']),
  lastShareTime: n.toNumber(p['Last Share Time']),
  currentBlockHeight: n.toNumber(p['Current Block Height'])
})

const parsePools = (raw) => (Array.isArray(raw) ? raw.map(parsePool) : [])

/**
 * The pool the miner is actually mining to: the stratum-active one, else the
 * alive one with the highest priority (lowest Priority value).
 * @returns {object|null}
 */
const activePool = (pools) => {
  if (!Array.isArray(pools) || pools.length === 0) return null
  const active = pools.find((p) => p.stratum.active === true)
  if (active) return active
  const alive = pools
    .filter((p) => p.status === ALIVE)
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
  return alive[0] || null
}

module.exports = { parsePools, parsePool, activePool }
