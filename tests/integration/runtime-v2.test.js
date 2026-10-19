'use strict'

// Drives the real WorkerRuntimeV2 with real MDK protocol envelopes — the
// same path Kernel uses — with no Kernel, no DHT and no hardware.
//
// Needs an MDK checkout. Point MDK_REPO at it, or keep it as a sibling
// directory named `mdk`.

const path = require('node:path')
const test = require('brittle')
const { createServer } = require('../../mock/server')

const MDK_REPO = process.env.MDK_REPO
  ? path.resolve(process.env.MDK_REPO)
  : path.resolve(__dirname, '../../../mdk')

const WorkerRuntimeV2 = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/worker-runtime-v2'))
const { build } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/envelope'))
const { ACTIONS, MESSAGE_TYPES } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/actions'))

const WORKER_DIR = path.resolve(__dirname, '../..')

const request = (action, deviceId, payload = {}) => build({
  action,
  type: MESSAGE_TYPES.REQUEST,
  sender: 'sealminer-runtime-test',
  target: 'sealminer-test',
  deviceId,
  payload
})

const pull = (runtime, deviceId, type, extra = {}) =>
  runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, deviceId, { query: { type, ...extra } }))

const send = (runtime, deviceId, command, params) =>
  runtime.handleRequest(request(ACTIONS.COMMAND_REQUEST, deviceId, { command, params }))

/** Boot one runtime over one or more mocks. */
const boot = async (t, devices) => {
  const mocks = []
  const specs = []
  for (const [i, device] of devices.entries()) {
    const mock = createServer({ includeChips: false, ...device.mock })
    const address = await mock.ready
    mocks.push(mock)
    specs.push({
      deviceId: device.deviceId ?? `sealminer-${i}`,
      config: { address: '127.0.0.1', port: address.port, ...device.config }
    })
  }
  t.teardown(() => { for (const mock of mocks) mock.close() })

  const runtime = new WorkerRuntimeV2(WORKER_DIR, { workerId: 'sealminer-test', devices: specs })
  await runtime.start()
  t.teardown(() => runtime.stop())

  return { runtime, mocks, specs }
}

// Quiet the guard's audit lines; they are asserted in the unit suite.
const muteAudit = (t) => {
  const original = console.info
  const lines = []
  console.info = (line) => lines.push(line)
  t.teardown(() => { console.info = original })
  return lines
}

test('the runtime loads the package and reports identity and capabilities', async (t) => {
  const { runtime } = await boot(t, [{ config: { series: 'A2' } }])

  const identity = await runtime.handleRequest(request(ACTIONS.IDENTITY_REQUEST, null))
  t.is(identity.payload.workerId, 'sealminer-test')
  t.is(identity.payload.devices[0].deviceId, 'sealminer-0')

  const capability = await runtime.handleRequest(request(ACTIONS.CAPABILITY_REQUEST, null))
  const contract = capability.payload.contract
  t.is(contract.metadata.provider, 'bitdeer')
  t.is(contract.metadata.brand, 'SealMiner')
  t.alike(contract.metadata.modelsSupported, ['A2', 'A3', 'A4'])
  t.is(contract.capabilities.telemetry.length, 29)
  t.is(contract.capabilities.commands.length, 14)
  for (const entry of contract.capabilities.telemetry) {
    t.absent(entry.handler, `${entry.name} handler path stripped from the published contract`)
  }
  for (const entry of contract.capabilities.commands) {
    t.absent(entry.handler, `${entry.name} handler path stripped from the published contract`)
  }
})

test('a metrics pull returns every channel with no channel errors', async (t) => {
  const { runtime } = await boot(t, [{ config: { series: 'A2' } }])
  const { payload } = await pull(runtime, 'sealminer-0', 'metrics')
  const metrics = payload.metrics

  const failed = Object.entries(metrics).filter(([, v]) => v && typeof v === 'object' && v.error)
  t.alike(failed.map(([k]) => k), [], 'no channel reported an error')

  t.is(typeof metrics.hashrate_rt, 'number')
  t.is(metrics.hashrate_rt, 230.57)
  t.is(metrics.power, 4300)
  t.is(metrics.power_limit, 4300, 'the readback the real firmware provides')
  t.is(metrics.temperature, 70)
  t.is(metrics.power_mode, 'normal')
  t.is(metrics.status, 'running')
  t.is(metrics.tune_status, 'fine_tuning_done')
  t.is(metrics.hashboards.length, 3)
  t.is(metrics.fans.length, 4)
  t.alike(metrics.errors, [], 'a healthy miner reports no faults')
  t.is(metrics.health.status, 'OK')
  t.is(metrics.capabilities.series, 'A2')
  t.is(metrics.snap.truncated, false)
  t.ok(metrics.snap.ts > 0)
})

