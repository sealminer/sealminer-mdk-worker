#!/usr/bin/env node
'use strict'

// End-to-end check: a consumer talks to a real miner through the whole MDK
// chain — Kernel, HRPC and the client SDK — not just this worker's runtime.
//
//   MDK_REPO=../mdk node tests/e2e/kernel-chain.js               # bundled mock
//   MDK_REPO=../mdk node tests/e2e/kernel-chain.js <address> [--series A2]
//                        [--port 4028] [--write] [--json] [--public-dht]
//
// With no address it runs the identical chain against the bundled mock, so
// everything below is verifiable with no SealMiner on the network. The mock
// is pinned to the same firmware as the A2 this was developed against, so
// both modes assert the same capability gating.
//
// By default it runs a local hyperdht testnet and points Kernel, the worker
// and the client at it. HRPC is key-addressed over a DHT even when every end
// is on this machine, and relying on the public bootstrap made the first
// client call time out non-deterministically. A private testnet takes the
// internet out of the loop, which also makes this runnable in CI.
// --public-dht uses hyperdht's real bootstrap instead.
//
// The development console hosts this package on a real WorkerRuntimeV2 but
// calls handleRequest directly, standing in for Kernel. That leaves Kernel's
// own behaviour unproven, and one part of it matters a lot: Kernel validates
// declared numeric bounds BEFORE dispatch, so a worker that declares min/max
// gets a second line of defence that no amount of local testing can
// demonstrate. This script proves it, against hardware.
//
// What it covers that nothing else here does:
//   - Kernel discovers the worker and reports it READY with its device ids
//   - telemetry travels consumer -> client -> Kernel -> HRPC -> worker -> miner
//   - Kernel serves the published contract it cached at capability time
//   - Kernel rejects an out-of-range and a wrong-typed parameter itself
//   - a refusal from this worker's guard travels back up through Kernel
//   - Kernel's own scheduled telemetry pulls run against the live device
//
// Reads are safe on a producing miner. --write additionally sends
// setTimezone UTC, which has no physical effect and is what the miner is
// already set to.

const os = require('node:os')
const path = require('node:path')

