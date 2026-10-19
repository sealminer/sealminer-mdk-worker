'use strict'

const { id, opts, config, logger } = require('@tetherto/mdk-worker/device')
const { createClient } = require('../lib/api-client')

// WorkerRuntimeV2 loads this file into a private module registry per device,
// so binding straight to the ambient device context here — rather than
// exporting a factory for a caller to invoke — already yields exactly one
// client per device, with its cache and connection state scoped to that one
// miner. Nothing probes the device at load time; an unreachable miner
// surfaces from the first handler call that touches the network.
//
// The SealMiner 4028 API takes no credentials, so nothing secret is logged
// here. If a future firmware adds authentication, read it from `env`, never
// from `opts`, and keep it out of this log line.
logger('device %s: %o', id, {
  address: opts.address || opts.host,
  port: opts.port ?? 4028,
  series: opts.series ?? null
})

module.exports = createClient({
  host: opts.address || opts.host,
  port: opts.port,
  timeoutMs: opts.timeoutMs ?? config.timeoutMs,
  // Declared by the site in devices.json. Wins over inferring the series
  // from stats.Model, whose mapping is still incomplete.
  series: opts.series,
  cacheTtlMs: opts.cacheTtlMs ?? config.cacheTtlMs,
  poolsCacheTtlMs: opts.poolsCacheTtlMs ?? config.poolsCacheTtlMs,
  // Per-chip data is ~6500 keys on production hardware and has no telemetry
  // value; diagnostic tooling turns it on through the device config.
  parseChips: opts.parseChips === true,
  logger
})
