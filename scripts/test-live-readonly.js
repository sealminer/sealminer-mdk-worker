#!/usr/bin/env node
'use strict'

// Read-only check against real hardware, through the real runtime.
//
//   MDK_REPO=../mdk node scripts/test-live-readonly.js <address> [--port 4028] [--series A2]
//
// Drives a real MDK telemetry envelope into WorkerRuntimeV2 and fails if ANY
// channel reports an error. Sends no write command: no reboot, no mode
// change, no pool, network or firmware operation. Safe against a producing
// miner.

const path = require('node:path')

const address = process.argv[2]
const argv = process.argv.slice(3)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

if (!address) {
  console.error('usage: MDK_REPO=../mdk node scripts/test-live-readonly.js <address> [--port 4028] [--series A2]')
  process.exit(1)
}

const MDK_REPO = process.env.MDK_REPO
  ? path.resolve(process.env.MDK_REPO)
  : path.resolve(__dirname, '../../mdk')

const WorkerRuntimeV2 = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/worker-runtime-v2'))
const WORKER_DIR = path.resolve(__dirname, '..')
const deviceId = `sealminer-${address.replaceAll('.', '-')}`

const envelope = (type) => ({
  id: `live-readonly-${type}`,
  version: '0.2.0',
  type: 'request',
  action: 'telemetry.pull',
  sender: 'sealminer-live-readonly',
  target: 'sealminer-live-readonly',
  deviceId,
  timestamp: Date.now(),
  payload: { query: { type } }
})

const main = async () => {
  const config = { address, series: flag('series', undefined) }
  if (flag('port')) config.port = Number(flag('port'))

  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'sealminer-live-readonly',
    devices: [{ deviceId, config }]
  })

  try {
    await runtime.start()
    const response = await runtime.handleRequest(envelope('metrics'))
    const m = response.payload.metrics

    const failed = Object.entries(m).filter(([, v]) => v && typeof v === 'object' && v.error)
    if (failed.length > 0) {
      throw new Error(`ERR_READONLY_CHANNELS_FAILED: ${failed.map(([k, v]) => `${k}=${v.error}`).join(', ')}`)
    }

    console.log(JSON.stringify({
      address,
      series: m.capabilities?.series,
      seriesResolved: m.capabilities?.seriesResolved,
      model: m.device_info?.model,
      firmware: m.firmware_info?.firmware,
      bdminer: m.firmware_info?.bdminer,
      hashrateRtThs: m.hashrate_rt,
      hashrateIdealThs: m.hashrate_ideal,
      performanceRatioPct: m.hashrate_pr,
      powerW: m.power,
      efficiencyWTh: m.efficiency,
      temperatureC: m.temperature,
      fanSpeedRpm: m.fan_speed,
      powerMode: m.power_mode,
      status: m.status,
      tuneStatus: m.tune_status,
      uptimeS: m.uptime,
      poolUrl: m.pool_url,
      boards: m.hashboards === null ? 'TRUNCATED' : m.hashboards.length,
      fans: m.fans?.length,
      statsTruncated: m.snap?.truncated,
      liquidCooling: m.firmware_info?.liquidCooling,
      health: m.health?.status,
      alerts: m.health?.alerts,
      // `alerts` carries alert severity only, so on its own it hides exactly
      // the lines a live check is run to see — warn.firmware_unverified on a
      // build newer than the capability table, info.liquid_cooled on a
      // water-cooled machine. Report every detail, severity included.
      healthDetails: (m.health?.details || []).map((d) => `[${d.severity}] ${d.code}: ${d.detail}`),
      // Whether the verdicts below were asked of the device or assumed from
      // the version table.
      capabilitySource: m.capabilities?.capabilitySource,
      firmwareNewerThanKnown: m.capabilities?.firmwareNewerThanKnown,
      discoveredSubcommands: m.capabilities?.discoveredSubcommands?.length ?? null,
      unsupportedCommands: Object.entries(m.capabilities?.commands || {})
        .filter(([, v]) => v.supported === false)
        .map(([k, v]) => `${k} [${v.source}] ${v.reason}`)
    }, null, 2))
  } finally {
    await runtime.stop()
  }
}

main().catch((err) => { console.error(String(err.message || err)); process.exitCode = 1 })
