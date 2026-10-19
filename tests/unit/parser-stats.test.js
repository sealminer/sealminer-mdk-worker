'use strict'

const test = require('brittle')
const { parseStats } = require('../../lib/parser/stats')
const { createState, buildStats } = require('../../mock/state')

const statsFor = (opts) => buildStats(createState({ includeChips: false, ...opts }))

test('parses a healthy A2 snapshot', (t) => {
  const s = parseStats(statsFor({ series: 'a2' }))

  t.is(s.truncated, false)
  t.is(s.boardsComplete, true)
  t.is(s.identity.model, 'A2', 'a real A2 reports the series as its model')
  t.is(s.identity.asic, 'Seal02-V1')
  t.is(s.state.pmState, 'running')
  t.is(s.state.miningMode, 'normal')
  t.is(s.state.tuneStatus, 'fine_tuning_done')
  t.is(s.state.stratumDisconnect, false)
  t.is(s.thermal.temp, 70, 'the temperature a real A2 reports, against a target of 70')
  t.is(s.thermal.targetCtrlTemp, 70)
  t.is(s.hashrate.rated, 230.57, 'MHS(Rated) converted to TH/s')
  t.is(s.hashrate.avg, 230.57)
  t.is(s.psu.inputPower, 4300)
  t.is(s.psu.errorWord, '0x00000000')
  t.is(s.settings.powerLimit, 4300, 'the firmware reports the limit it enforces')
  t.is(s.settings.fastRaiseFreq, false)
  t.is(s.boards.length, 3)
  t.is(s.fans.length, 4)
  t.ok(s.wattsPerTh.avg > 18 && s.wattsPerTh.avg < 19, 'W/T is already W/TH')
})

test('board and fan levels land in the right arrays', (t) => {
  const s = parseStats(statsFor({}))

  t.is(s.boards[0].index, 0)
  t.is(s.boards[0].online, true)
  // A real A2 reports four sensors per board; the hottest is published.
  t.is(s.boards[0].temp, 57)
  t.is(s.boards[0].temps.length, 4)
  t.is(Math.min(...s.boards[0].temps), 48)
  t.is(s.boards[1].temp, 58)
  t.is(s.boards[0].badChipRatio, 0)
  t.ok(s.boards[0].hashrate.avg > 0)
  t.ok(s.boards[0].voltage.ulvtPmos > 0)

  t.is(s.fans[0].pwm, 148)
  t.is(s.fans[0].speed, 4500)
  t.is(s.fans[3].speed, 4590)
})

test('suspended miner reports zeros for hashrate, power and fans', (t) => {
  const state = createState({ includeChips: false })
  state.pmState = 'suspended'
  const s = parseStats(buildStats(state))

  t.is(s.state.pmState, 'suspended')
  t.is(s.hashrate.avg, 0)
  t.is(s.psu.inputPower, 0)
  t.is(s.fans[0].speed, 0)
  t.is(s.hashrate.rated, 230.57, 'the rating is a nameplate value and stays')
})

test('sleep mode zeroes hashrate but keeps the mode visible', (t) => {
  const state = createState({ includeChips: false })
  state.miningMode = 'sleep'
  const s = parseStats(buildStats(state))
  t.is(s.hashrate.avg, 0)
  // 'sleep' is a workmode the firmware accepts but not a Mining Mode string
  // it reports back, so the enum normalizes to null rather than a guess.
  t.is(s.state.miningMode, null)
})

test('faults surface on the fields health checks read', (t) => {
  const s = parseStats(statsFor({
    faults: ['fan_stopped', 'psu_error', 'board_offline', 'overheat', 'device_error', 'stratum_disconnect']
  }))

  t.is(s.fans[0].speed, 0)
  t.is(s.psu.errorWord, '0x00000080')
  t.is(s.boards[0].online, false)
  t.is(s.boards[0].lowHash, true)
  t.is(s.thermal.temp, 80)
  t.is(s.state.errorCode, '0x00000101')
  t.is(s.state.stratumDisconnect, true)
})

