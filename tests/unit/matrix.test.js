'use strict'

// Series × firmware matrix.
//
// The A2/A3/A4 API is identical except for the `workmode` value set, and five
// write operations are gated on firmware version. Those are the only two axes
// that change behaviour, so the core assertions run across every combination
// rather than against one representative device.
//
// Firmware builds under test:
//   20250620    predates the hostname/network gate (2025062602) and the
//               idle-fan-timer gate (2025081801); below the resume removal
//               window, so resume still exists
//   2025090101  inside the resume removal window (2025080401..2026053100);
//               has hostname/network and idle-fan-timer, but not sleep
//   2026060901  current: everything available

const test = require('brittle')
const { createClient } = require('../../lib/api-client')
const { createServer } = require('../../mock/server')
const caps = require('../../lib/capabilities')

const SERIES = ['a2', 'a3', 'a4']
const FIRMWARES = ['20250620', '2025090101', '2026060901']

// Expected capability, derived from the API document rather than from the
// implementation, so a change in lib/capabilities.js cannot silently redefine
// what "correct" means.
const expected = (series, firmware) => {
  const fw = Number(String(firmware).padEnd(10, '0'))
  const modes = series === 'a2'
    ? ['low_power', 'normal', 'high_performance']
    : ['normal', 'high_performance']
  return {
    powerModes: fw >= 2025101601 ? [...modes, 'sleep'] : modes,
    setHostname: fw >= 2025062602,
    setNetwork: fw >= 2025062602,
    setIdleFanTimer: fw >= 2025081801,
    resume: fw >= 2026060101 || fw < 2025080401
  }
}

const boot = async (t, series, firmware) => {
  const mock = createServer({ series, firmware, includeChips: false })
  const address = await mock.ready
  t.teardown(() => mock.close())
  const client = createClient({
    host: '127.0.0.1',
    port: address.port,
    timeoutMs: 2000,
    series: series.toUpperCase()
  })
  t.teardown(() => client.stop())
  return { mock, client }
}

