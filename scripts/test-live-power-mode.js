#!/usr/bin/env node
'use strict'

// The only write on this API whose effect can be read back and rolled back.
//
//   MDK_REPO=../mdk node scripts/test-live-power-mode.js <address> --confirm [--port 4028] [--series A2]
//
// Records the current mining mode, sets a different one the device's own
// capabilities say it accepts, confirms the change, then restores the
// original and confirms the rollback.
//
// WHY NOT SOMETHING HARMLESS: the 4028 API exposes no readback for timezone,
// hostname, fast-raise-freq, idle-fan-timer or the power limit, so none of
// those can be verified — only asserted. Mining mode is the sole reversible
// write with an observable result.
//
// COST: the firmware restarts bdminer to apply a mode change, so this
// interrupts mining and starts a tuning cycle. Run it on a test miner, never
// on producing hardware, and pass --confirm to acknowledge that.

const path = require('node:path')

const address = process.argv[2]
const argv = process.argv.slice(3)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

if (!address || !argv.includes('--confirm')) {
  console.error('usage: MDK_REPO=../mdk node scripts/test-live-power-mode.js <address> --confirm [--port 4028] [--series A2]')
  console.error('')
  console.error('--confirm is required: a mode change restarts mining and re-tunes the miner.')
  process.exit(1)
}

const MDK_REPO = process.env.MDK_REPO
  ? path.resolve(process.env.MDK_REPO)
  : path.resolve(__dirname, '../../mdk')

const WorkerRuntimeV2 = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/worker-runtime-v2'))
const WORKER_DIR = path.resolve(__dirname, '..')
const deviceId = `sealminer-${address.replaceAll('.', '-')}`

const envelope = (action, payload) => ({
  id: `live-mode-${Date.now()}`,
  version: '0.2.0',
  type: 'request',
  action,
  sender: 'sealminer-live-power-mode',
  target: 'sealminer-live-power-mode',
  deviceId,
  timestamp: Date.now(),
  payload
})

const pull = (runtime, type) => runtime.handleRequest(envelope('telemetry.pull', { query: { type } }))
const send = (runtime, command, params) => runtime.handleRequest(envelope('command.request', { command, params }))

const step = (label, value) => console.log(`  ${label.padEnd(28)} ${JSON.stringify(value)}`)

const main = async () => {
  const config = { address, series: flag('series', undefined) }
  if (flag('port')) config.port = Number(flag('port'))

  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'sealminer-live-power-mode',
    devices: [{ deviceId, config }]
  })

  try {
    await runtime.start()

    const caps = (await pull(runtime, 'capabilities')).payload.value
    const original = (await pull(runtime, 'power_mode')).payload.value
    step('capabilities.powerModes', caps.powerModes)
    step('original power_mode', original)

    if (!original) throw new Error('ERR_MODE_UNREADABLE: this firmware does not report Mining Mode as a string')

    // Never pick sleep: it stops hashing.
    const target = caps.powerModes.find((m) => m !== original && m !== 'sleep')
    if (!target) throw new Error('ERR_NO_ALTERNATE_MODE: nothing safe to switch to')
    step('target power_mode', target)

    const applied = await send(runtime, 'setPowerMode', { mode: target })
    step('set -> status', applied.payload.status)
    if (applied.payload.status !== 'SUCCESS') throw new Error(`ERR_SET_FAILED: ${applied.payload.error}`)

    const afterSet = (await pull(runtime, 'power_mode')).payload.value
    step('read back', afterSet)
    if (afterSet !== target) throw new Error(`ERR_NOT_APPLIED: read ${afterSet}, expected ${target}`)

    // The guard enforces a 60s cooldown between mode changes; wait it out
    // rather than reporting a rollback failure that is really our own rule.
    step('waiting for cooldown', '61s')
    await new Promise((resolve) => setTimeout(resolve, 61000))

    const restored = await send(runtime, 'setPowerMode', { mode: original })
    step('rollback -> status', restored.payload.status)
    if (restored.payload.status !== 'SUCCESS') throw new Error(`ERR_ROLLBACK_FAILED: ${restored.payload.error}`)

    const afterRollback = (await pull(runtime, 'power_mode')).payload.value
    step('read back', afterRollback)
    if (afterRollback !== original) throw new Error(`ERR_ROLLBACK_NOT_APPLIED: read ${afterRollback}`)

    console.log('')
    console.log(`LIVE WRITE OK: ${original} -> ${target} -> ${original}`)
    console.log('The miner is re-tuning; expect reduced hashrate for up to 15 minutes.')
  } finally {
    await runtime.stop()
  }
}

main().catch((err) => { console.error(String(err.message || err)); process.exitCode = 1 })