// `<address>` is optional: with no address (or --mock) the script boots the
// bundled mock miner and runs the identical chain against it, so the whole
// Kernel-mediated path is verifiable with no hardware at all. That matters
// more than it looks — this is the only test that proves Kernel's own
// pre-dispatch validation, and a reviewer with no SealMiner still has to be
// able to run it.
const positional = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null
const argv = process.argv.slice(positional ? 3 : 2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

if (has('help')) {
  console.error('usage: MDK_REPO=../mdk node tests/e2e/kernel-chain.js [<address>] [--series A2]')
  console.error('                        [--port 4028] [--write] [--json] [--public-dht]')
  console.error('  with no address (or --mock) the whole chain runs against the bundled mock')
  process.exit(1)
}

const useMock = !positional || has('mock')
const address = useMock ? '127.0.0.1' : positional

const MDK_REPO = process.env.MDK_REPO
  ? path.resolve(process.env.MDK_REPO)
  : path.resolve(__dirname, '../../../mdk')

const load = (rel, hint) => {
  try {
    return require(path.join(MDK_REPO, rel))
  } catch (err) {
    console.error(`Could not load ${rel} from ${MDK_REPO}`)
    console.error(`  ${hint}`)
    process.exit(1)
  }
}

const { WorkerRuntimeV2 } = load('backend/core/mdk-worker', 'npm install --prefix <mdk>/backend/core/mdk-worker')
const { getKernel, waitForDiscovery, shutdown } = load('backend/core/mdk', 'npm install --prefix <mdk>/backend/core/mdk')
const { createMdkClient } = load('backend/core/client', 'npm install --prefix <mdk>/backend/core/client')
const { HRPCClient } = load('backend/core/client/lib/hrpc-client', 'npm install --prefix <mdk>/backend/core/client')
const { build } = load('backend/core/kernel/lib/protocol/envelope')
const { ACTIONS, MESSAGE_TYPES } = load('backend/core/kernel/lib/protocol/actions')
const createTestnet = has('public-dht')
  ? null
  : load('backend/core/mdk-worker/node_modules/hyperdht/testnet', 'hyperdht ships with mdk-worker')

// The mock is calibrated to the real A2 this was developed against, firmware
// included, so both modes assert the same things: on 2026040101 `resume` is
// firmware-gated and mining settings are deferred rather than immediate.
const MOCK_FIRMWARE = '2026040101'

const WORKER_DIR = path.resolve(__dirname, '../..')
const WORKER_ID = 'sealminer-e2e'
const DEVICE_ID = useMock ? 'sealminer-mock-0' : `sealminer-${address.replaceAll('.', '-')}`
const ROOT = path.join(os.tmpdir(), `sealminer-e2e-${process.pid}`)

const checks = []
const check = (title, why) => {
  const entry = { title, why, ok: false, detail: null }
  checks.push(entry)
  return (ok, detail) => { entry.ok = Boolean(ok); entry.detail = detail ?? null }
}

// Generous on purpose: an outer timeout smaller than the client's own retry
// budget turns a slow first connection into a spurious failure. HRPC dials
// over a DHT even when both ends are local.
const FIRST_CALL_MS = 60000
const CALL_MS = 30000

const withTimeout = (promise, ms, code) => {
  let timer
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const main = async () => {
  const config = { address, series: flag('series', useMock ? 'A2' : undefined) }
  if (flag('port')) config.port = Number(flag('port'))

  let kernel
  let runtime
  let client
  let statusTransport
  let testnet
  let mock
  let lastCommandId

  try {
    if (useMock) {
      const { createServer } = require('../../mock/server')
      mock = createServer({ series: 'a2', firmware: MOCK_FIRMWARE, includeChips: false })
      config.port = (await mock.ready).port
      console.log(`  against the bundled mock on 127.0.0.1:${config.port} (firmware ${MOCK_FIRMWARE})`)
    } else {
      console.log(`  against real hardware at ${address}`)
    }

    // A private DHT, so nothing here depends on reaching the public bootstrap.
    const bootstrap = createTestnet ? (testnet = await createTestnet(3)).bootstrap : null
    console.log(bootstrap
      ? `  using a local DHT testnet (${bootstrap.length} node(s))`
      : '  using hyperdht\'s public bootstrap')

    // --- Kernel ------------------------------------------------------------
    // discovery: local keeps Kernel off a Hyperswarm topic; the worker is
    // registered by key directly, which is the single-process shape.
    kernel = await getKernel({
      root: ROOT,
      storeDir: path.join(ROOT, 'kernel-db'),
      discovery: { mode: 'local' },
      ...(bootstrap ? { hrpc: { bootstrap } } : {})
    })

    // --- worker host -------------------------------------------------------
    runtime = new WorkerRuntimeV2(WORKER_DIR, {
      workerId: WORKER_ID,
      storeDir: path.join(ROOT, 'worker-store'),
      devices: [{ deviceId: DEVICE_ID, config }],
      ...(bootstrap ? { bootstrap } : {})
    })
    await runtime.start()

    // --- discovery ---------------------------------------------------------
    {
      const set = check(
        'Kernel discovers the worker and reports it READY with its device ids',
        'Until a worker reaches READY and publishes its devices, nothing above Kernel can address them.')
      await kernel.registerWorker(runtime.getPublicKey())
      const workers = await waitForDiscovery(kernel, { minWorkers: 1, timeoutMs: 30000 })
      const ready = workers.find((w) => w.workerId === WORKER_ID && w.state === 'READY')
      set(Boolean(ready) && ready.deviceIds.includes(DEVICE_ID),
        ready ? `${ready.workerId} READY with ${ready.deviceIds.join(', ')}` : 'not READY')
    }

    // --- consumer-side client ---------------------------------------------
    // Kernel's command dispatch is asynchronous: sendCommand returns
    // { commandId, status: 'QUEUED' } and the terminal result is served by the
    // `command.status` action. createMdkClient wraps no method for it, so
    // reading a command's outcome means building the envelope and using the
    // transport — which is what a Gateway plugin has to do too. The client
    // takes an injected transport, so both ride one connection to Kernel.
    statusTransport = new HRPCClient({
      key: kernel.getPublicKey(),
      ...(bootstrap ? { bootstrap } : {})
    })
    client = createMdkClient({}, { transport: statusTransport })
    await client.connect()

    const commandStatus = (commandId) => statusTransport.request(build({
      action: ACTIONS.COMMAND_STATUS,
      type: MESSAGE_TYPES.REQUEST,
      sender: 'gateway',
      deviceId: null,
      payload: { commandId }
    }))

    // Kernel DELETES a command's entry from memory and the WAL the moment it
    // reaches a terminal state (command-state-machine, _settle), so
    // command.status only answers while the command is still in flight and
    // ERR_COMMAND_NOT_FOUND afterwards. The terminal result leaves Kernel only
    // as an in-process 'command:done' event. That is how MDK's own integration
    // tests read a result, and it is the only way to read one here.
    const onDone = (commandId, ms = CALL_MS) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        kernel.stateMachine.off('command:done', handler)
        reject(new Error('ERR_COMMAND_DONE_TIMEOUT'))
      }, ms)
      function handler (data) {
        if (commandId && data.commandId !== commandId) return
        clearTimeout(timer)
        kernel.stateMachine.off('command:done', handler)
        resolve(data)
      }
      kernel.stateMachine.on('command:done', handler)
    })

    {
      const set = check(
        'A consumer sees the fleet through the client SDK, without knowing any miner address',
        'Consumers address a deviceId; resolving it to a worker is Kernel\'s job.')
      const { workers, totalDevices } = await withTimeout(
        client.getStatus({ retries: 5, retryDelayMs: 1000, timeoutMs: 10000 }), FIRST_CALL_MS, 'ERR_STATUS_TIMEOUT')
      const mine = workers.find((w) => w.workerId === WORKER_ID)
      set(Boolean(mine) && totalDevices >= 1,
        `${workers.length} worker(s), ${totalDevices} device(s); ${mine?.workerId} state=${mine?.state} health=${mine?.healthState}`)
    }

    {
      const set = check(
        'Kernel serves the published contract it cached from the worker',
        'This is what a UI or an AI agent reads to know what the device can do — and it must not contain handler paths.')
      const caps = await withTimeout(client.getCapabilities(DEVICE_ID), CALL_MS, 'ERR_CAPS_TIMEOUT')
      const c = caps.capabilities || caps.contract?.capabilities
      const leaked = [...(c?.telemetry || []), ...(c?.commands || [])].filter((e) => e.handler)
      set(Boolean(c) && leaked.length === 0,
        `${c?.telemetry?.length} channels, ${c?.commands?.length} commands, ${leaked.length} handler paths leaked`)
    }

    // --- telemetry through the whole chain --------------------------------
    let metrics
    {
      const set = check(
        'Live telemetry travels consumer -> client -> Kernel -> HRPC -> worker -> miner',
        'The whole point: a consumer reads a real miner without touching its API.')
      const res = await withTimeout(client.pullTelemetry(DEVICE_ID, 'metrics'), CALL_MS, 'ERR_TELEMETRY_TIMEOUT')
      metrics = res.metrics || res
      const failed = Object.entries(metrics).filter(([, v]) => v && typeof v === 'object' && v.error)
      set(typeof metrics.hashrate_rt === 'number' && failed.length === 0,
        `${metrics.hashrate_rt} TH/s, ${metrics.power} W, ${metrics.temperature} C, health=${metrics.health?.status}, ${failed.length} channel error(s)`)
    }

    {
      const set = check(
        'A named channel is routed to exactly one handler',
        'query.type selects a single channel; the contract\'s declared return type is not the channel name.')
      const res = await withTimeout(client.pullTelemetry(DEVICE_ID, 'temperature'), CALL_MS, 'ERR_NAMED_TIMEOUT')
      set(res.name === 'temperature' && typeof res.value === 'number', `${res.name}=${res.value}`)
    }

    {
      const set = check(
        'The capabilities channel reports what this specific device accepts',
        'Firmware and series decide what is available; a consumer should read it rather than assume.')
      const res = await withTimeout(client.pullTelemetry(DEVICE_ID, 'capabilities'), CALL_MS, 'ERR_CAPS_CH_TIMEOUT')
      const v = res.value
      const unsupported = Object.entries(v.commands).filter(([, e]) => e.supported === false).map(([k]) => k)
      set(v.series !== null && Array.isArray(v.powerModes) && v.settingsApplyImmediately === undefined,
        `series=${v.series} firmware=${v.firmware} source=${v.capabilitySource} modes=[${v.powerModes.join(', ')}] unsupported=[${unsupported.join(', ')}]`)
    }

    // --- Kernel's own validation, which nothing local can prove -----------
    //
    {
      const set = check(
        'Kernel rejects an out-of-range parameter itself, before the command is dispatched',
        'Kernel enforces declared numeric bounds pre-dispatch. That is the only thing a declared range buys above the worker, and the firmware buys nothing — it answers ASC 0 set OK to values it silently ignores — so this is the only layer where the guard can be shown to exist at all.')
      const res = await withTimeout(client.sendCommand(DEVICE_ID, 'setPowerLimit', { watts: 99999 }), CALL_MS, 'ERR_CMD_TIMEOUT')
      const text = JSON.stringify(res)
      set(/ERR_PARAM_RANGE/.test(text), text.slice(0, 160))
    }

    {
      const set = check(
        'Kernel rejects a wrong-typed parameter itself',
        'Same pre-dispatch check: a string where the contract declares a number never reaches the device.')
      const res = await withTimeout(client.sendCommand(DEVICE_ID, 'setPowerLimit', { watts: '4300' }), CALL_MS, 'ERR_CMD_TIMEOUT')
      const text = JSON.stringify(res)
      set(/ERR_PARAM_TYPE/.test(text), text.slice(0, 160))
    }

    {
      const set = check(
        'A command outside the contract is refused by Kernel',
        'Kernel checks the command against the capabilities it cached, so a typo never reaches hardware.')
      const res = await withTimeout(client.sendCommand(DEVICE_ID, 'notACommand', {}), CALL_MS, 'ERR_CMD_TIMEOUT')
      const text = JSON.stringify(res)
      set(/ERR_COMMAND_NOT_IN_CAPABILITIES|ERR_UNKNOWN_COMMAND/.test(text), text.slice(0, 160))
    }

    {
      const set = check(
        'A refusal from this worker\'s own guard travels back up through Kernel',
        'Kernel cannot know that resume was removed from this firmware — only the worker can. The refusal has to survive dispatch, HRPC and Kernel\'s state machine.')
      const done = onDone(null)
      const queued = await withTimeout(client.sendCommand(DEVICE_ID, 'resume', {}), CALL_MS, 'ERR_CMD_TIMEOUT')
      const final = await done
      const text = JSON.stringify(final)
      set(queued.status === 'QUEUED' && final.state === 'FAILED' &&
        /ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE/.test(text) && /restartMiner/.test(text),
        `${final.state}: ${(text.match(/ERR_[A-Z_]+[^"]*/) || [text])[0]}`.slice(0, 200))
      lastCommandId = final.commandId
    }

    {
      const set = check(
        'A finished command\'s result is unreadable through Kernel\'s own status action',
        'This describes Kernel rather than this worker, as measured on MDK v0.8.0 and v0.10.0: Kernel deletes a command from memory and the WAL on reaching a terminal state, so command.status answers only while it is in flight. The result leaves Kernel solely as an in-process event an out-of-process consumer cannot subscribe to, and createMdkClient wraps no status method. A remote consumer therefore cannot learn whether a command succeeded — which is why every write in this contract names a confirmWith channel. A later MDK that makes results readable will fail this check, which is the intent.')
      const res = await commandStatus(lastCommandId)
      const body = res?.payload ?? res
      let noMethod = null
      try {
        await client.getCommandStatus(lastCommandId)
      } catch (err) {
        noMethod = err.message
      }
      set(/ERR_COMMAND_NOT_FOUND/.test(JSON.stringify(body)) &&
        /ERR_MDK_CLIENT_NO_SUCH_METHOD/.test(noMethod || ''),
        `command.status -> ${body?.error}; client.getCommandStatus -> ${noMethod}`)
    }

    // --- an actual write, end to end --------------------------------------
    if (useMock || has('write')) {
      const set = check(
        'A real command reaches the miner and its async semantics survive the trip',
        'The vendor states every write replies first and executes after. The worker annotates each one with what it accepted, when it applies and which channel confirms it; that annotation has to arrive intact.')
      const done = onDone(null)
      const queued = await withTimeout(client.sendCommand(DEVICE_ID, 'setTimezone', { tz: 'UTC' }), CALL_MS, 'ERR_CMD_TIMEOUT')
      const final = await done
      const r = final.result ?? {}
      const d = r.data ?? r
      set(queued.status === 'QUEUED' && final.state === 'SUCCESS' &&
        d.accepted !== undefined && typeof d.appliesOn === 'string',
        `queued then ${final.state}; accepted=${JSON.stringify(d.accepted)} appliesOn=${JSON.stringify(d.appliesOn)} confirmWith=${JSON.stringify(d.confirmWith)}`)
    } else {
      checks.push({
        title: 'A real command reaches the miner (skipped)',
        why: 'Pass --write to send setTimezone UTC on hardware; it runs unconditionally against the mock.',
        ok: true,
        detail: 'skipped'
      })
    }

    // --- Kernel's own scheduler -------------------------------------------
    {
      const set = check(
        'Kernel\'s scheduled telemetry pulls run against the live device on their own',
        'Kernel pulls on a fixed cadence independently of any consumer; that is what keeps a fleet view current.')
      const before = metrics.snap?.ts
      await new Promise((resolve) => setTimeout(resolve, 12000))
      const res = await withTimeout(client.pullTelemetry(DEVICE_ID, 'snap'), CALL_MS, 'ERR_SNAP_TIMEOUT')
      const after = res.value?.ts
      set(typeof after === 'number' && after > (before || 0),
        `snapshot advanced ${before} -> ${after} (age ${res.value?.ageMs}ms, cached=${res.value?.cached})`)
    }

    return { passed: checks.filter((c) => c.ok).length, total: checks.length, checks }
  } finally {
    if (client) await client.close().catch(() => {})
    if (kernel) await shutdown(kernel).catch(() => {})
    if (runtime) await runtime.stop().catch(() => {})
    if (testnet) await testnet.destroy().catch(() => {})
    if (mock) await mock.close()
  }
}

main()
  .then((result) => {
    if (has('json')) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log('')
      console.log(`  ${result.passed} / ${result.total} checks passed`)
      console.log('')
      for (const c of result.checks) {
        console.log(`  ${c.ok ? '✓' : '✗'} ${c.title}`)
        console.log(`      ${c.why}`)
        if (c.detail) console.log(`      -> ${c.detail}`)
        console.log('')
      }
    }
    process.exitCode = result.passed === result.total ? 0 : 1
  })
  .catch((err) => {
    console.error('')
    console.error(String(err.stack || err.message || err))
    process.exitCode = 1
  })
