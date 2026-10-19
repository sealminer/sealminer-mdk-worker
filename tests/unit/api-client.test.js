'use strict'

const net = require('node:net')
const test = require('brittle')
const { createClient } = require('../../lib/api-client')
const { createServer } = require('../../mock/server')

// Count TCP connections: the point of single-flight is that 26 concurrent
// telemetry handlers produce one socket, not 26.
const boot = async (t, opts = {}) => {
  const mock = createServer({ includeChips: false, ...opts })
  const address = await mock.ready
  t.teardown(() => mock.close())

  let connections = 0
  mock.server.on('connection', () => { connections++ })

  const client = createClient({
    host: '127.0.0.1',
    port: address.port,
    timeoutMs: 2000,
    ...(opts.clientOpts || {})
  })
  t.teardown(() => client.stop())

  return { mock, client, connections: () => connections }
}

test('a concurrent metrics fan-out collapses into one request', async (t) => {
  const { client, connections } = await boot(t)

  // What a Kernel `metrics` pull looks like: every channel at once.
  const results = await Promise.all(Array.from({ length: 26 }, () => client.stats()))

  t.is(connections(), 1, '26 concurrent reads, one socket')
  t.is(results.length, 26)
  t.is(results[0].identity.model, 'A2')
  for (const r of results) t.is(r, results[0], 'every caller gets the same snapshot object')
})

test('reads inside the TTL are served from cache, and expire after it', async (t) => {
  const { client, connections } = await boot(t, { clientOpts: { cacheTtlMs: 120 } })

  await client.stats()
  await client.stats()
  t.is(connections(), 1, 'second read inside the window does not touch the miner')

  const meta = await client.statsWithMeta()
  t.is(meta.cached, true)
  t.ok(meta.ageMs >= 0)

  await new Promise((resolve) => setTimeout(resolve, 150))
  await client.stats()
  t.is(connections(), 2, 'a stale window refetches')
})

test('each source caches independently', async (t) => {
  const { client, connections } = await boot(t)
  await Promise.all([client.stats(), client.summary(), client.pools(), client.version()])
  t.is(connections(), 4, 'stats, summary, pools and version are four separate reads')
})

test('a write invalidates cached reads so the effect is visible', async (t) => {
  const { client } = await boot(t, { series: 'a2', clientOpts: { cacheTtlMs: 60000 } })

  t.is((await client.stats()).state.miningMode, 'normal')
  await client.setWorkMode('low_power')
  t.is((await client.stats()).state.miningMode, 'low_power', 'a long TTL does not hide a write')
})

test('version is never invalidated by a write', async (t) => {
  const { client, connections } = await boot(t)
  await client.version()
  const before = connections()
  await client.setTimezone('UTC')
  await client.version()
  t.is(connections(), before + 1, 'only the write hit the wire; version stayed cached')
})

test('commands reach the miner and change its state', async (t) => {
  const { client, mock } = await boot(t, { series: 'a2' })

  await client.setPowerLimit(3000)
  t.is(mock.state.powerLimit, 3000)

  await client.suspend()
  t.is(mock.state.pmState, 'suspended')
  const suspended = await client.stats()
  t.is(suspended.hashrate.avg, 0)
  t.is(suspended.psu.inputPower, 0)

  await client.resume()
  t.is(mock.state.pmState, 'running')

  await client.setTimezone('Asia/Singapore')
  t.is(mock.state.timezone, 'Asia/Singapore')

  await client.setIdleFanTimer({ interval: '30', on_duration: '10', speed: '20' })
  t.is(mock.state.idleFanTimer.speed, '20')

  await client.updatePools([{ url: 'stratum+tcp://p.example:3333', user: 'w', pass: 'x' }])
  t.is(mock.state.pools[0].url, 'stratum+tcp://p.example:3333')

  await client.restartMiner()
  await client.reboot()
  t.is(mock.state.pmState, 'initializing')
})

