'use strict'

const { createServer } = require('./mock/server')

// Glue for MDK's worker-smoke harness:
//   node <mdk>/packages/mdk-skill/src/skills/mdk-worker-plugin/scripts/worker-smoke.mjs .
//
// Boots the bundled mock, hands the harness this device's connection opts and
// one sample parameter set per command it should execute.
//
// Destructive commands are deliberately absent from `commands`. reboot,
// restartMiner, suspend, resume and setNetwork all interrupt mining or change
// reachability on real hardware, and an automated smoke run is exactly the
// context in which nobody is watching. They are covered by the unit and
// integration suites against the mock instead.
module.exports = {
  async setup () {
    const mock = createServer({
      series: 'a2',
      firmware: '2026060901',
      includeChips: false
    })
    const address = await mock.ready

    return {
      config: {
        address: '127.0.0.1',
        port: address.port,
        // Declared by the site; wins over inferring the series from the model.
        series: 'A2'
      },
      commands: {
        setPowerMode: { mode: 'normal' },
        setPowerLimit: { watts: 3000 },
        setupPools: {
          pools: [{ url: 'stratum+tcp://pool.example.com:3333', user: 'sealminer.001', pass: 'x' }]
        },
        setTimezone: { tz: 'Asia/Singapore' },
        // All four fields are required: the firmware refuses a partial payload.
        setPreheat: { enableBootPreheat: true, bootPreheatTemp: 20, bootPreheatTimeout: -1, enableTunePreheat: true },
        setFastRaiseFreq: { enabled: false },
        setHostname: { hostname: 'sealminer-smoke' },
        setIdleFanTimer: { interval: 30, onDuration: 10, speed: 20 },
        setStratumDisconnectTimeout: { seconds: 120 }
      },
      teardown: () => mock.close()
    }
  }
}
