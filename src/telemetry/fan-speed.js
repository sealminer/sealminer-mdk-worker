'use strict'

const client = require('../client')

// Highest fan speed across all fans, so a single stalled fan cannot be
// averaged away. Per-fan detail is in the fans channel. The firmware does
// not label intake vs exhaust, so no directional channels are published.
module.exports = async () => {
  const { fans } = await client.stats()
  const speeds = fans.map((f) => f.speed).filter((s) => s !== null)
  return speeds.length ? Math.max(...speeds) : null
}