test('the miner refusing a mode surfaces as a stable error', async (t) => {
  // A3 has no low_power; the mock enforces that like the firmware does.
  const { client } = await boot(t, { series: 'a3' })
  await t.exception(client.setWorkMode('low_power'), /ERR_ASCSET_FAILED/)
})

test('firmware gating is enforced by the device, not just by our table', async (t) => {
  const { client } = await boot(t, { firmware: '20250620' })
  await t.exception(client.setHostname('sealminer-1'), /ERR_INVALID_CMD/)
  await t.exception(client.setIdleFanTimer({ interval: '30', on_duration: '10', speed: '20' }), /ERR_INVALID_CMD/)
})

test('getCapabilities derives the descriptor from live stats', async (t) => {
  const { client } = await boot(t, { series: 'a2', firmware: '2026060901' })
  const caps = await client.getCapabilities()
  t.is(caps.model, 'A2')
  t.is(caps.series, 'A2', 'resolved from the model string')
  t.is(caps.firmwareResolved, true)
  t.ok(caps.powerModes.includes('low_power'))
  t.is(caps.commands.setHostname.supported, true)
})

test('an explicitly configured series overrides model inference', async (t) => {
  const { client } = await boot(t, { series: 'a2', clientOpts: { series: 'A4' } })
  const caps = await client.getCapabilities()
  t.is(caps.series, 'A4')
  t.is(caps.seriesSource, 'config')
  t.absent(caps.powerModes.includes('low_power'))
})

test('board-level reads report truncation instead of a short array', async (t) => {
  const { client } = await boot(t, { chipCount: 1092, includeChips: true, truncateAt: 4096 })

  const s = await client.stats()
  t.is(s.truncated, true)
  t.is(s.boardsComplete, false)

  t.is(await client.boards(), null, 'boards() refuses to return a partial fleet')
  await t.exception(client.boardsOrThrow(), /ERR_STATS_TRUNCATED/)
})

test('snapshot carries freshness and truncation metadata', async (t) => {
  const { client } = await boot(t)
  const snap = await client.snapshot()
  t.ok(snap.ts > 0)
  t.is(typeof snap.cached, 'boolean')
  t.is(typeof snap.ageMs, 'number')
  t.is(snap.truncated, false)
  t.is(snap.boardsComplete, true)
  t.ok(snap.stats && snap.summary && snap.pools && snap.version && snap.config)
})

// Counts only the attempts carrying its own command. Two tests here run
// servers that drop every connection; ports get recycled inside one process,
// so a late retry from the other test can land here and inflate a raw
// connection count. Filtering by payload makes each count independent.
const droppingServer = (command) => {
  let attempts = 0
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      if (String(chunk).includes(`"${command}"`)) attempts++
      // RST, not FIN: a clean close would deliver an empty reply, which the
      // client classifies as a corrupted response rather than a dropped
      // connection — a different error class and a different retry rule.
      socket.resetAndDestroy()
    })
    socket.on('error', () => {})
  })
  return { server, attempts: () => attempts }
}

test('connection errors get one bounded retry', async (t) => {
  const { server: flaky, attempts } = droppingServer('stats')
  flaky.listen(0, '127.0.0.1')
  await new Promise((resolve) => flaky.once('listening', resolve))
  t.teardown(() => flaky.close())

  const client = createClient({ host: '127.0.0.1', port: flaky.address().port, timeoutMs: 500 })
  t.teardown(() => client.stop())

  await t.exception(client.stats(), /ERR_API_CONNECTION/)
  t.is(attempts(), 2, 'one retry, then give up')
})

test('timeouts are not retried', async (t) => {
  let connections = 0
  const silent = net.createServer(() => { connections++ })
  silent.listen(0, '127.0.0.1')
  await new Promise((resolve) => silent.once('listening', resolve))
  t.teardown(() => silent.close())

  const client = createClient({ host: '127.0.0.1', port: silent.address().port, timeoutMs: 200 })
  t.teardown(() => client.stop())

  await t.exception(client.stats(), /ERR_API_TIMEOUT/)
  t.is(connections, 1, 'a busy miner is not hammered')
})

