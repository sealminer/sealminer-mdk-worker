'use strict'

const client = require('../client')
const { evaluate } = require('../../lib/health')

// Overrides WorkerRuntimeV2's built-in health channel, which only echoes the
// device context. Tuning and suspended miners stay OK: treating an expected
// state as a fault is the most common source of false alarms in a fleet.
//
// A device that cannot be reached is reported as OFFLINE here rather than
// thrown, so a health pull always returns a usable verdict.
module.exports = async () => {
  try {
    const [stats, summary, pools, capabilities] = await Promise.all([
      client.stats(),
      client.summary(),
      client.pools(),
      // Cached alongside the rest, so this adds no device round trip on a
      // warm pull. It carries whether this firmware is newer than the
      // capability table, which health reports as warn.firmware_unverified.
      client.getCapabilities()
    ])
    return evaluate({ stats, summary, pools, capabilities })
  } catch (err) {
    return {
      ...evaluate({}),
      error: err.code || 'ERR_COMMAND_FAILED',
      detail: err.message
    }
  }
}
