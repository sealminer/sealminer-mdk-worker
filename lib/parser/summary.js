'use strict'

const n = require('./normalize')

/**
 * Normalize a raw `summary` reply (doc 3.2).
 * Hashrate fields are MH/s and become TH/s; share counters stay as counts.
 */
const parseSummary = (raw) => {
  const s = raw || {}
  return {
    elapsed: n.toNumber(s.Elapsed),
    hashrate: {
      avg: n.mhsToThs(s['MHS av']),
      s5: n.mhsToThs(s['MHS 5s']),
      m1: n.mhsToThs(s['MHS 1m']),
      m5: n.mhsToThs(s['MHS 5m']),
      m15: n.mhsToThs(s['MHS 15m'])
    },
    shares: {
      accepted: n.toNumber(s.Accepted),
      rejected: n.toNumber(s.Rejected),
      stale: n.toNumber(s.Stale),
      discarded: n.toNumber(s.Discarded),
      hardwareErrors: n.toNumber(s['Hardware Errors']),
      getworks: n.toNumber(s.Getworks),
      foundBlocks: n.toNumber(s['Found Blocks'])
    },
    rates: {
      utility: n.toNumber(s.Utility),
      workUtility: n.toNumber(s['Work Utility']),
      deviceHardwarePct: n.toNumber(s['Device Hardware%']),
      deviceRejectedPct: n.toNumber(s['Device Rejected%']),
      poolRejectedPct: n.toNumber(s['Pool Rejected%']),
      poolStalePct: n.toNumber(s['Pool Stale%'])
    },
    difficulty: {
      accepted: n.toNumber(s['Difficulty Accepted']),
      rejected: n.toNumber(s['Difficulty Rejected']),
      stale: n.toNumber(s['Difficulty Stale']),
      bestShare: n.toNumber(s['Best Share'])
    },
    networkBlocks: n.toNumber(s['Network Blocks']),
    lastGetwork: n.toNumber(s['Last getwork'])
  }
}

module.exports = { parseSummary }
