'use strict'

const test = require('brittle')
const { evaluate } = require('../../lib/health')
const { parseStats } = require('../../lib/parser/stats')
const { parseSummary } = require('../../lib/parser/summary')
const { parsePools } = require('../../lib/parser/pools')
const { createState, buildStats, buildSummary, buildPools, PRODUCT_PROFILE } = require('../../mock/state')
const { resolve: resolveCaps } = require('../../lib/capabilities')

const snapshot = (opts = {}, mutate, mutateParsed) => {
  const state = createState({ includeChips: false, ...opts })
  if (mutate) mutate(state)
  const snap = {
    stats: parseStats(buildStats(state)),
    summary: parseSummary(buildSummary(state)),
    pools: parsePools(buildPools(state))
  }
  // Some conditions cannot be produced by the mock because the mock is
  // faithful to the firmware — a renamed stats key is a firmware change, not
  // a device state — so they are made on the parsed result.
  if (mutateParsed) mutateParsed(snap)
  return snap
}

const codes = (result) => result.details.map((d) => d.code)

test('a healthy miner is OK with no alerts', (t) => {
  const h = evaluate(snapshot())
  t.is(h.status, 'OK')
  t.alike(h.alerts, [])
  t.alike(codes(h), [])
  t.ok(h.checkedAt > 0)
})

test('a tuning miner stays OK and reports info.tuning', (t) => {
  const h = evaluate(snapshot({}, (s) => { s.tuneStatus = 'coarse_tuning' }))
  t.is(h.status, 'OK', 'tuning is an expected state, not a fault')
  t.ok(codes(h).includes('info.tuning'))
  t.alike(h.alerts, [])
})

test('info.tuning suppresses alert.hashrate_low', (t) => {
  // A board offline drops the performance ratio well below the threshold.
  const tuning = evaluate(snapshot({ faults: ['board_offline'] }, (s) => { s.tuneStatus = 'fine_tuning' }))
  t.absent(codes(tuning).includes('alert.hashrate_low'), 'not alerted while tuning')

  const settled = evaluate(snapshot({ faults: ['board_offline'] }))
  t.ok(codes(settled).includes('alert.hashrate_low'), 'alerted once tuning has finished')
})

test('a suspended miner stays OK and does not trip the fan or PSU alerts', (t) => {
  // suspend stops the fans and shuts the PSU output down on purpose; the
  // mock reports the non-zero PSU error word a real A2 shows in that state.
  const h = evaluate(snapshot({}, (s) => { s.pmState = 'suspended' }))
  t.is(h.status, 'OK')
  t.ok(codes(h).includes('info.suspended'))
  t.ok(codes(h).includes('info.psu_output_off'), 'the PSU word is explained, not alerted')
  t.absent(codes(h).includes('alert.fan_failure'))
  t.absent(codes(h).includes('alert.psu_error'))
  t.absent(codes(h).includes('alert.hashrate_low'))
})

test('a stopped fan on a running miner is an alert', (t) => {
  const h = evaluate(snapshot({ faults: ['fan_stopped'] }))
  t.is(h.status, 'DEGRADED')
  t.ok(h.alerts.includes('alert.fan_failure'))
  t.ok(/0 RPM/.test(h.details.find((d) => d.code === 'alert.fan_failure').detail))
})

test('overheating is measured against the firmware target, not a constant', (t) => {
  t.is(evaluate(snapshot({}, (s) => { s.temp = s.targetCtrlTemp + 4 })).status, 'OK')
  const hot = evaluate(snapshot({}, (s) => { s.temp = s.targetCtrlTemp + 5 }))
  t.is(hot.status, 'DEGRADED')
  t.ok(hot.alerts.includes('alert.overheat'))
})

test('PSU faults are reported separately from board faults', (t) => {
  const err = evaluate(snapshot({ faults: ['psu_error'] }))
  t.ok(err.alerts.includes('alert.psu_error'))

  const hot = evaluate(snapshot({ faults: ['psu_overheat'] }))
  t.ok(hot.alerts.includes('alert.psu_overheat'))
})