test('a named channel pull addresses exactly one handler', async (t) => {
  const { runtime } = await boot(t, [{}])
  const { payload } = await pull(runtime, 'sealminer-0', 'temperature')
  t.is(payload.name, 'temperature')
  t.is(payload.value, 70)
})

test('the contract health channel overrides the builtin one', async (t) => {
  const { runtime } = await boot(t, [{}])
  const { payload } = await pull(runtime, 'sealminer-0', 'health')
  // The builtin channel would answer { status: 'OK', id, opts, env, ... };
  // ours answers an evaluated verdict.
  t.is(payload.value.status, 'OK')
  t.alike(payload.value.alerts, [])
  t.ok(Array.isArray(payload.value.details))
  t.absent(payload.value.opts, 'this is our handler, not the runtime builtin')
})

test('an unknown query type and an unknown command are refused', async (t) => {
  const { runtime } = await boot(t, [{}])
  const telemetry = await pull(runtime, 'sealminer-0', 'not_a_channel')
  t.ok(/ERR_UNKNOWN_QUERY_TYPE/.test(JSON.stringify(telemetry.payload)))

  const command = await send(runtime, 'sealminer-0', 'notACommand', {})
  t.ok(/ERR_UNKNOWN_COMMAND/.test(JSON.stringify(command.payload)))
})

test('a command round-trips and its effect shows on the next pull', async (t) => {
  muteAudit(t)
  const { runtime } = await boot(t, [{ config: { series: 'A2' } }])

  const result = await send(runtime, 'sealminer-0', 'setPowerMode', { mode: 'low_power' })
  t.is(result.payload.status, 'SUCCESS')

  const { payload } = await pull(runtime, 'sealminer-0', 'power_mode')
  t.is(payload.value, 'low_power', 'the write invalidated the read cache')
})

test('a validation failure comes back as FAILED with a stable code', async (t) => {
  muteAudit(t)
  const { runtime } = await boot(t, [{}])

  const cases = [
    [{}, /ERR_PARAM_REQUIRED/],
    [{ watts: '3000' }, /ERR_PARAM_TYPE/],
    [{ watts: Number.NaN }, /ERR_PARAM_TYPE/],
    [{ watts: 10 }, /ERR_PARAM_RANGE/],
    [{ watts: 999999 }, /ERR_PARAM_RANGE/]
  ]
  for (const [params, expected] of cases) {
    const res = await send(runtime, 'sealminer-0', 'setPowerLimit', params)
    t.is(res.payload.status, 'FAILED', JSON.stringify(params))
    t.ok(expected.test(res.payload.error), `${JSON.stringify(params)} -> ${expected}`)
  }

  // And a real setting is not refused. The envelope's only true failure mode
  // is being too narrow, so the highest value measured on hardware round
  // trips.
  const real = await send(runtime, 'sealminer-0', 'setPowerLimit', { watts: 10800 })
  t.absent(/ERR_PARAM_RANGE/.test(real.payload.error || ''),
    '10800 W, an A4 Ultra Hydro\'s real setting, is inside the envelope')
})

test('a mode the series does not accept is refused with its own code', async (t) => {
  muteAudit(t)
  const { runtime } = await boot(t, [{ mock: { series: 'a3' }, config: { series: 'A3' } }])

  const res = await send(runtime, 'sealminer-0', 'setPowerMode', { mode: 'low_power' })
  t.is(res.payload.status, 'FAILED')
  t.ok(/ERR_MODE_NOT_SUPPORTED_ON_SERIES/.test(res.payload.error))
  t.ok(/A3/.test(res.payload.error), 'the error names the series')
})

test('a firmware-gated command is refused before it reaches the device', async (t) => {
  muteAudit(t)
  const { runtime } = await boot(t, [{ mock: { firmware: '2025090101' } }])

  const res = await send(runtime, 'sealminer-0', 'resume', {})
  t.is(res.payload.status, 'FAILED')
  t.ok(/ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE/.test(res.payload.error))
  t.ok(/restartMiner/.test(res.payload.error), 'the fallback is named in the error')
})

