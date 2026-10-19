'use strict'

const net = require('node:net')
const test = require('brittle')
const { TcpRpc } = require('../../lib/tcp-rpc')
const { assertOk, section } = require('../../lib/parser/status')
const { createServer } = require('../../mock/server')

const boot = async (t, opts = {}) => {
  const mock = createServer({ includeChips: false, ...opts })
  const address = await mock.ready
  t.teardown(() => mock.close())
  return { mock, rpc: new TcpRpc({ host: '127.0.0.1', port: address.port, timeoutMs: 2000 }) }
}

test('round-trips every read command against the mock', async (t) => {
  const { rpc } = await boot(t)
  const cases = [
    ['version', 'VERSION'],
    ['summary', 'SUMMARY'],
    ['config', 'CONFIG'],
    ['devs', 'DEVS'],
    ['pools', 'POOLS'],
    ['devdetails', 'DEVDETAILS'],
    ['stats', 'STATS'],
    ['coin', 'COIN']
  ]
  for (const [command, sectionName] of cases) {
    const { body, truncated } = await rpc.request({ command })
    t.execution(() => assertOk(body, command), `${command} reports success`)
    t.ok(section(body, sectionName), `${command} carries ${sectionName}`)
    t.is(truncated, false, `${command} is not truncated`)
  }
})

test('id: 0 is surfaced as truncated', async (t) => {
  const { rpc } = await boot(t, { chipCount: 1092, includeChips: true, truncateAt: 4096 })
  const { body, truncated } = await rpc.request({ command: 'stats' })
  t.is(truncated, true, 'the reply declares itself clipped')
  t.is(body.id, 0)
  t.execution(() => assertOk(body, 'stats'), 'a clipped reply still reports success')
  t.ok(section(body, 'STATS'), 'the partial payload is still parseable')
})

test('unknown commands map to ERR_INVALID_CMD', async (t) => {
  const { rpc } = await boot(t)
  const { body } = await rpc.request({ command: 'definitely-not-a-command' })
  t.exception(() => assertOk(body, 'bogus'), /ERR_INVALID_CMD/)
})

test('malformed request JSON maps to ERR_JSON_CMD', async (t) => {
  const { mock } = await boot(t)
  const raw = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: mock.port })
    const chunks = []
    socket.once('connect', () => socket.end('{not json'))
    socket.on('data', (c) => chunks.push(c))
    socket.once('end', () => resolve(Buffer.concat(chunks).toString()))
    socket.once('error', reject)
  })
  t.exception(() => assertOk(JSON.parse(raw), 'raw'), /ERR_JSON_CMD/)
})

test('writes disabled on the miner map to ERR_ACCESS_DENIED', async (t) => {
  const { rpc } = await boot(t, { writesEnabled: false })

  const reboot = await rpc.request({ command: 'reboot' })
  t.exception(() => assertOk(reboot.body, 'reboot'), /ERR_ACCESS_DENIED/)

  const ascset = await rpc.request({ command: 'ascset', parameter: '0,workmode,{"mode":"normal"}' })
  t.exception(() => assertOk(ascset.body, 'ascset'), /ERR_ACCESS_DENIED/)

  const stats = await rpc.request({ command: 'stats' })
  t.execution(() => assertOk(stats.body, 'stats'), 'reads keep working')
})

test('an unreachable miner fails with ERR_API_CONNECTION', async (t) => {
  // Port 1 has nothing listening.
  const rpc = new TcpRpc({ host: '127.0.0.1', port: 1, timeoutMs: 1000 })
  await t.exception(rpc.request({ command: 'stats' }), /ERR_API_CONNECTION/)
})

test('a silent miner fails with ERR_API_TIMEOUT', async (t) => {
  const silent = net.createServer(() => { /* accept and never answer */ })
  silent.listen(0, '127.0.0.1')
  await new Promise((resolve) => silent.once('listening', resolve))
  t.teardown(() => silent.close())

  const rpc = new TcpRpc({ host: '127.0.0.1', port: silent.address().port, timeoutMs: 300 })
  await t.exception(rpc.request({ command: 'stats' }), /ERR_API_TIMEOUT/)
  rpc.stop()
})

test('a non-JSON reply fails with ERR_API_RESPONSE_INVALID', async (t) => {
  const garbage = net.createServer((socket) => {
    socket.once('end', () => socket.end('<html>login</html>'))
    socket.on('data', () => {})
  })
  garbage.listen(0, '127.0.0.1')
  await new Promise((resolve) => garbage.once('listening', resolve))
  t.teardown(() => garbage.close())

  const rpc = new TcpRpc({ host: '127.0.0.1', port: garbage.address().port, timeoutMs: 1000 })
  await t.exception(rpc.request({ command: 'stats' }), /ERR_API_RESPONSE_INVALID/)
})

test('an oversized reply fails with ERR_API_RESPONSE_TOO_LARGE', async (t) => {
  const { mock } = await boot(t, { chipCount: 1092, includeChips: true })
  const rpc = new TcpRpc({ host: '127.0.0.1', port: mock.port, timeoutMs: 2000, maxResponseBytes: 1024 })
  await t.exception(rpc.request({ command: 'stats' }), /ERR_API_RESPONSE_TOO_LARGE/)
})

test('request rejects a malformed command object', (t) => {
  const rpc = new TcpRpc({ host: '127.0.0.1', port: 4028 })
  t.exception(() => rpc.request(null), /ERR_API_REQUEST_INVALID/)
  t.exception(() => rpc.request({}), /ERR_API_REQUEST_INVALID/)
})

test('TcpRpc requires a host', (t) => {
  t.exception(() => new TcpRpc({}), /ERR_API_REQUEST_INVALID/)
})
