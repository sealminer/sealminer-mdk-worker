#!/usr/bin/env node
'use strict'

// Live write test for setPowerLimit, plus an upper-bound discovery probe.
//
//   MDK_REPO=../mdk node scripts/test-live-power-limit.js <address> --confirm
//                        [--port 4028] [--series A2] [--delta 100] [--skip-probe]
//
// WHY THIS COMMAND: stats reports "Power Limit", so this is the one write
// whose effect can be read back from the device and rolled back with
// certainty. The API document does not mention that field; it was found by
// capturing a real miner (see mock/fixtures/README.md).
//
// COST: the firmware restarts mining to apply a new limit, so hashrate dips
// and a tuning cycle starts. It does not affect reachability. --confirm is
// required to acknowledge that.
//
// PHASE 1 — reversible loop, through the real MDK path:
//   read the current limit -> lower it by --delta -> verify the readback ->
//   wait out the guard's cooldown -> restore the original -> verify again.
//   Deliberately DOWNWARD: reducing power is the thermally safe direction on
//   a producing miner.
//
// PHASE 2 — upper-bound discovery by rejection only, through lib/ so the
//   contract's own declared range does not mask the firmware's:
//   send values from absurd downwards and record which the firmware REFUSES.
//   A refusal changes nothing on the device, so every refused probe is free
//   information. The descent stops at the first value the firmware accepts,
//   which is restored immediately.
//
// The lower bound is deliberately NOT probed: finding it means running the
// miner at its minimum, and a conservative declared floor is worth more than
// an exact one. See lib/provisional.js.

const path = require('node:path')
const { createClient } = require('../lib/api-client')

const address = process.argv[2]
const argv = process.argv.slice(3)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

if (!address || !argv.includes('--confirm')) {
  console.error('usage: MDK_REPO=../mdk node scripts/test-live-power-limit.js <address> --confirm [--port 4028] [--series A2] [--delta 100] [--skip-probe]')
  console.error('')
  console.error('--confirm is required: applying a power limit restarts mining and starts a tuning cycle.')
  process.exit(1)
}

const PORT = Number(flag('port', 4028))
const DELTA = Number(flag('delta', 100))
const SERIES = flag('series', undefined)

const MDK_REPO = process.env.MDK_REPO
  ? path.resolve(process.env.MDK_REPO)
  : path.resolve(__dirname, '../../mdk')
const WorkerRuntimeV2 = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/worker-runtime-v2'))

const WORKER_DIR = path.resolve(__dirname, '..')
const deviceId = `sealminer-${address.replaceAll('.', '-')}`

// Descending, and stopping at the first acceptance. Nothing here is expected
// to be accepted on a miner whose nameplate is ~230 TH/s at ~4.3 kW.
const UPPER_PROBES = [99999, 20000, 10000, 8000, 6000, 5000, 4700]

const envelope = (action, payload) => ({
  id: `live-limit-${Date.now()}`,
  version: '0.2.0',
  type: 'request',
  action,
  sender: 'sealminer-live-power-limit',
  target: 'sealminer-live-power-limit',
  deviceId,
  timestamp: Date.now(),
  payload
})

