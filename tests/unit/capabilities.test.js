'use strict'

const test = require('brittle')
const caps = require('../../lib/capabilities')

const FW_NEW = '2026060901'
const FW_OLD = '20250620'

test('normalizeFirmware pads 8-digit dates so comparisons stay sound', (t) => {
  t.is(caps.normalizeFirmware('2026060101').value, 2026060101)
  t.is(caps.normalizeFirmware('20260531').value, 2026053100, '8-digit date padded to 10')
  t.is(caps.normalizeFirmware('20230805FF').value, 2023080500, 'trailing letters ignored')
  t.is(caps.normalizeFirmware('').resolved, false)
  t.is(caps.normalizeFirmware(null).resolved, false)
  t.is(caps.normalizeFirmware('unknown').resolved, false)
})

test('configured series wins over the model table', (t) => {
  const c = caps.resolve({ series: 'A3', model: 'K10Pro', firmware: FW_NEW })
  t.is(c.series, 'A3')
  t.is(c.seriesSource, 'config')
  t.is(c.seriesResolved, true)
})

test('model string resolves the series when no config is given', (t) => {
  const c = caps.resolve({ model: 'K10Pro', firmware: FW_NEW })
  t.is(c.series, 'A2')
  t.is(c.seriesSource, 'model')
})

test('A2 offers low_power, A3 and A4 do not', (t) => {
  t.ok(caps.resolve({ series: 'A2', firmware: FW_NEW }).powerModes.includes('low_power'))
  t.absent(caps.resolve({ series: 'A3', firmware: FW_NEW }).powerModes.includes('low_power'))
  t.absent(caps.resolve({ series: 'A4', firmware: FW_NEW }).powerModes.includes('low_power'))
})

test('an unresolved series falls back to the A2/A3/A4 intersection', (t) => {
  const c = caps.resolve({ model: 'SOMETHING-NEW', firmware: FW_NEW })
  t.is(c.seriesResolved, false)
  t.alike(c.powerModes, ['normal', 'high_performance', 'sleep'])
  t.absent(c.powerModes.includes('low_power'), 'never offer a mode the miner may reject')
  t.ok(c.commands.setPowerMode.note, 'the narrowing is explained, not silent')
})

test('sleep mode is firmware gated', (t) => {
  t.ok(caps.resolve({ series: 'A2', firmware: '2025101601' }).powerModes.includes('sleep'))
  t.absent(caps.resolve({ series: 'A2', firmware: '2025101501' }).powerModes.includes('sleep'))
})

test('hostname, network and idle-fan-timer are firmware gated', (t) => {
  const old = caps.resolve({ series: 'A2', firmware: FW_OLD })
  t.is(old.commands.setHostname.supported, false)
  t.is(old.commands.setNetwork.supported, false)
  t.is(old.commands.setIdleFanTimer.supported, false)
  t.ok(/2025062602/.test(old.commands.setHostname.reason))

  const current = caps.resolve({ series: 'A2', firmware: FW_NEW })
  t.is(current.commands.setHostname.supported, true)
  t.is(current.commands.setNetwork.supported, true)
  t.is(current.commands.setIdleFanTimer.supported, true)
})

test('resume tracks its removal window and names its fallback', (t) => {
  // Restored in 2026060101 and later.
  t.is(caps.resolve({ firmware: '2026060101' }).commands.resume.supported, true)
  // Removed from 2025080401 through 20260531.
  const removed = caps.resolve({ firmware: '2025080401' }).commands.resume
  t.is(removed.supported, false)
  t.is(removed.fallback, 'restartMiner', 'the caller is told what to use instead')
  t.is(caps.resolve({ firmware: '20260531' }).commands.resume.supported, false)
  // Below the removal window it still existed.
  t.is(caps.resolve({ firmware: '2025080301' }).commands.resume.supported, true)
})

test('the measured A4 Pro Air build resolves end to end', (t) => {
  // normalizeFirmware's padding is covered above; this pins the actual
  // string a real A4 Pro Air reported — '20260915FF' — through resolve(),
  // because a shape that only the unit test knows about is a shape the
  // capability path can still drop.
  const c = caps.resolve({ series: 'A4', firmware: '20260915FF' })
  t.is(c.firmwareResolved, true)
  t.is(c.firmwareValue, 2026091500)
  t.is(c.firmware, '20260915FF', 'the raw string is reported as the device sent it, not the padded one')
  t.is(c.firmwareNewerThanKnown, true, 'and it is newer than the table, so the warning fires')
})