test('board faults are attributed to a board index', (t) => {
  const h = evaluate(snapshot({ faults: ['board_offline'] }))
  t.ok(h.alerts.includes('alert.hashboard_offline'))
  t.ok(h.alerts.includes('alert.hashboard_low_hash'))
  t.ok(/board\(s\) 0/.test(h.details.find((d) => d.code === 'alert.hashboard_offline').detail))
})

test('bad chips alert only past the configured ratio', (t) => {
  const h = evaluate(snapshot({ faults: ['bad_chip'] }))
  t.ok(h.alerts.includes('alert.bad_chip'))
  t.absent(evaluate(snapshot()).alerts.includes('alert.bad_chip'))
})

test('a firmware error code is surfaced verbatim', (t) => {
  const h = evaluate(snapshot({ faults: ['device_error'] }))
  t.ok(h.alerts.includes('alert.device_error'))
  t.ok(/0x00000101/.test(h.details.find((d) => d.code === 'alert.device_error').detail))
})

test('a dead stratum connection is an alert', (t) => {
  const h = evaluate(snapshot({ faults: ['stratum_disconnect'] }))
  t.ok(h.alerts.includes('alert.pool_disconnected'))
})

test('no active pool is an alert even when the firmware flag is clear', (t) => {
  const snap = snapshot()
  for (const pool of snap.pools) pool.stratum.active = false
  t.ok(evaluate(snap).alerts.includes('alert.pool_disconnected'))
})

test('a failed suspend or resume transition is a device error', (t) => {
  for (const state of ['resume_failed', 'suspend_failed']) {
    const h = evaluate(snapshot({}, (s) => { s.pmState = state }))
    t.ok(h.alerts.includes('alert.device_error'), state)
  }
})

test('truncation is a warning, not a fault', (t) => {
  const state = createState({ includeChips: false })
  const raw = buildStats(state)
  for (const key of Object.keys(raw)) if (key.startsWith('2 ')) delete raw[key]

  const h = evaluate({ stats: parseStats(raw, { truncated: true }) })
  t.is(h.status, 'OK', 'a protocol limitation is not a device fault')
  t.ok(codes(h).includes('warn.stats_truncated'))
  t.ok(/2\/3 boards/.test(h.details.find((d) => d.code === 'warn.stats_truncated').detail))
})

test('unreadable enums are a warning that names the consequence', (t) => {
  const h = evaluate(snapshot({ legacyTypes: true }))
  t.ok(codes(h).includes('warn.enum_unreadable'))
  t.is(h.status, 'OK')
})

test('a high reject rate warns without degrading the device', (t) => {
  const h = evaluate(snapshot({}, (s) => {
    s.pools[0].accepted = 80
    s.pools[0].rejected = 20
  }))
  t.ok(codes(h).includes('warn.reject_rate_high'))
  t.is(h.status, 'OK', 'the pool or network is the likely fault domain')
})

test('no telemetry at all reports OFFLINE', (t) => {
  const h = evaluate({})
  t.is(h.status, 'OFFLINE')
  t.alike(h.alerts, ['alert.unreachable'])
})

test('multiple faults are all reported and deduplicated', (t) => {
  const h = evaluate(snapshot({ faults: ['fan_stopped', 'psu_error', 'board_offline', 'overheat', 'device_error'] }))
  t.is(h.status, 'DEGRADED')
  for (const code of ['alert.fan_failure', 'alert.psu_error', 'alert.hashboard_offline', 'alert.overheat', 'alert.device_error']) {
    t.ok(h.alerts.includes(code), code)
  }
  t.is(new Set(h.alerts).size, h.alerts.length, 'alert codes are unique')
})