test('writes are never retried', async (t) => {
  const { server: flaky, attempts } = droppingServer('reboot')
  flaky.listen(0, '127.0.0.1')
  await new Promise((resolve) => flaky.once('listening', resolve))
  t.teardown(() => flaky.close())

  const client = createClient({ host: '127.0.0.1', port: flaky.address().port, timeoutMs: 500 })
  t.teardown(() => client.stop())

  await t.exception(client.reboot(), /ERR_API_CONNECTION/)
  t.is(attempts(), 1, 'a physical write whose outcome is unknown is attempted once')
})

test('rejects an invalid device config', (t) => {
  t.exception(() => createClient({}), /ERR_DEVICE_CONFIG_INVALID/)
  t.exception(() => createClient({ host: '127.0.0.1', port: 'abc' }), /ERR_DEVICE_CONFIG_INVALID/)
  t.execution(() => createClient({ address: '127.0.0.1' }), 'address is accepted as an alias')
})

test('the mock can reproduce a firmware that accepts a write and ignores it', async (t) => {
  // Captured from a real A2 on firmware 2026040101: ascset powerlimit answers
  // "ASC 0 set OK" for every value and Power Limit never changes.
  const { client, mock } = await boot(t, { faults: ['powerlimit_noop'] })

  t.is((await client.stats()).settings.powerLimit, 4300)
  await client.setPowerLimit(3000) // the device reports success
  t.is(mock.state.powerLimit, 4300, 'and changes nothing')
  t.is((await client.stats()).settings.powerLimit, 4300, 'the readback is what exposes it')
})

test('the client sends every ascset value as a string', async (t) => {
  // Verified against a real A2 (firmware 2026040101): a number or a boolean
  // is refused with 'Missing "<key>"', even where the document calls the
  // field an int or a boolean. The client converts, so a caller cannot get
  // this wrong — and booleans go as "1"/"0", since "true"/"false" are
  // refused as invalid.
  const { client, mock } = await boot(t)

  await client.setPowerLimit(3000)
  t.is(mock.state.powerLimit, 3000, 'a number argument still lands as a string')

  await client.setFastRaiseFreq(true)
  t.is(mock.state.fastRaiseFreq, true, 'a boolean argument lands as "1"')
  await client.setFastRaiseFreq(false)
  t.is(mock.state.fastRaiseFreq, false, 'and as "0"')

  await client.setIdleFanTimer({ interval: 30, on_duration: 10, speed: 20 })
  t.is(mock.state.idleFanTimer.speed, '20', 'numbers inside an object argument too')
})

test('the mock refuses non-string values exactly as the firmware does', async (t) => {
  // The rule has to be enforced by the device side, or the test only proves
  // the client agrees with itself. These bypass the client's conversion.
  const { mock } = await boot(t)
  const { TcpRpc } = require('../../lib/tcp-rpc')
  const rpc = new TcpRpc({ host: '127.0.0.1', port: mock.port, timeoutMs: 2000 })
  t.teardown(() => rpc.stop())

  const send = async (parameter) => {
    const { body } = await rpc.request({ command: 'ascset', parameter })
    return body.STATUS[0]
  }

  t.ok(/Missing "value"/.test((await send('0,powerlimit,{"value":3000}')).Msg), 'a numeric powerlimit')
  t.ok(/Missing "value"/.test((await send('0,fast-raise-freq,{"value":true}')).Msg), 'a boolean fast-raise-freq')
  t.ok(/Invalid "enable_fast_raise_freq"/.test((await send('0,fast-raise-freq,{"value":"true"}')).Msg), '"true" is not "1"')
  t.ok(/Missing "mode"/.test((await send('0,workmode,{"mode":1}')).Msg), 'a numeric workmode')
  t.is((await send('0,powerlimit,{"value":"3000"}')).Code, 119, 'the string form is accepted')
})