for (const series of SERIES) {
  for (const firmware of FIRMWARES) {
    const label = `${series.toUpperCase()}/${firmware}`
    const want = expected(series, firmware)

    test(`${label}: telemetry reads cleanly whatever the series and firmware`, async (t) => {
      // Deliberately not asserting identical numbers across the matrix. The
      // mock now carries each series' measured hardware — the A4 Ultra Hydro
      // is water-cooled, two-board and 10800 W — so equal values would only
      // prove the fleet had been flattened again. What must hold everywhere
      // is that every field resolves, with the right type and no silent null.
      const { client } = await boot(t, series, firmware)
      const stats = await client.stats()

      t.is(stats.state.pmState, 'running')
      t.ok(stats.hashrate.rated > 0, 'rated hashrate resolves')
      t.ok(stats.psu.inputPower > 0, 'input power resolves')
      t.is(typeof stats.thermal.temp, 'number')
      t.is(stats.boards.length, stats.declaredBoardCount, 'boards match the declared count')
      t.is(stats.fans.length, stats.declaredFanCount ?? 0, 'fans match the declared count')
      t.is(stats.boardsComplete, true)

      // Cooling is the one field where the series genuinely diverge, and it
      // drives a different health rule, so it is asserted per series.
      t.is(stats.thermal.liquidCooling, series.toLowerCase() === 'a4',
        `${series} liquidCooling`)
    })

    test(`${label}: capabilities match the documented gates`, async (t) => {
      const { client } = await boot(t, series, firmware)
      const c = await client.getCapabilities()

      t.is(c.series, series.toUpperCase())
      t.alike(c.powerModes, want.powerModes, 'accepted mining modes')
      t.is(c.commands.setHostname.supported, want.setHostname, 'setHostname gate')
      t.is(c.commands.setNetwork.supported, want.setNetwork, 'setNetwork gate')
      t.is(c.commands.setIdleFanTimer.supported, want.setIdleFanTimer, 'setIdleFanTimer gate')
      t.is(c.commands.resume.supported, want.resume, 'resume availability')
      if (!want.resume) t.is(c.commands.resume.fallback, 'restartMiner')
      // Ungated operations are available on every combination.
      for (const name of ['reboot', 'restartMiner', 'suspend', 'setPowerMode', 'setPowerLimit', 'setupPools', 'setTimezone']) {
        t.is(c.commands[name].supported, true, `${name} is never gated`)
      }
    })

    test(`${label}: the device accepts exactly the modes it declares`, async (t) => {
      const { client } = await boot(t, series, firmware)
      const c = await client.getCapabilities()

      // sleep stops hashing on real hardware; the mock tolerates it, but
      // there is no value in exercising it here.
      const settable = c.powerModes.filter((m) => m !== 'sleep')

      // Keyed on the firmware this case booted with, not on a capability flag:
      // when a setting applies is no longer reported per device, because the
      // API cannot read a pending value back. The device behaviour below is
      // unchanged and still worth pinning.
      const fw = Number(String(firmware).padEnd(10, '0'))
      if (fw >= 2026060101) {
        for (const mode of settable) {
          await client.setWorkMode(mode)
          t.is((await client.stats()).state.miningMode, mode, `${mode} applies at once`)
        }
      } else {
        // On an older build the firmware stores the mode and applies it at
        // the next bdminer restart, while stats keeps reporting the running
        // one. Confirmed on a real A2 (2026040101).
        const running = (await client.stats()).state.miningMode
        const target = settable.find((m) => m !== running)
        await client.setWorkMode(target)
        t.is((await client.stats()).state.miningMode, running,
          `${target} is stored, and the readback still shows the running mode`)
        await client.restartMiner()
        t.is((await client.stats()).state.miningMode, target,
          'the stored mode takes effect on the next restart — not discarded, armed')
      }

      // Anything the descriptor withholds must be refused by the firmware
      // itself, not merely by our own table.
      const all = ['low_power', 'normal', 'high_performance', 'sleep']
      for (const mode of all.filter((m) => !c.powerModes.includes(m))) {
        await t.exception(client.setWorkMode(mode), /ERR_ASCSET_FAILED|ERR_INVALID_CMD/, `${mode} is refused`)
      }
    })

    test(`${label}: capabilities do not claim when a setting applies`, async (t) => {
      // Inverted by decision. The flag used to say whether a write was live or
      // armed, derived from a firmware version rather than from the device —
      // the API exposes no pending value to read. Every write now names the
      // channel that confirms it and leaves the timing to the miner, so the
      // flag must stay absent rather than come back as a guess.
      const { client } = await boot(t, series, firmware)
      const c = await client.getCapabilities()
      t.absent(c.settingsApplyImmediately, 'no per-device claim about timing')
      t.ok(Array.isArray(c.powerModes), 'the capability view is otherwise intact')
    })

    test(`${label}: gated commands are refused by the device`, async (t) => {
      const { client } = await boot(t, series, firmware)

      const probes = [
        [want.setHostname, () => client.setHostname('sealminer-matrix'), 'setHostname'],
        [want.setIdleFanTimer, () => client.setIdleFanTimer({ interval: '30', on_duration: '10', speed: '20' }), 'setIdleFanTimer'],
        [want.resume, () => client.resume(), 'resume']
      ]

      for (const [supported, call, name] of probes) {
        if (supported) t.execution(await call().then(() => () => {}), `${name} is accepted`)
        else await t.exception(call(), /ERR_INVALID_CMD/, `${name} is refused by the firmware`)
      }
    })
  }
}

test('the matrix covers every series and every documented gate boundary', (t) => {
  t.is(SERIES.length, 3)
  t.alike([...caps.SERIES].sort(), ['A2', 'A3', 'A4'])
  // One firmware below every gate, one inside the resume removal window, one
  // above every gate.
  const values = FIRMWARES.map((f) => Number(String(f).padEnd(10, '0')))
  t.ok(values.some((v) => v < caps.FW.IDENTITY_AND_NETWORK), 'a build below the identity/network gate')
  t.ok(values.some((v) => v >= caps.FW.RESUME_REMOVED_FROM && v < caps.FW.RESUME_RESTORED), 'a build inside the resume removal window')
  t.ok(values.some((v) => v >= caps.FW.SLEEP_MODE), 'a build with sleep mode')
  t.is(SERIES.length * FIRMWARES.length, 9, '9 combinations')
})