test('the declared cooldown is enforced through the runtime', async (t) => {
  muteAudit(t)
  const { runtime } = await boot(t, [{}])

  const first = await send(runtime, 'sealminer-0', 'reboot', {})
  t.is(first.payload.status, 'SUCCESS')

  const second = await send(runtime, 'sealminer-0', 'reboot', {})
  t.is(second.payload.status, 'FAILED')
  t.ok(/ERR_COMMAND_COOLDOWN/.test(second.payload.error))
})

test('devices are isolated: a command on one never touches its sibling', async (t) => {
  muteAudit(t)
  const { runtime, mocks } = await boot(t, [
    { deviceId: 'sealminer-a', mock: { series: 'a2' }, config: { series: 'A2' } },
    { deviceId: 'sealminer-b', mock: { series: 'a2' }, config: { series: 'A2' } }
  ])

  t.is((await send(runtime, 'sealminer-a', 'setPowerLimit', { watts: 2000 })).payload.status, 'SUCCESS')
  t.is(mocks[0].state.powerLimit, 2000)
  t.is(mocks[1].state.powerLimit, 4300, 'the sibling is untouched')

  // Cooldown state is per device too: b may still be commanded.
  t.is((await send(runtime, 'sealminer-b', 'setPowerLimit', { watts: 2500 })).payload.status, 'SUCCESS')
  t.is(mocks[1].state.powerLimit, 2500)

  const a = await pull(runtime, 'sealminer-a', 'power')
  const b = await pull(runtime, 'sealminer-b', 'power')
  t.is(a.payload.value, 2000)
  t.is(b.payload.value, 2500)
})

test('one unreachable device does not take down its siblings', async (t) => {
  const { runtime, mocks } = await boot(t, [
    { deviceId: 'sealminer-up' },
    { deviceId: 'sealminer-down' }
  ])
  mocks[1].close()

  const up = await pull(runtime, 'sealminer-up', 'metrics')
  t.is(up.payload.metrics.hashrate_rt, 230.57, 'the healthy device still answers')

  const down = await pull(runtime, 'sealminer-down', 'metrics')
  const channels = Object.entries(down.payload.metrics)
  const errored = channels.filter(([, v]) => v && typeof v === 'object' && v.error)
  t.ok(errored.length > 0, 'the unreachable device reports errors per channel')
  t.ok(/ERR_API_CONNECTION/.test(JSON.stringify(down.payload.metrics)))
  // health is designed not to throw, so a verdict is always available.
  t.is(down.payload.metrics.health.status, 'OFFLINE')
})

test('a truncated stats reply degrades only the board-level channels', async (t) => {
  const { runtime } = await boot(t, [{ mock: { chipCount: 1092, includeChips: true, truncateAt: 4096 } }])
  const { payload } = await pull(runtime, 'sealminer-0', 'metrics')
  const m = payload.metrics

  t.is(m.temperature, 70, 'device-level values remain valid')
  t.is(m.hashboards, null, 'board-level data is withheld rather than partial')
  t.is(m.snap.truncated, true)
  t.is(m.chip_health.boards, null)
  t.is(m.health.status, 'OK', 'a clipped reply is a warning, not a device fault')
  t.ok(m.errors.some((e) => e.code === 'warn.stats_truncated'))
})

test('the capabilities channel reports what this device actually accepts', async (t) => {
  const { runtime } = await boot(t, [
    { deviceId: 'a2-new', mock: { series: 'a2', firmware: '2026060901' }, config: { series: 'A2' } },
    { deviceId: 'a3-old', mock: { series: 'a3', firmware: '20250620' }, config: { series: 'A3' } }
  ])

  const a2 = (await pull(runtime, 'a2-new', 'capabilities')).payload.value
  t.ok(a2.powerModes.includes('low_power'))
  t.ok(a2.powerModes.includes('sleep'))
  t.is(a2.commands.setHostname.supported, true)

  const a3 = (await pull(runtime, 'a3-old', 'capabilities')).payload.value
  t.absent(a3.powerModes.includes('low_power'), 'A3 has no low_power')
  t.absent(a3.powerModes.includes('sleep'), 'old firmware has no sleep')
  t.is(a3.commands.setHostname.supported, false)
  t.is(a3.commands.setIdleFanTimer.supported, false)
  t.is(a3.commands.resume.supported, true, 'firmware below the removal window still has resume')
})