// One battery of scenarios, shared by the two coverage tests below so they
// cannot drift apart. Every code the contract declares has to be producible
// by something in here; anything produced here has to be declared.
// A clipped stats reply needs a hand-built raw payload rather than a state
// mutation, so it is assembled separately. Shared, so the coverage battery
// and the tests that reason about truncation cannot disagree about it.
const clippedSnapshot = () => {
  const state = createState({ includeChips: false })
  const raw = buildStats(state)
  for (const key of Object.keys(raw)) if (key.startsWith('2 ')) delete raw[key]
  return { stats: parseStats(raw, { truncated: true }) }
}

const coverageScenarios = () => {
  return [
    snapshot(),
    snapshot({ faults: ['fan_stopped', 'psu_error', 'psu_overheat', 'board_offline', 'board_low_hash', 'bad_chip', 'overheat', 'device_error', 'stratum_disconnect'] }),
    snapshot({ legacyTypes: true }),
    snapshot({}, (s) => { s.tuneStatus = 'coarse_tuning' }),
    snapshot({}, (s) => { s.pmState = 'suspended' }),
    snapshot({}, (s) => { s.pmState = 'resume_failed' }),
    snapshot({}, (s) => { s.pools[0].rejected = 50 }),
    snapshot({}, (s) => { s.systemUptime = 60 }),
    snapshot({ series: 'a4' }),
    snapshot({ faults: ['psu_error'] }, (s) => { s.pmState = 'suspended' }),
    clippedSnapshot(),
    // A build newer than the capability table. capabilities is passed
    // separately because it is not part of a stats reply — it is derived from
    // one plus whatever the device answered about its own subcommands.
    { ...snapshot({ firmware: '2030010101' }), capabilities: resolveCaps({ model: 'A2', firmware: '2030010101' }) },
    // A renamed stats key, which is what warn.fields_unreadable exists for.
    snapshot({}, null, (snap) => { snap.stats.thermal.temp = null }),
    {}
  ]
}

const raisedCodes = () => {
  const seen = new Set()
  for (const scenario of coverageScenarios()) {
    for (const { code } of evaluate(scenario).details) seen.add(code)
  }
  return seen
}

test('every alert code raised is declared in the contract', (t) => {
  const declared = new Set(require('../../mdk-contract.json').capabilities.health.alerts)
  for (const code of raisedCodes()) {
    t.ok(declared.has(code), `${code} is declared in capabilities.health.alerts`)
  }
})

test('every alert code the contract declares can actually be raised', (t) => {
  // The other direction, and the one that rots quietly. A contract is the
  // whole interface a site and an AI operator get: if it advertises an alert
  // that no code path can produce, anything built on that code waits forever
  // for a signal that will never arrive, and nothing fails to say so.
  //
  // Declaring an alert is therefore a promise, and this test is what makes it
  // one. A new code added to the contract without a scenario that produces it
  // fails here; so does a rule deleted from lib/health.js while its code is
  // left advertised.
  const declared = require('../../mdk-contract.json').capabilities.health.alerts
  const raised = raisedCodes()
  const unreachable = declared.filter((code) => !raised.has(code))

  t.alike(unreachable, [],
    unreachable.length
      ? `declared but unreachable: ${unreachable.join(', ')} — either add a scenario to coverageScenarios() that produces it, or stop declaring it`
      : `all ${declared.length} declared codes are reachable`)
})

test('a suspended miner does not degrade on a PSU error it caused itself', (t) => {
  // Observed on a real A2: suspend shuts the PSU output down, the firmware
  // then reports a non-zero PSU error word, and health degraded a miner an
  // operator had just suspended on purpose.
  const h = evaluate(snapshot({ faults: ['psu_error'] }, (s) => { s.pmState = 'suspended' }))
  t.is(h.status, 'OK', 'an operator-requested state is not a fault')
  t.ok(codes(h).includes('info.suspended'))
  t.ok(codes(h).includes('info.psu_output_off'))
  t.absent(h.alerts.includes('alert.psu_error'))
  t.ok(/expected with the output shut down/.test(
    h.details.find((d) => d.code === 'info.psu_output_off').detail))

  // The same PSU error on a running miner is a real alert again.
  const running = evaluate(snapshot({ faults: ['psu_error'] }))
  t.ok(running.alerts.includes('alert.psu_error'))
  t.is(running.status, 'DEGRADED')
})

