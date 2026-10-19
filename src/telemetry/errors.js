'use strict'

const client = require('../client')
const { evaluate } = require('../../lib/health')

// Active faults, warnings and expected states, each with a severity. An empty
// array means the firmware reported nothing. info entries (tuning, suspended)
// are states rather than faults and must not be alerted on.
module.exports = async () => {
  const [stats, summary, pools] = await Promise.all([
    client.stats(),
    client.summary(),
    client.pools()
  ])
  return evaluate({ stats, summary, pools }).details
}