test('faults raise alerts and degrade health end to end', async (t) => {
  const { runtime } = await boot(t, [{ mock: { faults: ['fan_stopped', 'psu_error'] } }])
  const { payload } = await pull(runtime, 'sealminer-0', 'metrics')

  t.is(payload.metrics.health.status, 'DEGRADED')
  t.ok(payload.metrics.health.alerts.includes('alert.fan_failure'))
  t.ok(payload.metrics.health.alerts.includes('alert.psu_error'))
  t.is(payload.metrics.fan_speed, 4590, 'the remaining fans still report')
})

test('audit events reach the sink for succeeded, failed and rejected outcomes', async (t) => {
  const lines = muteAudit(t)
  const { runtime } = await boot(t, [{}])

  await send(runtime, 'sealminer-0', 'setTimezone', { tz: 'UTC' })
  await send(runtime, 'sealminer-0', 'setPowerLimit', {})
  await send(runtime, 'sealminer-0', 'reboot', {})
  await send(runtime, 'sealminer-0', 'reboot', {})

  const events = lines.map((line) => JSON.parse(line))
  const outcomes = new Set(events.map((e) => e.outcome))
  t.ok(outcomes.has('succeeded'))
  t.ok(outcomes.has('rejected'))
  t.ok(events.every((e) => e.event === 'physical_command' && e.deviceId === 'sealminer-0'))
  t.ok(events.some((e) => e.errorCode === 'ERR_PARAM_REQUIRED'))
  t.ok(events.some((e) => e.errorCode === 'ERR_COMMAND_COOLDOWN'))
})

test('the SQLite store serves history and makes cooldowns survive a restart', async (t) => {
  // A real file, so this proves the durable path rather than the in-memory
  // fallback. Two runtimes over the same mock and the same dbPath stand in
  // for a worker restart.
  const os = require('node:os')
  const fs = require('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealminer-db-'))
  const dbPath = path.join(dir, 'device.sqlite')
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  const mock = createServer({ includeChips: false })
  const address = await mock.ready
  t.teardown(() => mock.close())

  const specs = [{
    deviceId: 'sealminer-db',
    config: { address: '127.0.0.1', port: address.port, series: 'A2', dbPath }
  }]

  const first = new WorkerRuntimeV2(WORKER_DIR, { workerId: 'sealminer-db-1', devices: specs })
  await first.start()

  // Each history pull samples once, so two pulls leave two rows.
  const h1 = await pull(first, 'sealminer-db', 'history')
  t.ok(Array.isArray(h1.payload.value), 'history is an array')
  const h2 = await pull(first, 'sealminer-db', 'history', { limit: 50 })
  t.ok(h2.payload.value.length >= 1, `sampled on pull (${h2.payload.value.length} row(s))`)

  const sample = h2.payload.value[0]
  t.is(typeof sample.ts, 'number')
  t.is(typeof sample.hashrateThs, 'number', 'the sample carries real values, not nulls')
  t.is(sample.powerMode, 'normal')

  // A DISRUPTIVE command with a declared cooldown, then a restart.
  const ok = await send(first, 'sealminer-db', 'suspend', {})
  t.is(ok.payload.status, 'SUCCESS')
  await first.stop()

  t.ok(fs.existsSync(dbPath), 'the database file was created at the configured path')

  const second = new WorkerRuntimeV2(WORKER_DIR, { workerId: 'sealminer-db-2', devices: specs })
  await second.start()
  t.teardown(() => second.stop())

  const blocked = await send(second, 'sealminer-db', 'suspend', {})
  t.is(blocked.payload.status, 'FAILED', 'a restart does not reset a physical cooldown')
  t.ok(/^ERR_COMMAND_COOLDOWN\b/.test(blocked.payload.error), blocked.payload.error)

  // The history written by the first runtime is still there.
  const after = await pull(second, 'sealminer-db', 'history', { limit: 50 })
  t.ok(after.payload.value.length > h2.payload.value.length, 'samples persisted across the restart')
})

test('history works with no dbPath configured, and is then process-local', async (t) => {
  // Persistence is opt-in; a device config that never mentions dbPath must
  // still serve the channel rather than erroring.
  const { runtime } = await boot(t, [{ config: { series: 'A2' } }])
  const res = await pull(runtime, 'sealminer-0', 'history')
  t.absent(res.payload.error, 'the channel does not error without a dbPath')
  t.ok(Array.isArray(res.payload.value))
})

