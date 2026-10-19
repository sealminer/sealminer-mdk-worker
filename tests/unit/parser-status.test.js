'use strict'

const test = require('brittle')
const { readStatus, assertOk, isAcknowledged, section } = require('../../lib/parser/status')

const envelope = (status, extra = {}) => ({
  STATUS: [{ STATUS: status.letter, When: 1693205317, Code: status.code, Msg: status.msg, Description: 'bdminer 4.11.1' }],
  ...extra,
  id: 1
})

test('readStatus reads the array form', (t) => {
  const s = readStatus(envelope({ letter: 'S', code: 70, msg: 'Bdminer stats' }))
  t.is(s.ok, true)
  t.is(s.letter, 'S')
  t.is(s.code, 70)
  t.is(s.msg, 'Bdminer stats')
})

test('readStatus reads the bare string form used by restart/reboot', (t) => {
  t.is(readStatus({ STATUS: 'RESTART', id: 1 }).ok, true)
  t.is(readStatus({ STATUS: 'REBOOT', id: 1 }).ok, true)
  t.is(readStatus({ STATUS: 'SOMETHING-ELSE', id: 1 }).ok, false)
})

test('assertOk passes success and info replies through', (t) => {
  t.execution(() => assertOk(envelope({ letter: 'S', code: 119, msg: 'ASC 0 set OK' }), 'ascset'))
  // Code 49 ("already enabled") is an info reply, not a failure.
  t.execution(() => assertOk(envelope({ letter: 'I', code: 49, msg: 'Pool 2 already enabled' }), 'enablepool'))
  t.execution(() => assertOk({ STATUS: 'REBOOT', id: 1 }, 'reboot'))
})

test('assertOk maps every documented reply code to a stable error', (t) => {
  const cases = [
    [14, 'ERR_INVALID_CMD'],
    [23, 'ERR_JSON_CMD'],
    [45, 'ERR_ACCESS_DENIED'],
    [120, 'ERR_ASCSET_FAILED'],
    [201, 'ERR_UPDATE_POOLS_FAILED'],
    [8, 'ERR_NO_AVAILABLE_POOL']
  ]
  for (const [code, expected] of cases) {
    t.exception(
      () => assertOk(envelope({ letter: 'E', code, msg: 'nope' }), 'stats'),
      new RegExp(expected),
      `code ${code} -> ${expected}`
    )
  }
})

test('assertOk rejects a malformed envelope', (t) => {
  t.exception(() => assertOk(null, 'stats'), /ERR_API_RESPONSE_INVALID/)
  t.exception(() => assertOk({ id: 1 }, 'stats'), /ERR_API_RESPONSE_INVALID/)
})

test('isAcknowledged only trusts the documented success codes', (t) => {
  t.is(isAcknowledged(envelope({ letter: 'S', code: 119, msg: 'ASC 0 set OK' })), true)
  t.is(isAcknowledged(envelope({ letter: 'S', code: 200, msg: 'Update pools success' })), true)
  t.is(isAcknowledged(envelope({ letter: 'S', code: 70, msg: 'Bdminer stats' })), false)
})

test('section extracts payloads and reports absence', (t) => {
  const body = envelope({ letter: 'S', code: 70, msg: 'ok' }, { STATS: [{ Model: 'K10Pro' }] })
  t.is(section(body, 'STATS').Model, 'K10Pro')
  t.is(section(body, 'STATS', { list: true }).length, 1)
  t.exception(() => section(body, 'POOLS'), /ERR_SECTION_MISSING/)
  t.is(section(body, 'POOLS', { optional: true }), null)
  t.alike(section(body, 'POOLS', { optional: true, list: true }), [])
})
