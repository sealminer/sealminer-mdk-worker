'use strict'

const test = require('brittle')
const v = require('../../lib/validate')

test('string: required, type, emptiness, length', (t) => {
  t.is(v.string({ tz: '  UTC ' }, 'tz'), 'UTC', 'trimmed')
  t.exception(() => v.string({}, 'tz'), /ERR_PARAM_REQUIRED/)
  t.exception(() => v.string({ tz: '   ' }, 'tz'), /ERR_PARAM_REQUIRED/)
  t.exception(() => v.string({ tz: 42 }, 'tz'), /ERR_PARAM_TYPE/)
  t.exception(() => v.string({ tz: 'x'.repeat(65) }, 'tz', { maxLength: 64 }), /ERR_PARAM_RANGE/)
  t.is(v.string({}, 'tz', { required: false }), undefined)
})

test('string: enum is enforced here because Kernel ignores it', (t) => {
  const spec = { enum: ['low_power', 'normal'] }
  t.is(v.string({ mode: 'normal' }, 'mode', spec), 'normal')
  t.exception(() => v.string({ mode: 'turbo' }, 'mode', spec), /ERR_PARAM_ENUM/)
})

test('number: type, range, integer', (t) => {
  const spec = { min: 1500, max: 4200 }
  t.is(v.number({ watts: 3000 }, 'watts', spec), 3000)
  t.exception(() => v.number({}, 'watts', spec), /ERR_PARAM_REQUIRED/)
  t.exception(() => v.number({ watts: '3000' }, 'watts', spec), /ERR_PARAM_TYPE/)
  t.exception(() => v.number({ watts: NaN }, 'watts', spec), /ERR_PARAM_TYPE/)
  t.exception(() => v.number({ watts: 1499 }, 'watts', spec), /ERR_PARAM_RANGE/)
  t.exception(() => v.number({ watts: 4201 }, 'watts', spec), /ERR_PARAM_RANGE/)
  t.exception(() => v.number({ n: 1.5 }, 'n', { min: 0, max: 10, integer: true }), /ERR_PARAM_TYPE/)
})

test('number: allow lets a sentinel through the range check', (t) => {
  // preheat's bootPreheatTimeout is -1 ("wait for temperature") or >= 300.
  const spec = { min: 300, max: 600, allow: [-1] }
  t.is(v.number({ t: -1 }, 't', spec), -1)
  t.is(v.number({ t: 300 }, 't', spec), 300)
  t.exception(() => v.number({ t: 0 }, 't', spec), /ERR_PARAM_RANGE/)
  t.exception(() => v.number({ t: 299 }, 't', spec), /ERR_PARAM_RANGE/, 'the firmware would silently raise this to 300')
})

test('boolean is strict on purpose', (t) => {
  t.is(v.boolean({ enabled: false }, 'enabled'), false)
  // Accepting "false" or 0 would let a typo switch a physical setting on.
  t.exception(() => v.boolean({ enabled: 'false' }, 'enabled'), /ERR_PARAM_TYPE/)
  t.exception(() => v.boolean({ enabled: 0 }, 'enabled'), /ERR_PARAM_TYPE/)
  t.exception(() => v.boolean({}, 'enabled'), /ERR_PARAM_REQUIRED/)
  t.is(v.boolean({}, 'enabled', { required: false }), undefined)
})

test('object distinguishes arrays from plain objects', (t) => {
  t.alike(v.object({ o: { a: 1 } }, 'o'), { a: 1 })
  t.exception(() => v.object({ o: [1] }, 'o'), /ERR_PARAM_TYPE/)
  t.alike(v.object({ o: [1] }, 'o', { array: true }), [1])
  t.exception(() => v.object({ o: { a: 1 } }, 'o', { array: true }), /ERR_PARAM_TYPE/)
  t.exception(() => v.object({ o: null }, 'o'), /ERR_PARAM_TYPE/)
})

test('poolList requires a usable pool and caps the list', (t) => {
  const ok = v.poolList([{ url: 'stratum+tcp://pool.example:3333', user: 'w1', pass: 'x' }], 3)
  t.is(ok.length, 1)
  t.is(ok[0].url, 'stratum+tcp://pool.example:3333')

  t.is(v.poolList([{ url: 'stratum+tcp://p:3333', user: 'w' }], 3)[0].pass, 'x', 'pass defaults')

  t.exception(() => v.poolList([], 3), /ERR_PARAM_SHAPE/)
  t.exception(() => v.poolList('nope', 3), /ERR_PARAM_TYPE/)
  t.exception(() => v.poolList([{ user: 'w' }], 3), /ERR_PARAM_SHAPE/, 'url required')
  t.exception(() => v.poolList([{ url: 'http://pool:3333', user: 'w' }], 3), /ERR_PARAM_SHAPE/, 'must be stratum+tcp')
  t.exception(() => v.poolList([{ url: 'stratum+tcp://pool.example', user: 'w' }], 3), /ERR_PARAM_SHAPE/, 'port required')
  t.exception(() => v.poolList([{ url: 'stratum+tcp://p:3333' }], 3), /ERR_PARAM_SHAPE/, 'user required')
  t.exception(() => v.poolList([null], 3), /ERR_PARAM_SHAPE/)
  t.exception(
    () => v.poolList(Array.from({ length: 4 }, () => ({ url: 'stratum+tcp://p:3333', user: 'w' })), 3),
    /ERR_PARAM_RANGE/
  )
})

test('networkConfig: DHCP mode ignores the rest', (t) => {
  t.alike(v.networkConfig({ dhcp: '1', ip: 'garbage' }), { dhcp: '1' })
})

test('networkConfig: static mode demands a complete, well-formed set', (t) => {
  const valid = {
    dhcp: '0',
    ip: '10.0.0.50',
    netmask: '255.255.255.0',
    gateway: '10.0.0.1',
    dns1: '114.114.114.114'
  }
  t.alike(v.networkConfig(valid), valid)

  t.exception(() => v.networkConfig({ dhcp: '0', ip: '10.0.0.50' }), /ERR_PARAM_SHAPE/, 'netmask and gateway required')
  t.exception(() => v.networkConfig({ ...valid, ip: '10.0.0.999' }), /ERR_PARAM_SHAPE/)
  t.exception(() => v.networkConfig({ ...valid, gateway: 'gateway' }), /ERR_PARAM_SHAPE/)
  t.exception(() => v.networkConfig({ ...valid, dns2: '1.2.3' }), /ERR_PARAM_SHAPE/)
  t.exception(() => v.networkConfig({ dhcp: 'yes' }), /ERR_PARAM_SHAPE/)
  t.exception(() => v.networkConfig({}), /ERR_PARAM_SHAPE/)
  t.exception(() => v.networkConfig(null), /ERR_PARAM_TYPE/)

  const noDns = v.networkConfig({ dhcp: '0', ip: '10.0.0.2', netmask: '255.255.255.0', gateway: '10.0.0.1', dns2: '' })
  t.absent('dns2' in noDns, 'blank optional fields are dropped')
})

test('hostname pattern follows RFC 1123 labels', (t) => {
  t.ok(v.HOSTNAME.test('sealminer-a2-001'))
  t.ok(v.HOSTNAME.test('SM1'))
  t.absent(v.HOSTNAME.test('-leading'))
  t.absent(v.HOSTNAME.test('trailing-'))
  t.absent(v.HOSTNAME.test('has space'))
  t.absent(v.HOSTNAME.test('under_score'))
})
