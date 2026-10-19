'use strict'

const test = require('brittle')
const { createGuard, DANGER } = require('../../lib/command-guard')
const { fail, ERR_PARAM_REQUIRED } = require('../../lib/errors')

const harness = (deps = {}) => {
  const events = []
  let clock = 1_000_000
  const guard = createGuard({
    deviceId: 'SM-A2-001',
    audit: (e) => events.push(e),
    now: () => clock,
    ...deps
  })
  return {
    guard,
    events,
    advance: (ms) => { clock += ms },
    outcomes: () => events.map((e) => `${e.command}:${e.outcome}`),
    codes: () => events.filter((e) => e.errorCode).map((e) => e.errorCode)
  }
}

test('a successful command audits started then succeeded', async (t) => {
  const h = harness()
  const run = h.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE })(async () => 'ok')

  t.is(await run(), 'ok')
  t.alike(h.outcomes(), ['reboot:started', 'reboot:succeeded'])
  t.is(h.events[0].deviceId, 'SM-A2-001')
  t.is(h.events[0].event, 'physical_command')
  t.is(h.events[0].class, 'disruptive')
  t.is(h.events[0].retryable, false)
})

test('cooldown is enforced, not merely declared', async (t) => {
  const h = harness()
  const run = h.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE, cooldownMs: 300_000 })(async () => 'ok')

  await run()
  await t.exception(run(), /ERR_COMMAND_COOLDOWN/)

  h.advance(299_999)
  await t.exception(run(), /ERR_COMMAND_COOLDOWN/)

  h.advance(1)
  t.is(await run(), 'ok', 'available again once the window elapses')
})

test('a failed attempt still consumes the cooldown', async (t) => {
  // A write that failed or timed out may have been executed by the miner, so
  // it must not be repeatable immediately.
  const h = harness()
  const run = h.guard({ name: 'suspend', danger: DANGER.DISRUPTIVE, cooldownMs: 60_000 })(
    async () => { throw new Error('ERR_API_TIMEOUT: suspend') }
  )

  await t.exception(run(), /ERR_API_TIMEOUT/)
  await t.exception(run(), /ERR_COMMAND_COOLDOWN/, 'the failure did not reset the clock')
  t.ok(h.events.some((e) => e.outcome === 'failed' && e.errorCode === 'ERR_API_TIMEOUT'))
})

const deferred = () => {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, resolve: settle }
}

test('concurrent commands of the same kind are rejected', async (t) => {
  const h = harness()
  const firstCall = deferred()
  const secondCall = deferred()
  const queue = [firstCall, secondCall]
  const run = h.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE })(() => queue.shift().promise)

  const first = run()
  await t.exception(run(), /ERR_COMMAND_IN_PROGRESS/)
  firstCall.resolve('ok')
  t.is(await first, 'ok')

  const second = run()
  secondCall.resolve('ok')
  t.is(await second, 'ok', 'the slot frees up once the first settles')
})

test('an in-flight slot is released even when the command throws', async (t) => {
  const h = harness()
  const run = h.guard({ name: 'setTimezone', danger: DANGER.SAFE })(
    async () => { throw new Error('ERR_API_CONNECTION: boom') }
  )
  await t.exception(run(), /ERR_API_CONNECTION/)
  await t.exception(run(), /ERR_API_CONNECTION/, 'not ERR_COMMAND_IN_PROGRESS')
})

test('non-exclusive commands may overlap', async (t) => {
  const h = harness()
  const run = h.guard({ name: 'setTimezone', danger: DANGER.SAFE, exclusive: false })(
    () => new Promise((resolve) => setTimeout(() => resolve('ok'), 5))
  )
  const results = await Promise.all([run(), run(), run()])
  t.alike(results, ['ok', 'ok', 'ok'])
})

test('validation runs before cooldown so errors are informative', async (t) => {
  const h = harness()
  const run = h.guard({
    name: 'setPowerLimit',
    danger: DANGER.REVERSIBLE,
    cooldownMs: 60_000,
    validate: (params) => {
      if (params.watts === undefined) fail(ERR_PARAM_REQUIRED, 'watts')
      return params
    }
  })(async () => 'ok')

  await run({ watts: 3000 })
  // Still inside the cooldown, but the parameter error is the useful one.
  await t.exception(run({}), /ERR_PARAM_REQUIRED/)
  t.ok(h.codes().includes('ERR_PARAM_REQUIRED'))
  t.absent(h.codes().includes('ERR_COMMAND_COOLDOWN'), 'a malformed call is not masked by cooldown')
})