test('a miner still ramping after a restart is not reported as underperforming', (t) => {
  // Observed on a real A2: alert.hashrate_low fired on a miner that had come
  // back up seconds earlier and was behaving correctly.
  const ramping = evaluate(snapshot({ faults: ['board_offline'] }, (s) => { s.systemUptime = 60 }))
  t.is(ramping.status, 'DEGRADED', 'real board faults still alert')
  t.ok(codes(ramping).includes('info.starting'))
  t.absent(ramping.alerts.includes('alert.hashrate_low'), 'but low hashrate is expected while ramping')

  // A stopped fan during the ramp is not flagged either: they run flat out
  // and then settle.
  const rampFan = evaluate(snapshot({ faults: ['fan_stopped'] }, (s) => { s.systemUptime = 60 }))
  t.absent(rampFan.alerts.includes('alert.fan_failure'))

  // Once the ramp window has passed, both are alerts again.
  const settled = evaluate(snapshot({ faults: ['fan_stopped', 'board_offline'] }))
  t.ok(settled.alerts.includes('alert.fan_failure'))
  t.ok(settled.alerts.includes('alert.hashrate_low'))
  t.absent(codes(settled).includes('info.starting'))
})

test('a suspended miner is not also reported as starting', (t) => {
  const h = evaluate(snapshot({}, (s) => { s.pmState = 'suspended'; s.systemUptime = 30 }))
  t.ok(codes(h).includes('info.suspended'))
  t.absent(codes(h).includes('info.starting'), 'one explanation, not two')
})

test('a liquid-cooled miner is not reported as overheating or fanless', (t) => {
  // Measured on an A4 Ultra Hydro (10.0.0.23, firmware 2026083100):
  // healthy at 845 TH/s and fine_tuning_done, reporting temp 67-69C against
  // a Target Ctrl Temp of 60C, with no Fan Count and an empty fan list. The
  // shared target-relative rule raised alert.overheat on it, and the fan rule
  // passed only because there was nothing to iterate.
  const hydro = snapshot({
    liquidCooling: true,
    boardTempSensors: 2,
    fanCount: 0,
    targetCtrlTemp: 60
  }, (s) => { s.temp = 67 })

  const h = evaluate(hydro)
  t.is(h.status, 'OK', '+7C over target is normal on a water-cooled miner')
  t.ok(codes(h).includes('info.liquid_cooled'), 'the reason is stated, not silent')
  t.absent(h.alerts.includes('alert.overheat'))
  t.absent(h.alerts.includes('alert.fan_failure'), 'no fans is not fan failure')

  // The same delta on an air-cooled miner is still an alert.
  const air = evaluate(snapshot({ targetCtrlTemp: 60 }, (s) => { s.temp = 67 }))
  t.ok(air.alerts.includes('alert.overheat'), 'air-cooled machines keep the target-relative rule')
})

test('a liquid-cooled miner still overheats past the absolute threshold', (t) => {
  const { LIQUID_OVERHEAT_ALERT_C } = require('../../lib/provisional')
  const hot = snapshot({ liquidCooling: true, boardTempSensors: 2, fanCount: 0, targetCtrlTemp: 60 },
    (s) => { s.temp = LIQUID_OVERHEAT_ALERT_C.value + 1 })
  const h = evaluate(hot)
  t.is(h.status, 'DEGRADED', 'suppressing the target-relative rule must not disable thermal alerting')
  t.ok(h.alerts.includes('alert.overheat'))
  t.ok(/liquid-cooled/.test(h.details.find((d) => d.code === 'alert.overheat').detail))
})

