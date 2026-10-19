'use strict'

const test = require('brittle')
const { group } = require('../../lib/parser/flat-keys')

test('splits device, board, fan and chip levels', (t) => {
  const raw = {
    Temp: 67,
    'Board Count': 2,
    'Fan Count': 2,
    '0 SN': 'BOARD-0',
    '0 Temp': 62,
    '1 SN': 'BOARD-1',
    '1 Temp': 63,
    '0 PWM': 207,
    '0 Speed': 6210,
    '1 PWM': 245,
    '1 Speed': 7170,
    '0.107 Freq': 194,
    '0.107 Bad': 0
  }
  const g = group(raw, { parseChips: true })

  t.is(g.device.Temp, 67)
  t.is(g.device['0 SN'], undefined, 'indexed keys do not leak into device level')

  t.is(g.boards.length, 2)
  t.is(g.boards[0].SN, 'BOARD-0')
  t.is(g.boards[0].Temp, 62)
  t.is(g.boards[0].PWM, undefined, 'fan fields do not land on boards')

  t.is(g.fans.length, 2)
  t.is(g.fans[0].pwm, undefined, 'raw fan keys keep their firmware names')
  t.is(g.fans[0].PWM, 207)
  t.is(g.fans[1].Speed, 7170)

  t.is(g.chips.length, 1)
  t.is(g.chips[0].board, 0)
  t.is(g.chips[0].index, 107)
  t.is(g.chips[0].Freq, 194)
})

test('board and fan index 0 do not collide', (t) => {
  // Both levels use the "<n> " prefix; only the field name separates them.
  const g = group({ 'Board Count': 1, 'Fan Count': 1, '0 Temp': 62, '0 Speed': 6000, '0 PWM': 200 })
  t.is(g.boards.length, 1)
  t.is(g.fans.length, 1)
  t.is(g.boards[0].Temp, 62)
  t.is(g.fans[0].Speed, 6000)
})

test('chips are skipped unless asked for', (t) => {
  const raw = { 'Board Count': 1, '0 Temp': 60 }
  for (let c = 0; c < 500; c++) raw[`0.${c} Freq`] = 194
  t.is(group(raw).chips.length, 0, 'default drops ~6500 chip keys on real hardware')
  t.is(group(raw, { parseChips: true }).chips.length, 500)
})

test('counts come from the declared fields, not from which keys arrived', (t) => {
  // A truncated reply loses trailing keys. Inferring the count from the keys
  // present would under-report the miner's real board count.
  const g = group({ 'Board Count': 3, 'Fan Count': 4, '0 SN': 'a', '1 SN': 'b', '0 Speed': 1 })
  t.is(g.declaredBoardCount, 3)
  t.is(g.declaredFanCount, 4)
  t.is(g.boards.length, 2)
  t.is(g.complete, false, 'missing boards and fans mark the group incomplete')
})

test('complete is true when every declared board and fan arrived', (t) => {
  const g = group({
    'Board Count': 2,
    'Fan Count': 1,
    '0 SN': 'a',
    '1 SN': 'b',
    '0 Speed': 6000
  })
  t.is(g.complete, true)
})

test('undeclared counts do not make a group incomplete', (t) => {
  const g = group({ Temp: 60 })
  t.is(g.declaredBoardCount, null)
  t.is(g.declaredFanCount, null)
  t.is(g.complete, true)
})

test('tolerates empty and malformed input', (t) => {
  for (const input of [undefined, null, {}]) {
    const g = group(input)
    t.alike(g.boards, [])
    t.alike(g.fans, [])
    t.alike(g.chips, [])
  }
})