test('preheat requires all four fields, in the order the firmware complains', async (t) => {
  // A real A2 refuses each missing field in turn; the document presents
  // temp/timeout as incidental, which they are not.
  const { mock } = await boot(t)
  const { TcpRpc } = require('../../lib/tcp-rpc')
  const rpc = new TcpRpc({ host: '127.0.0.1', port: mock.port, timeoutMs: 2000 })
  t.teardown(() => rpc.stop())
  const send = async (args) => {
    const { body } = await rpc.request({ command: 'ascset', parameter: `0,preheat,${JSON.stringify(args)}` })
    return body.STATUS[0]
  }

  t.ok(/Missing "enable_boot_preheat"/.test((await send({})).Msg))
  t.ok(/Missing "boot_preheat_temp"/.test((await send({ enable_boot_preheat: '1' })).Msg))
  t.ok(/Missing "boot_preheat_timeout"/.test((await send({ enable_boot_preheat: '1', boot_preheat_temp: '20' })).Msg))
  t.ok(/Missing "enable_tune_preheat"/.test(
    (await send({ enable_boot_preheat: '1', boot_preheat_temp: '20', boot_preheat_timeout: '-1' })).Msg))
  t.is((await send({
    enable_boot_preheat: '1', boot_preheat_temp: '20', boot_preheat_timeout: '-1', enable_tune_preheat: '1'
  })).Code, 119, 'all four present is accepted')

  // The firmware does NOT enforce the documented 0..35 range on temp.
  t.is((await send({
    enable_boot_preheat: '1', boot_preheat_temp: '99', boot_preheat_timeout: '-1', enable_tune_preheat: '1'
  })).Code, 119, 'an out-of-range temp is accepted by the device — only our own check stops it')
})

test('a firmware that ignores setFastRaiseFreq is caught by the readback', async (t) => {
  const { client, mock } = await boot(t, { faults: ['fastraisefreq_noop'] })
  t.is((await client.stats()).settings.fastRaiseFreq, false)
  await client.setFastRaiseFreq(true) // reports success
  t.is(mock.state.fastRaiseFreq, false, 'and changes nothing')
})

test('on older firmware a mining setting is stored and applied at the next restart', async (t) => {
  // The behaviour that matters most: a miner set to sleep keeps hashing and
  // keeps reporting its old mode, then stops the moment anything restarts
  // bdminer. Confirmed on a real A2 (firmware 2026040101) — and it is what
  // made "accepted but unchanged" look like a silent no-op.
  // The behaviour is still real and still reproduced by the mock; what is gone
  // is reporting it per device. capabilities no longer carries a flag for it,
  // because the API cannot read a pending value back and a version table was
  // only ever guessing — so these assertions cover the device, not the guess.
  const { client, mock } = await boot(t, { firmware: '2026040101' })

  t.absent((await client.getCapabilities()).settingsApplyImmediately,
    'the per-device flag is no longer reported')

  t.is((await client.stats()).state.miningMode, 'normal')
  await client.setWorkMode('sleep')
  t.is((await client.stats()).state.miningMode, 'normal', 'still reports the running mode')
  t.is((await client.stats()).state.pmState, 'running', 'and is still mining')
  t.is(mock.state.pending.miningMode, 'sleep', 'the value is stored, not discarded')

  await client.restartMiner()
  // A sleeping miner shows up as PM State Suspended, not as a Mining Mode of
  // "sleep": the documented Mining Mode values contain no Sleep, and that is
  // how the real A2 presented after a restart applied a stored sleep.
  t.is((await client.stats()).state.pmState, 'suspended', 'the restart applies it and mining stops')
  t.is((await client.stats()).hashrate.m1, 0)
})

test('on current firmware a mining setting applies at once', async (t) => {
  const { client } = await boot(t, { firmware: '2026060901' })
  await client.setWorkMode('low_power')
  t.is((await client.stats()).state.miningMode, 'low_power', 'no restart needed')
})