test('a mining-setting write names its confirming channel and claims nothing about timing', async (t) => {
  // Two firmwares that behave differently on hardware, now given the same
  // answer on purpose. Measured: an A2 on 2026040101 stores a mining setting
  // and applies it at the next bdminer restart, while an A4 Ultra Hydro on
  // 2026083100 restarts bdminer itself. The worker used to report which case
  // a device was in, derived from a firmware table — the API exposes no
  // pending value, so the device could never confirm it. By decision that
  // claim is gone: every write says what was accepted and which channel
  // confirms it, and the caller reads that channel.
  const { runtime } = await boot(t, [
    { deviceId: 'deferred', mock: { firmware: '2026040101' }, config: { series: 'A2' } },
    { deviceId: 'immediate', mock: { firmware: '2026083100' }, config: { series: 'A4' } }
  ])

  for (const [deviceId, watts] of [['deferred', 4300], ['immediate', 10800]]) {
    const res = await send(runtime, deviceId, 'setPowerLimit', { watts })
    t.is(res.payload.status, 'SUCCESS', deviceId)
    t.is(res.payload.result.confirmWith, 'power_limit',
      `${deviceId} names the channel that will show it`)
    t.absent(res.payload.result.pending,
      `${deviceId} makes no pending claim`)
    t.absent(/bdminer restart/.test(res.payload.result.appliesOn),
      `${deviceId} does not claim a restart boundary it cannot verify`)
  }

  const caps = await pull(runtime, 'immediate', 'capabilities')
  t.absent(caps.payload.value.settingsApplyImmediately,
    'and the capability channel makes no claim either')
})

test('a liquid-cooled miner reports no fans without looking broken', async (t) => {
  // An A4 Ultra Hydro reports no Fan Count, an empty fan list and two board
  // temperature sensors instead of four. Through the runtime, that must read
  // as a water-cooled machine rather than as total fan failure.
  const { runtime } = await boot(t, [{
    mock: { liquidCooling: true, fanCount: 0, boardTempSensors: 2, targetCtrlTemp: 60, temp: 67 },
    config: { series: 'A4' }
  }])

  const metrics = (await pull(runtime, 'sealminer-0', 'metrics')).payload.metrics
  t.is(metrics.health.status, 'OK', '+7C over target and no fans is healthy on hydro')
  t.absent(metrics.health.alerts.includes('alert.fan_failure'))
  t.absent(metrics.health.alerts.includes('alert.overheat'))
  t.ok(metrics.health.details.some((d) => d.code === 'info.liquid_cooled'))
  t.alike(metrics.fans, [], 'the fans channel is empty rather than an error')
  t.is(metrics.fan_speed, null, 'and fan_speed is null, not 0')
})

test('a store created before the firmware column still works', async (t) => {
  // CREATE TABLE IF NOT EXISTS leaves an existing table alone, so adding a
  // column after a store is already in the field has to be migrated in.
  // Without that, every insert fails with "no column named firmware" — and
  // because sampling is best-effort, it fails silently and the history simply
  // stops growing.
  const os = require('node:os')
  const fs = require('node:fs')
  const { DatabaseSync } = require('node:sqlite')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealminer-migrate-'))
  const dbPath = path.join(dir, 'legacy.sqlite')
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  // A store in the shape an earlier version of src/db.js created.
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`CREATE TABLE telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, ts INTEGER NOT NULL,
    hashrate_ths REAL, power_w REAL, temperature_c REAL,
    power_mode TEXT, pm_state TEXT, health TEXT)`)
  legacy.prepare('INSERT INTO telemetry (device_id, ts, hashrate_ths) VALUES (?, ?, ?)')
    .run('sealminer-0', Date.now() - 60000, 111.11)
  legacy.close()

  const { runtime } = await boot(t, [{ config: { series: 'A2', dbPath } }])
  const res = await pull(runtime, 'sealminer-0', 'history', { limit: 50 })

  t.absent(res.payload.error, 'the channel works against a pre-existing store')
  const rows = res.payload.value
  t.ok(rows.length >= 2, `the old row survived and a new one was added (${rows.length})`)
  t.ok(rows.some((r) => r.hashrateThs === 111.11), 'the pre-existing sample is still there')
  t.ok(rows.some((r) => typeof r.firmware === 'string'), 'and new samples carry the firmware')
  t.is(rows.find((r) => r.hashrateThs === 111.11).firmware, null,
    'while the old row keeps a null, which is the truth about it')
})