test('unknown cooling type keeps the conservative rule', (t) => {
  // Firmware that does not report 'Liquid Cooling' parses as null. Alerting
  // is the safe default when the cooling type cannot be established.
  const snap = snapshot({ targetCtrlTemp: 60 }, (s) => { s.temp = 67 })
  snap.stats.thermal.liquidCooling = null
  const h = evaluate(snap)
  t.ok(h.alerts.includes('alert.overheat'), 'unknown cooling alerts rather than staying quiet')
  t.absent(codes(h).includes('info.liquid_cooled'))
})

test('cooling is orthogonal to series, and every measured product is healthy', (t) => {
  // The regression this guards: mock/state.js used to key its hardware
  // profile by series alone, hardcoding A2/A3 as air-cooled and A4 as
  // water-cooled. That is not the product line — every series ships both —
  // and it meant the two `Liquid Cooling` branches could only ever be
  // exercised on one series. Measured on an A2 Pro Hydro and an A3 Pro Hydro
  // (both reporting 'Liquid Cooling': true) and an A4 Pro Air (false).
  const seenCooling = {}

  for (const key of Object.keys(PRODUCT_PROFILE)) {
    const [series, cooling] = key.split('-')
    const snap = snapshot({ series, cooling })
    const caps = resolveCaps({
      model: snap.stats.identity.model,
      firmware: snap.stats.firmware.firmware
    })
    const h = evaluate({ ...snap, capabilities: caps })
    const seriesUpper = series.toUpperCase()

    t.is(caps.series, seriesUpper, `${key} resolves to ${seriesUpper} from its product name`)
    t.is(h.status, 'OK', `${key} is a measured-healthy profile and must not ship DEGRADED`)
    t.is(snap.stats.thermal.liquidCooling, cooling === 'hydro', `${key} reports its own cooling type`)

    // The control board string encodes the cooling type on every measured
    // product, so it is a second, independent witness that the profile is
    // internally consistent — it caught a hydro product reporting an air
    // control board.
    t.ok(new RegExp(`_${cooling === 'hydro' ? 'hydro' : 'air'}_`).test(snap.stats.identity.ctrlBoard),
      `${key} reports a ${cooling} control board (${snap.stats.identity.ctrlBoard})`)

    if (cooling === 'hydro') {
      t.ok(codes(h).includes('info.liquid_cooled'), `${key} explains why it has no fans`)
      t.absent(h.alerts.includes('alert.overheat'), `${key} is not reported as overheating`)
      t.absent(h.alerts.includes('alert.fan_failure'), `${key} having no fans is not fan failure`)
      t.is(snap.stats.fans.length, 0, `${key} emits no fan keys`)
    } else {
      t.absent(codes(h).includes('info.liquid_cooled'), `${key} is air-cooled`)
      t.ok(snap.stats.fans.length > 0, `${key} emits fan keys`)
    }

    seenCooling[series] = seenCooling[series] || new Set()
    seenCooling[series].add(cooling)
  }

  // The invariant itself: no series is single-cooling, so nothing may infer
  // cooling from the series.
  for (const [series, coolings] of Object.entries(seenCooling)) {
    t.is(coolings.size, 2, `${series} has both an air and a hydro product`)
  }
})

test('a product that reports MHS(Rated) as 0 is still healthy', (t) => {
  // Measured: the A2 Pro Hydro and A4 Pro Air both report MHS(Rated) as 0
  // while reporting a sane MHS(Ideal). Nothing may divide by it or read it
  // as a failed miner.
  for (const key of ['a2-hydro', 'a4-air']) {
    const [series, cooling] = key.split('-')
    const snap = snapshot({ series, cooling })
    t.is(snap.stats.hashrate.rated, 0, `${key} reports a rated hashrate of 0`)
    t.ok(snap.stats.hashrate.ideal > 0, `${key} still reports an ideal hashrate`)
    t.is(evaluate(snap).status, 'OK', `${key} is not mistaken for a broken miner`)
  }
})

