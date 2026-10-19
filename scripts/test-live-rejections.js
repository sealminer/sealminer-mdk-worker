#!/usr/bin/env node
'use strict'

// Rejection paths against real hardware, through the real runtime.
//
//   MDK_REPO=../mdk node scripts/test-live-rejections.js <address> [--series A3]
//
// Every command here is expected to be REFUSED, so nothing reaches the miner
// and no physical state changes. That makes it safe on a producing machine —
// safer than the read-only check, which at least opens sockets for data.
//
// It is the only way to prove the guard on hardware. Two of its layers can
// only be exercised against a real device:
//
//   - the capability gate, which refuses a mode this series does not have.
//     A3 and A4 have no `low_power`; that gate had never run against a real
//     A3 or A4 until this script did.
//   - the firmware gate, which refuses a command this build lacks.
//
// A refusal must also come from the right layer. A mode the series lacks has
// to be stopped by the capability gate — before any I/O — rather than sent to
// the miner and rejected there, so each check asserts the error code and not
// merely that something failed.

const path = require('node:path')

const address = process.argv[2]
const argv = process.argv.slice(3)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

if (!address) {
  console.error('usage: MDK_REPO=../mdk node scripts/test-live-rejections.js <address> [--series A3] [--port 4028]')
  process.exit(1)
}

const MDK_REPO = process.env.MDK_REPO
  ? path.resolve(process.env.MDK_REPO)
  : path.resolve(__dirname, '../../mdk')

let WorkerRuntimeV2
try {
  WorkerRuntimeV2 = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/worker-runtime-v2'))
} catch {
  console.error(`Could not load WorkerRuntimeV2 from ${MDK_REPO}`)
  process.exit(1)
}

const { build } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/envelope'))
const { ACTIONS, MESSAGE_TYPES } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/actions'))

const DEVICE_ID = 'reject-probe'
const WORKER_DIR = path.resolve(__dirname, '..')

const envelope = (action, payload) => build({
  action,
  type: MESSAGE_TYPES.REQUEST,
  sender: 'rejection-probe',
  deviceId: DEVICE_ID,
  payload
})

const main = async () => {
  const config = { address, series: flag('series', undefined) }
  if (flag('port')) config.port = Number(flag('port'))

  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'sealminer-reject-probe',
    devices: [{ deviceId: DEVICE_ID, config }]
  })
  await runtime.start()

  const send = async (command, params) => {
    const res = await runtime.handleRequest(
      envelope(ACTIONS.COMMAND_REQUEST, { command, params }))
    return res.payload
  }

  try {
    const caps = (await runtime.handleRequest(
      envelope(ACTIONS.TELEMETRY_PULL, { query: { type: 'capabilities' } }))).payload.value

    console.log('')
    console.log(`  ${address} — ${caps.model} · series ${caps.series} (via ${caps.seriesSource}) · firmware ${caps.firmware}`)
    console.log(`  modes: ${caps.powerModes.join(', ')}`)
    console.log('')

    // Every case here must be refused. `want` is the code that has to come
    // back: a refusal from the wrong layer is a failure, not a pass.
    const cases = [
      ['setPowerMode', { mode: 'not_a_mode' }, 'ERR_PARAM_ENUM',
        'a mode outside the contract never reaches the capability gate'],
      ['setPowerMode', { mode: 'low_power' }, 'ERR_MODE_NOT_SUPPORTED_ON_SERIES',
        'A3/A4 have no low_power; the series gate must stop it before any I/O'],
      ['setPowerLimit', { watts: 999999 }, 'ERR_PARAM_RANGE',
        'above the declared envelope'],
      ['setPowerLimit', { watts: 10 }, 'ERR_PARAM_RANGE',
        'below the declared envelope'],
      ['setPowerLimit', {}, 'ERR_PARAM_REQUIRED',
        'a missing required parameter'],
      ['setPowerLimit', { watts: '4300' }, 'ERR_PARAM_TYPE',
        'a string where the contract declares a number'],
      ['setStratumDisconnectTimeout', { seconds: 0 }, 'ERR_PARAM_RANGE',
        'below the declared minimum of one second'],
      ['setPreheat', { enableBootPreheat: true }, 'ERR_PARAM_REQUIRED',
        'the firmware needs all four preheat fields; a partial payload must not be sent'],
      ['setIdleFanTimer', { interval: 30, onDuration: 10 }, 'ERR_PARAM_REQUIRED',
        'a partial idle-fan-timer payload'],
      // 'Nowhere/Fake' is deliberately NOT used here. It is a well-formed
      // IANA name, so it passes the shape check and the firmware rejects it
      // with ERR_ASCSET_FAILED — correct behaviour, since the miner's tzdata
      // is the authority on which zones exist and a hardcoded list would go
      // stale. But it is a write that reaches the device, which would break
      // this script's promise that nothing does.
      ['setTimezone', { tz: 'not/a/zone!' }, 'ERR_PARAM_SHAPE',
        'a malformed zone name is refused locally; whether a well-formed zone exists is the firmware\'s call'],
      ['setHostname', { hostname: 'not a valid hostname!' }, 'ERR_PARAM_SHAPE',
        'an invalid hostname is caught locally — the write itself is not attempted']
    ]

    let passed = 0
    for (const [command, params, want, why] of cases) {
      const res = await send(command, params)
      const got = String(res.error ?? '')
      const ok = res.status === 'FAILED' && got.startsWith(want)
      if (ok) passed++
      console.log(`  ${ok ? '✓' : '✗'} ${command}(${JSON.stringify(params)})`)
      console.log(`      ${why}`)
      console.log(`      want ${want} · got ${res.status} ${got || '(no error)'}`)
    }

    console.log('')
    console.log(`  ${passed} / ${cases.length} refused with the expected code — no physical state changed`)
    console.log('')
    process.exitCode = passed === cases.length ? 0 : 1
  } finally {
    await runtime.stop()
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