const step = (label, value) => console.log(`  ${String(label).padEnd(30)} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  const config = { address, port: PORT }
  if (SERIES) config.series = SERIES

  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'sealminer-live-power-limit',
    devices: [{ deviceId, config }]
  })

  const pull = (type) => runtime.handleRequest(envelope('telemetry.pull', { query: { type } }))
  const send = (command, params) => runtime.handleRequest(envelope('command.request', { command, params }))

  const results = { original: null, applied: null, restored: null, rejectedAbove: [], acceptedAbove: null }

  try {
    await runtime.start()

    // ---- phase 1: reversible loop ---------------------------------------
    console.log('phase 1 — reversible write through the MDK command path')

    const original = (await pull('power_limit')).payload.value
    step('original power_limit', `${original} W`)
    if (typeof original !== 'number') throw new Error('ERR_LIMIT_UNREADABLE: this firmware does not report Power Limit')
    results.original = original

    const target = original - DELTA
    step('target (downward only)', `${target} W`)

    const applied = await send('setPowerLimit', { watts: target })
    step('set -> status', applied.payload.status)
    if (applied.payload.status !== 'SUCCESS') throw new Error(`ERR_SET_FAILED: ${applied.payload.error}`)

    const readBack = (await pull('power_limit')).payload.value
    step('read back', `${readBack} W`)
    results.applied = readBack
    if (readBack !== target) throw new Error(`ERR_NOT_APPLIED: read ${readBack}, expected ${target}`)

    // Our own guard enforces 60s between attempts; wait it out rather than
    // reporting a rollback failure that is really our own policy.
    step('waiting for guard cooldown', '61s')
    await wait(61000)

    const restored = await send('setPowerLimit', { watts: original })
    step('restore -> status', restored.payload.status)
    if (restored.payload.status !== 'SUCCESS') {
      throw new Error(`ERR_ROLLBACK_FAILED: ${restored.payload.error} — device left at ${readBack} W`)
    }

    const finalValue = (await pull('power_limit')).payload.value
    step('read back', `${finalValue} W`)
    results.restored = finalValue
    if (finalValue !== original) throw new Error(`ERR_ROLLBACK_NOT_APPLIED: read ${finalValue}, expected ${original}`)

    console.log(`  OK: ${original} -> ${target} -> ${original}, verified by readback both ways`)

    // ---- phase 2: upper bound, by refusal ------------------------------
    if (argv.includes('--skip-probe')) return results

    console.log('')
    console.log('phase 2 — upper bound by refusal (a refused value changes nothing)')

    // Straight to lib/, so the contract's declared range cannot mask the
    // firmware's. This is discovery of the bound the contract should declare.
    const client = createClient({ host: address, port: PORT, timeoutMs: 10000, series: SERIES })
    try {
      for (const probe of UPPER_PROBES) {
        await wait(2000) // do not hammer a producing miner
        try {
          await client.setPowerLimit(probe)
          // Accepted: the device changed. Put it back at once and stop.
          results.acceptedAbove = probe
          step(`${probe} W`, 'ACCEPTED — restoring immediately')
          await wait(2000)
          await client.setPowerLimit(original)
          const after = (await client.stats()).settings.powerLimit
          step('restored to', `${after} W`)
          if (after !== original) throw new Error(`ERR_PROBE_ROLLBACK_FAILED: device left at ${after} W`)
          break
        } catch (err) {
          if (err.code === 'ERR_ASCSET_FAILED' || err.code === 'ERR_INVALID_CMD' || err.code === 'ERR_JSON_CMD') {
            results.rejectedAbove.push({ watts: probe, code: err.code })
            step(`${probe} W`, `refused (${err.code}) — no change`)
            continue
          }
          throw err
        }
      }
    } finally {
      client.stop()
    }

    const lowestRefused = results.rejectedAbove.length
      ? Math.min(...results.rejectedAbove.map((r) => r.watts))
      : null

    console.log('')
    console.log('conclusion')
    step('accepted (observed)', `${original} W (the miner's own setting) and ${results.applied} W`)
    step('lowest refused', lowestRefused === null ? 'none refused' : `${lowestRefused} W`)
    if (results.acceptedAbove) step('accepted above nameplate', `${results.acceptedAbove} W — the ceiling is higher than probed`)
    if (lowestRefused !== null) {
      step('firmware maximum is in', `[${Math.max(original, results.applied)}, ${lowestRefused})`)
    }

    return results
  } finally {
    await runtime.stop()
  }
}

main()
  .then((r) => {
    console.log('')
    console.log(JSON.stringify(r, null, 2))
  })
  .catch((err) => {
    console.error('')
    console.error(String(err.message || err))
    console.error('If a rollback failed, read power_limit and restore it before leaving the miner.')
    process.exitCode = 1
  })
