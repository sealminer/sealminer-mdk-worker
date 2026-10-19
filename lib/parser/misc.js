'use strict'

const n = require('./normalize')

/**
 * `version` reply (doc 3.1).
 *
 * The document spells the key `Bdminer`; a real A2 on firmware 2026040101
 * returns `BDMiner`. Accept both rather than silently reporting null.
 */
const parseVersion = (raw) => ({
  bdminer: n.toString(raw?.BDMiner ?? raw?.Bdminer),
  api: n.toString(raw?.API)
})

/** `config` reply (doc 3.3). */
const parseConfig = (raw) => ({
  ascCount: n.toNumber(raw?.['ASC Count']),
  pgaCount: n.toNumber(raw?.['PGA Count']),
  poolCount: n.toNumber(raw?.['Pool Count']),
  strategy: n.toString(raw?.Strategy),
  logInterval: n.toNumber(raw?.['Log Interval']),
  deviceCode: n.toString(raw?.['Device Code']),
  os: n.toString(raw?.OS),
  hotplug: n.toString(raw?.Hotplug)
})

/** `devdetails` reply (doc 3.6). */
const parseDevDetails = (raw) => ({
  name: n.toString(raw?.Name),
  id: n.toNumber(raw?.ID),
  driver: n.toString(raw?.Driver),
  model: n.toString(raw?.Model),
  kernel: n.toString(raw?.Kernel)
})

module.exports = { parseVersion, parseConfig, parseDevDetails }