test('a rejected parameter never reaches the device', async (t) => {
  const h = harness()
  let called = 0
  const run = h.guard({
    name: 'setPowerLimit',
    danger: DANGER.REVERSIBLE,
    validate: () => fail(ERR_PARAM_REQUIRED, 'watts')
  })(async () => { called++ })

  await t.exception(run({}), /ERR_PARAM_REQUIRED/)
  t.is(called, 0)
  t.alike(h.outcomes(), ['setPowerLimit:rejected'])
})

test('validate may normalize the params the handler receives', async (t) => {
  const h = harness()
  let seen
  const run = h.guard({
    name: 'setIdleFanTimer',
    danger: DANGER.REVERSIBLE,
    validate: (params) => ({ speed: Number(params.speed) })
  })(async (params) => { seen = params })

  await run({ speed: '20', extra: 'dropped' })
  t.alike(seen, { speed: 20 }, 'the handler sees the normalized object only')
})

test('an unsupported command is refused with its fallback named', async (t) => {
  const h = harness({
    getCapabilities: async () => ({
      firmware: '2025090101',
      commands: {
        resume: { supported: false, reason: 'requires firmware >= 2026060101', fallback: 'restartMiner' }
      }
    })
  })
  let called = 0
  const run = h.guard({ name: 'resume', danger: DANGER.DISRUPTIVE })(async () => { called++ })

  await t.exception(run(), /ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE/)
  t.is(called, 0, 'the device is never contacted')
  const rejected = h.events.find((e) => e.outcome === 'rejected')
  t.is(rejected.fallback, 'restartMiner')
  t.is(rejected.firmware, '2025090101')
})

test('a supported command passes the capability check', async (t) => {
  const h = harness({
    getCapabilities: async () => ({ commands: { resume: { supported: true } } })
  })
  const run = h.guard({ name: 'resume', danger: DANGER.DISRUPTIVE })(async () => 'ok')
  t.is(await run(), 'ok')
})

test('an unreachable device does not become a capability verdict', async (t) => {
  // If capabilities cannot be read, let the command fail against the device
  // rather than inventing a reason it is unsupported.
  const h = harness({
    getCapabilities: async () => { throw new Error('ERR_API_CONNECTION: down') }
  })
  let called = 0
  const run = h.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE })(async () => { called++; return 'ok' })

  t.is(await run(), 'ok')
  t.is(called, 1)
})

test('cooldown, concurrency and capability state are per guard instance', async (t) => {
  // The runtime gives each device its own module registry, so two devices
  // mean two guards and neither can block the other.
  const a = harness()
  const b = harness()
  const runA = a.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE, cooldownMs: 300_000 })(async () => 'a')
  const runB = b.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE, cooldownMs: 300_000 })(async () => 'b')

  t.is(await runA(), 'a')
  await t.exception(runA(), /ERR_COMMAND_COOLDOWN/)
  t.is(await runB(), 'b', 'a sibling device is unaffected')
})

test('safe commands are marked retryable, everything else is not', async (t) => {
  const h = harness()
  for (const [danger, retryable] of [
    [DANGER.SAFE, true],
    [DANGER.REVERSIBLE, false],
    [DANGER.DISRUPTIVE, false],
    [DANGER.RISKY, false]
  ]) {
    const run = h.guard({ name: `cmd-${danger}`, danger })(async () => 'ok')
    await run()
    const started = h.events.find((e) => e.command === `cmd-${danger}` && e.outcome === 'started')
    t.is(started.retryable, retryable, danger)
  }
})

test('the default audit sink emits one JSON line per event', async (t) => {
  const lines = []
  const original = console.info
  console.info = (line) => lines.push(line)
  t.teardown(() => { console.info = original })

  const guard = createGuard({ deviceId: 'SM-A2-002' })
  await guard({ name: 'setTimezone', danger: DANGER.SAFE })(async () => 'ok')()

  t.is(lines.length, 2)
  const parsed = JSON.parse(lines[0])
  t.is(parsed.event, 'physical_command')
  t.is(parsed.deviceId, 'SM-A2-002')
  t.is(parsed.command, 'setTimezone')
  t.ok(parsed.ts > 0)
  t.absent('password' in parsed, 'audit events never carry credentials')
})