test('an unreadable firmware version disables gated commands and says why', (t) => {
  const c = caps.resolve({ series: 'A2', firmware: 'garbage' })
  t.is(c.firmwareResolved, false)
  t.is(c.commands.setHostname.supported, false)
  t.ok(/could not be determined/.test(c.commands.setHostname.reason))
  t.is(c.commands.reboot.supported, true, 'ungated commands stay available')
  t.absent(c.powerModes.includes('sleep'), 'gated modes are withheld')
})

test('ungated commands are always supported', (t) => {
  const c = caps.resolve({ series: 'A2', firmware: FW_OLD })
  for (const name of ['reboot', 'restartMiner', 'suspend', 'setPowerMode', 'setPowerLimit',
    'setupPools', 'setTimezone', 'setPreheat', 'setFastRaiseFreq']) {
    t.is(c.commands[name].supported, true, name)
  }
})

test('the unconfirmed firmware bound is carried as a note, not a guess', (t) => {
  const c = caps.resolve({ series: 'A2', firmware: FW_NEW })
  t.is(c.commands.setStratumDisconnectTimeout.supported, true)
  t.ok(/unconfirmed/.test(c.commands.setStratumDisconnectTimeout.note))
})

test('helpers answer the guard’s questions', (t) => {
  const c = caps.resolve({ series: 'A3', firmware: FW_NEW })
  t.is(caps.supportsCommand(c, 'setNetwork'), true)
  t.is(caps.supportsCommand(c, 'nonexistent'), false)
  t.is(caps.supportsCommand(null, 'reboot'), false)
  t.is(caps.supportsPowerMode(c, 'high_performance'), true)
  t.is(caps.supportsPowerMode(c, 'low_power'), false, 'A3 has no low_power')
})

test('every contract command appears in the descriptor', (t) => {
  const c = caps.resolve({ series: 'A2', firmware: FW_NEW })
  t.is(Object.keys(c.commands).length, 14, 'all 14 declared commands are described')
})

test('the series comes from a product name, not just a bare series string', (t) => {
  // Model is a PRODUCT name. Measured on three real miners: "A2",
  // "A3 Air" and "A4 Ultra Hydro". Only the A2 reported a bare series, which
  // is what made an exact-match table look sufficient — it left every real
  // A3 and A4 with series: null.
  for (const [model, series] of [
    ['A2', 'A2'],
    ['A3 Air', 'A3'],
    ['A4 Ultra Hydro', 'A4'],
    ['a3 air', 'A3'],
    ['K10Pro', 'A2']
  ]) {
    const c = caps.resolve({ model, firmware: '2026083100' })
    t.is(c.series, series, `${model} -> ${series}`)
    t.ok(c.seriesResolved, `${model} resolves`)
  }

  // A3/A4 keep their own mode set rather than the conservative intersection.
  t.alike(caps.resolve({ model: 'A3 Air', firmware: '2025101601' }).powerModes,
    ['normal', 'high_performance', 'sleep'])
  t.alike(caps.resolve({ model: 'A2', firmware: '2025101601' }).powerModes,
    ['low_power', 'normal', 'high_performance', 'sleep'])
})

test('an unrecognised model is left unresolved rather than guessed', (t) => {
  // Deliberately brand-neutral: what the test needs is a string the table
  // cannot resolve, not a named competitor. 'A5 Future' is a plausible future
  // series that is not in the table yet, and 'A2X' is the dangerous case — it
  // looks like an A2 and must NOT be matched by the prefix rule.
  for (const model of ['Other Miner X1', 'A5 Future', 'A2X', '', null]) {
    const c = caps.resolve({ model, firmware: '2026083100' })
    t.absent(c.seriesResolved, `${JSON.stringify(model)} is not guessed`)
    t.is(c.series, null)
    t.alike(c.powerModes, ['normal', 'high_performance', 'sleep'],
      'and falls back to the modes common to every series')
  }
})