test('a truncated reply is reported, never silently patched', (t) => {
  const raw = statsFor({})
  // Simulate the firmware dropping trailing keys when it sets id: 0.
  for (const key of Object.keys(raw)) {
    if (key.startsWith('2 ')) delete raw[key]
  }
  const s = parseStats(raw, { truncated: true })

  t.is(s.truncated, true)
  t.is(s.declaredBoardCount, 3, 'the miner still says it has 3 boards')
  t.is(s.boards.length, 2, 'only 2 arrived')
  t.is(s.boardsComplete, false, 'the mismatch is explicit')
  t.is(s.thermal.temp, 70, 'device-level fields are still usable')
})

test('legacy integer enums parse as unknown instead of wrong', (t) => {
  const s = parseStats(statsFor({ legacyTypes: true }))

  t.is(s.state.miningMode, null)
  t.is(s.state.pmState, null)
  t.is(s.state.tuneStatus, null)
  // Int-to-Boolean fields are recoverable, so these must still be right.
  t.is(s.state.stratumDisconnect, false)
  t.is(s.firmware.liquidCooling, false)
  t.is(s.boards[0].online, true)
  t.is(s.boards[0].lowHash, false)
  t.is(s.thermal.temp, 70, 'numbers are unaffected')
})

test('missing sections become null rather than zero', (t) => {
  const s = parseStats({ 'Board Count': 0, 'Fan Count': 0 })

  t.is(s.thermal.temp, null)
  t.is(s.psu.inputPower, null)
  t.is(s.hashrate.avg, null)
  t.is(s.identity.model, null)
  t.is(s.state.miningMode, null)
  t.alike(s.boards, [])
  t.alike(s.fans, [])
})

test('handles a 1092-chip miner without parsing chips', (t) => {
  const raw = buildStats(createState({ chipCount: 1092, includeChips: true }))
  t.ok(Object.keys(raw).length > 6000, 'the real key count is in the thousands')

  const s = parseStats(raw)
  t.alike(s.chips, [], 'chip keys are dropped by default')
  t.is(s.chip.count, 1092)
  t.is(s.boards.length, 3)

  const withChips = parseStats(raw, { parseChips: true })
  t.is(withChips.chips.length, 1092)
})

test('the parser is series-agnostic, but the series really do differ', (t) => {
  // This used to assert that A3 and A4 parsed to the SAME numbers as an A2,
  // which only held because the mock reported one generic machine for every
  // series. Real hardware differs — an A4 Ultra Hydro is water-cooled, has
  // two boards and draws 2.5x the power — so pinning the values tested the
  // mock's sameness rather than the parser.
  //
  // What matters is that no field is parsed differently per series: the same
  // keys resolve, with the same types, and nothing silently becomes null.
  for (const series of ['a2', 'a3', 'a4']) {
    const s = parseStats(statsFor({ series }))
    t.is(s.state.pmState, 'running', `${series} state`)
    t.is(typeof s.hashrate.rated, 'number', `${series} rating is a number`)
    t.ok(s.hashrate.rated > 0, `${series} rating is positive`)
    t.ok(s.boards.length >= 2, `${series} boards parsed`)
    t.is(s.boards.length, s.declaredBoardCount, `${series} board count agrees`)
    t.is(typeof s.identity.model, 'string', `${series} model`)
    t.is(typeof s.thermal.temp, 'number', `${series} temp`)
  }

  // And the differences the mock now carries are the measured ones, so a
  // regression that flattens the fleet back to one machine fails here.
  const a2 = parseStats(statsFor({ series: 'a2' }))
  const a4 = parseStats(statsFor({ series: 'a4' }))
  t.is(a2.identity.model, 'A2')
  t.is(a4.identity.model, 'A4 Ultra Hydro')
  t.is(a2.thermal.liquidCooling, false, 'the A2 is air-cooled')
  t.is(a4.thermal.liquidCooling, true, 'the A4 Ultra Hydro is not')
  t.ok(a4.settings.powerLimit > a2.settings.powerLimit * 2, 'and draws far more power')
})