test('a write is annotated, never adjudicated', async (t) => {
  // Every write on this API is asynchronous — the firmware replies first and
  // executes afterwards — so a "did it apply?" check inside the command would
  // be premature by construction. An earlier version of this guard did that
  // and failed writes that had in fact been accepted and stored, which is the
  // more dangerous error: an operator who reads "not applied" walks away
  // having left a change armed.
  const h = harness()
  const run = h.guard({
    name: 'setPowerMode',
    danger: DANGER.REVERSIBLE,
    describe: async (params) => ({
      accepted: params.mode,
      appliesOn: 'next bdminer restart',
      pending: true,
      confirmWith: 'power_mode',
      detail: 'stored; firmware 2026040101 applies this on restart'
    })
  })(async () => ({ STATUS: 'ok' }))

  const result = await run({ mode: 'sleep' })
  t.is(result.accepted, 'sleep')
  t.is(result.pending, true)
  t.is(result.appliesOn, 'next bdminer restart')
  t.is(result.confirmWith, 'power_mode')
  t.is(result.STATUS, 'ok', 'the device reply is preserved alongside the annotation')

  t.alike(h.outcomes(), ['setPowerMode:started', 'setPowerMode:succeeded'],
    'accepted is a success: the device took the request')
  const done = h.events.find((e) => e.outcome === 'succeeded')
  t.is(done.pending, true, 'and the audit trail records that something is armed')
  t.ok(/2026040101/.test(done.detail))
})

test('a describe hook never turns a successful write into a failure', async (t) => {
  const h = harness()
  const run = h.guard({
    name: 'setPowerLimit',
    danger: DANGER.REVERSIBLE,
    describe: async () => ({ accepted: 4200, appliesOn: 'shortly', confirmWith: 'power_limit' })
  })(async () => 'raw-reply')

  const result = await run({ watts: 4200 })
  t.is(result.result, 'raw-reply', 'a non-object reply is wrapped, not dropped')
  t.is(result.appliesOn, 'shortly')
  t.absent(h.outcomes().includes('setPowerLimit:failed'))
})

test('a command with no describe hook returns the device reply untouched', async (t) => {
  const h = harness()
  const run = h.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE })(async () => ({ STATUS: 'REBOOT' }))
  t.alike(await run(), { STATUS: 'REBOOT' })
})

// --- durable cooldown ------------------------------------------------------

// A fake of src/db.js's store seam. Sync on purpose: the real one is SQLite
// DatabaseSync, and the cooldown check sits on the command path.
const fakeStore = (seed = {}) => {
  const rows = new Map(Object.entries(seed))
  return {
    rows,
    getLastAttempt: (name) => (rows.has(name) ? rows.get(name) : null),
    setLastAttempt: (name, ts) => rows.set(name, ts)
  }
}

test('a cooldown survives a restart when a store is supplied', async (t) => {
  const store = fakeStore()

  // First process: issues the command, which records the attempt.
  const first = harness({ store })
  const run1 = first.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE, cooldownMs: 300_000 })(async () => 'ok')
  t.is(await run1(), 'ok')
  t.is(store.rows.get('reboot'), 1_000_000, 'the attempt reached the store')

  // Second process: fresh guard, empty Map, same store and same clock.
  const second = harness({ store })
  const run2 = second.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE, cooldownMs: 300_000 })(async () => 'ok')
  await t.exception(run2, /ERR_COMMAND_COOLDOWN/, 'the restart did not reset the cooldown')

  // And it still expires on schedule rather than blocking forever.
  second.advance(300_001)
  t.is(await run2(), 'ok', 'the cooldown expires normally')
})

test('without a store the cooldown is process-local, as before', async (t) => {
  const first = harness()
  const run1 = first.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE, cooldownMs: 300_000 })(async () => 'ok')
  await run1()

  const second = harness()
  const run2 = second.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE, cooldownMs: 300_000 })(async () => 'ok')
  t.is(await run2(), 'ok', 'a new process starts with no cooldown state')
})

test('the newer of stored and in-memory timestamps wins', async (t) => {
  // A store that has fallen behind — a stale row, or a write that failed —
  // must not shorten a cooldown the running process knows about.
  const store = fakeStore({ suspend: 1 })
  const h = harness({ store })
  const run = h.guard({ name: 'suspend', danger: DANGER.DISRUPTIVE, cooldownMs: 60_000 })(async () => 'ok')
  await run()
  store.setLastAttempt('suspend', 1) // regress the store behind the live value
  await t.exception(run, /ERR_COMMAND_COOLDOWN/, 'in-memory state still holds')
})

test('a broken store degrades to process-local spacing, it does not fail the command', async (t) => {
  const store = {
    getLastAttempt: () => { throw new Error('SQLITE_IOERR') },
    setLastAttempt: () => { throw new Error('SQLITE_FULL') }
  }
  const h = harness({ store })
  const run = h.guard({ name: 'reboot', danger: DANGER.DISRUPTIVE, cooldownMs: 300_000 })(async () => 'ok')

  t.is(await run(), 'ok', 'a storage fault does not block a physical command')
  await t.exception(run, /ERR_COMMAND_COOLDOWN/, 'the in-memory cooldown still applies')
  t.absent(h.codes().includes('SQLITE_FULL'), 'the storage fault is not reported as a command error')
})