test('a stats key that stopped arriving is reported rather than left as a silent null', (t) => {
  // The one kind of firmware drift capability discovery cannot catch. The
  // parser reads named keys, so a rename makes a channel read null — which is
  // also the honest answer for "not reported", and therefore invisible. This
  // has happened repeatedly: Chip voltage to Chip Voltage, BDMiner to
  // Bdminer.
  const healthy = evaluate(snapshot())
  t.absent(codes(healthy).includes('warn.fields_unreadable'),
    'a complete reply raises nothing')

  const renamed = evaluate(snapshot({}, null, (s) => { s.stats.thermal.temp = null }))
  t.is(renamed.status, 'OK', 'the miner is fine; our description of it is not')
  t.ok(codes(renamed).includes('warn.fields_unreadable'))
  const detail = renamed.details.find((d) => d.code === 'warn.fields_unreadable').detail
  t.ok(/temperature/.test(detail), 'the field is named')
  t.ok(/renamed/.test(detail), 'and the likely cause is stated')

  // Several at once are reported together, not one per cycle.
  const several = evaluate(snapshot({}, null, (s) => {
    s.stats.settings.powerLimit = null
    s.stats.psu.model = null
  }))
  const d = several.details.find((x) => x.code === 'warn.fields_unreadable').detail
  t.ok(/power_limit/.test(d) && /psu_model/.test(d), 'all of them in one detail')

  // A water-cooled miner has no fans and no PSU hot-spot reading. Neither is
  // a missing field, and neither may trip this.
  const hydro = evaluate(snapshot({ series: 'a4', cooling: 'hydro' }))
  t.absent(codes(hydro).includes('warn.fields_unreadable'),
    'absent-by-design fields are not in the list')

  // A clipped reply nulls board-level values legitimately; that is
  // warn.stats_truncated's job, not this one's.
  const clipped = evaluate(clippedSnapshot())
  t.absent(codes(clipped).includes('warn.fields_unreadable'),
    'truncation is reported by its own code')
  t.ok(codes(clipped).includes('warn.stats_truncated'))
})

test('a firmware newer than the table is flagged without degrading the miner', (t) => {
  // Every gate in lib/capabilities.js is `fw >= X`, which assumes features
  // are only ever added. This firmware has already broken that: `resume` was
  // removed for ten months and restored. So an unmeasured build must be
  // reported as unverified rather than silently promised as complete.
  const stats = parseStats(buildStats(createState({ firmware: '2030010101', includeChips: false })))

  const asked = evaluate({
    stats,
    capabilities: resolveCaps({
      model: 'A2',
      firmware: '2030010101',
      helpMessage: 'ASC 0 set help: suspend & resume & powerlimit & workmode & timezone & hostname & network & preheat & fast-raise-freq & stratum-disconnect-timeout & idle-fan-timer'
    })
  })
  t.is(asked.status, 'OK', 'our own stale knowledge is not a device fault')
  const w = asked.details.find((d) => d.code === 'warn.firmware_unverified')
  t.ok(w, 'the uncertainty is reported')
  t.ok(/read from the device/.test(w.detail), 'and says the command list was asked for')

  const unasked = evaluate({
    stats,
    capabilities: resolveCaps({ model: 'A2', firmware: '2030010101' })
  })
  t.ok(/could not be asked/.test(
    unasked.details.find((d) => d.code === 'warn.firmware_unverified').detail),
  'without discovery it says so plainly')

  // A firmware the table does know about says nothing at all.
  const known = evaluate({
    stats: parseStats(buildStats(createState({ firmware: '2026060101', includeChips: false }))),
    capabilities: resolveCaps({ model: 'A2', firmware: '2026060101' })
  })
  t.absent(codes(known).includes('warn.firmware_unverified'))
})
