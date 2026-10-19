'use strict'

const client = require('../client')
const db = require('../db')

// Recent samples from this worker's own SQLite store. The device is not
// contacted for the history itself.
//
// This handler is also where sampling happens, because Kernel's `metrics`
// pull invokes every telemetry channel on its own cadence — that pull *is*
// the sampling clock, and a worker never calls Kernel, so there is nothing
// else to drive it. The stats read below is served from the same single-
// flight cache the rest of that pull populated, so in the case that matters
// it costs no extra device I/O.
//
// Recording is best-effort: an unreachable miner, a full disk or a locked
// database must not turn a telemetry pull into a channel error. Reading is
// not best-effort — if the store cannot answer, the throw surfaces as a
// channel error rather than an empty array implying the miner has no history.
module.exports = async (params) => {
  try {
    const stats = await client.stats()
    db.recordSample({
      hashrateThs: stats.hashrate.m1,
      powerW: stats.psu.inputPower,
      temperatureC: stats.thermal.temp,
      powerMode: stats.state.miningMode,
      pmState: stats.state.pmState,
      health: stats.state.errorCode ? 'error' : null,
      firmware: stats.firmware.firmware
    })
  } catch {
    // Nothing recorded this cycle. The history below is still worth serving.
  }

  return db.recentSamples(params && params.limit)
}
