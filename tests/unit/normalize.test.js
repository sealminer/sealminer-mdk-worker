'use strict'

const test = require('brittle')
const n = require('../../lib/parser/normalize')

test('toBoolean accepts both firmware shapes', (t) => {
  // The document lists Debug, Stratum Disconnect, Raise Freq Done, Liquid
  // Cooling, X Online and X Low Hash as having changed from Int to Boolean.
  t.is(n.toBoolean(true), true)
  t.is(n.toBoolean(false), false)
  t.is(n.toBoolean(1), true)
  t.is(n.toBoolean(0), false)
  t.is(n.toBoolean('true'), true)
  t.is(n.toBoolean('false'), false)
  t.is(n.toBoolean('1'), true)
  t.is(n.toBoolean(null), null)
  t.is(n.toBoolean(undefined), null)
  t.is(n.toBoolean(''), null)
  t.is(n.toBoolean('garbage'), null)
})

test('toNumber never coerces missing data to zero', (t) => {
  t.is(n.toNumber(3400), 3400)
  t.is(n.toNumber('3400'), 3400)
  t.is(n.toNumber(0), 0, 'a real zero survives')
  t.is(n.toNumber(undefined), null)
  t.is(n.toNumber(null), null)
  t.is(n.toNumber(''), null)
  t.is(n.toNumber('n/a'), null)
  t.is(n.toNumber(Infinity), null)
})

test('toString trims and nulls empties', (t) => {
  t.is(n.toString('  K10Pro '), 'K10Pro')
  t.is(n.toString(''), null)
  t.is(n.toString('   '), null)
  t.is(n.toString(null), null)
})

test('mhsToThs converts the API unit to the contract unit', (t) => {
  t.is(n.mhsToThs(167000000), 167)
  t.is(n.mhsToThs(55750854.783592), 55.75)
  t.is(n.mhsToThs(0), 0)
  t.is(n.mhsToThs(undefined), null)
})

test('enum fields normalize display strings to canonical tokens', (t) => {
  t.is(n.miningMode('Low Power'), 'low_power')
  t.is(n.miningMode('High Performance'), 'high_performance')
  t.is(n.miningMode('Ultra Low Power'), 'ultra_low_power')
  t.is(n.miningMode('Smartboost'), 'smartboost')
  t.is(n.pmState('Resume Failed'), 'resume_failed')
  t.is(n.tuneStatus('Coarse Tuning Done'), 'coarse_tuning_done')
})

test('unknown enum strings normalize to null, not to a guess', (t) => {
  t.is(n.miningMode('Hyper Turbo'), null)
  t.is(n.pmState('Exploding'), null)
  t.is(n.miningMode(''), null)
  t.is(n.miningMode(null), null)
})

test('legacy integer enums normalize to null until the encoding is confirmed', (t) => {
  // Old firmware sent integers for these fields and the API document does not
  // specify the encoding. Reporting null is correct; guessing would silently
  // mislabel a miner's power mode. See lib/parser/legacy-enums.js.
  t.is(n.miningMode(0), null)
  t.is(n.miningMode(2), null)
  t.is(n.pmState(3), null)
  t.is(n.tuneStatus('4'), null)
})

test('toEnum uses a legacy map when one is supplied', (t) => {
  // Proves the wiring works, so filling legacy-enums.js is the only step left.
  t.is(n.toEnum(2, ['a', 'b', 'c'], { 2: 'c' }, 'Test'), 'c')
  t.is(n.toEnum(9, ['a', 'b', 'c'], { 2: 'c' }, 'Test'), null)
})

test('tokenize handles spaces and dashes', (t) => {
  t.is(n.tokenize('Fine Tuning Done'), 'fine_tuning_done')
  t.is(n.tokenize('fast-raise-freq'), 'fast_raise_freq')
  t.is(n.tokenize('  Normal  '), 'normal')
})
