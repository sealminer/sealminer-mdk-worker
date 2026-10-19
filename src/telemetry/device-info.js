'use strict'

const client = require('../client')

// Identity plus the resolved series, and which source resolved it: a site
// that declares series in its device config always wins over inferring it
// from the model string, whose mapping is still incomplete.
module.exports = async () => {
  const [s, caps] = await Promise.all([client.stats(), client.getCapabilities()])
  return {
    model: s.identity.model,
    series: caps.series,
    seriesResolved: caps.seriesResolved,
    seriesSource: caps.seriesSource,
    asic: s.identity.asic,
    mac: s.identity.mac,
    ip: s.identity.ip,
    // A real A2 reports Pools Locked: true. When it is set, setupPools will
    // be refused by the firmware, so surfacing it saves a failed write.
    poolsLocked: s.settings.poolsLocked,
    ctrlBoard: s.identity.ctrlBoard,
    ctrlBoardSn: s.identity.ctrlBoardSn
  }
}
