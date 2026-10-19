'use strict'

const test = require('brittle')
const contract = require('../../mdk-contract.json')
const p = require('../../lib/provisional')

const param = (command, name) =>
  contract.capabilities.commands
    .find((c) => c.name === command)
    .params.find((x) => x.name === name)

test('every number parameter declares both bounds', (t) => {
  // MDK's build guide requires the handler to reject out-of-range values, and
  // a declared bound is also the only validation Kernel performs pre-dispatch.
  // Nothing below this layer checks: the firmware answers 'ASC 0 set OK' to
  // settings it silently ignores, so an undeclared bound leaves a physical
  // setpoint with no guard anywhere.
  let seen = 0
  for (const command of contract.capabilities.commands) {
    for (const prm of command.params || []) {
      if (prm.type !== 'number') continue
      seen++
      t.ok(prm.min !== undefined, `${command.name}.${prm.name} declares min`)
      t.ok(prm.max !== undefined, `${command.name}.${prm.name} declares max`)
      t.ok(prm.min <= prm.max, `${command.name}.${prm.name} has a sane range`)
    }
  }
  t.ok(seen >= 7, 'and the check is not vacuous')
})

test('the declared power-limit envelope contains what real hardware is set to', (t) => {
  // The regression that matters, because it has happened twice. The first
  // declared range was [1500, 4200] while a shipped A2 sat at 4300 W, so
  // reading power_limit and writing the same value back was refused with
  // ERR_PARAM_RANGE. Widening to 4600 then excluded an A4 Ultra Hydro at
  // 10800 W. Every observed product is checked, not just the highest, so
  // adding a model without widening the envelope fails here and not in the
  // field.
  for (const [model, watts] of Object.entries(p.OBSERVED_POWER_LIMITS_W)) {
    t.ok(watts >= p.POWER_LIMIT_W.min, `${model} at ${watts}W is not below the declared minimum`)
    t.ok(watts <= p.POWER_LIMIT_W.max, `${model} at ${watts}W is not above the declared maximum`)
  }
  t.is(p.OBSERVED_POWER_LIMIT_W, Math.max(...Object.values(p.OBSERVED_POWER_LIMITS_W)),
    'the headline observation is the highest one')
  t.ok(Object.keys(p.OBSERVED_POWER_LIMITS_W).length >= 6, 'one entry per measured product')

  const declared = param('setPowerLimit', 'watts')
  t.is(declared.min, p.POWER_LIMIT_W.min, 'contract and lib/provisional.js agree on the minimum')
  t.is(declared.max, p.POWER_LIMIT_W.max, 'contract and lib/provisional.js agree on the maximum')

  // Headroom above the highest real setting. Thin margin is how the previous
  // two failures happened, and one A2 Pro Hydro already moved 7800 -> 9500 W
  // across a firmware upgrade.
  t.ok(p.POWER_LIMIT_W.max > p.OBSERVED_POWER_LIMIT_W,
    'the envelope leaves room above the highest setting measured')
})

test('a bound the vendor document states is not carried as a guess', (t) => {
  // SealMinerAPI_V0.5 section 4.1.6 gives preheat's temperature and timeout,
  // and 4.1.12 gives the fan speed percentage. Those belong in the contract
  // with the document's own numbers; only the values nobody has confirmed are
  // listed by unconfirmed().
  t.is(param('setPreheat', 'bootPreheatTemp').max, 35, "the document's boot target")
  t.is(param('setPreheat', 'bootPreheatTimeout').max, 600, "the firmware's own ceiling")
  t.is(param('setIdleFanTimer', 'speed').max, 100, 'a percentage of maximum RPM')

  const pending = p.unconfirmed()
  for (const name of ['POWER_LIMIT_W', 'STRATUM_DISCONNECT_TIMEOUT_S']) {
    t.ok(pending.includes(name), `${name} is a guess and says so`)
  }
  for (const name of ['IDLE_FAN_TIMER_INTERVAL_S', 'IDLE_FAN_TIMER_ON_DURATION_S']) {
    // Previously an oversight: the contract carried these bounds while nothing
    // declared them, so unconfirmed() never listed them.
    t.ok(pending.includes(name), `${name} is registered as a guess`)
  }
})

test('unconfirmed constants are still flagged as unconfirmed', (t) => {
  // Confirming a value is a deliberate edit, not a side effect. This keeps
  // npm run validate:contract loudly listing what is still a placeholder.
  const pending = p.unconfirmed()
  t.ok(pending.length > 0, 'placeholders remain and are reported')
  for (const name of pending) {
    t.is(p.ALL[name].confirmed, false, `${name} is marked unconfirmed`)
  }
  t.absent(pending.includes('MAX_POOLS'), 'MAX_POOLS is confirmed at three')
})
