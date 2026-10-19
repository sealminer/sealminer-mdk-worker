#!/usr/bin/env node
'use strict'

// Start the bundled mock miner on its own, so anything that speaks the
// SealMiner 4028 API can be developed against it with no hardware.
//
//   node scripts/run-mock.js [--port 4028] [--series a2|a3|a4]
//                            [--firmware 2026060901] [--chips 1092]
//                            [--fault fan_stopped --fault psu_error]
//                            [--no-writes] [--legacy-types] [--truncate 65536]

const { createServer } = require('../mock/server')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)
const faults = argv.reduce((acc, arg, i) => (arg === '--fault' ? [...acc, argv[i + 1]] : acc), [])

const main = async () => {
  const mock = createServer({
    port: Number(flag('port', 4028)),
    host: flag('host', '127.0.0.1'),
    series: flag('series', 'a2'),
    firmware: flag('firmware', '2026060901'),
    chipCount: Number(flag('chips', 1092)),
    truncateAt: flag('truncate') ? Number(flag('truncate')) : null,
    legacyTypes: has('legacy-types'),
    writesEnabled: !has('no-writes'),
    includeChips: true,
    faults
  })

  mock.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('')
      console.error(`  Port ${flag('port', 4028)} is already in use.`)
      console.error('  Another mock, or something else on 4028. Pick a free one with --port.')
      console.error('')
    } else {
      console.error(`  Could not listen: ${err.code || err.message}`)
    }
    process.exit(1)
  })

  const address = await mock.ready
  console.log(`mock SealMiner listening on ${address.address}:${address.port}`)
  console.log(`  series=${mock.state.series} firmware=${mock.state.firmware} model=${mock.state.model}`)
  console.log(`  boards=${mock.state.boards.length} fans=${mock.state.fans.length} chips=${mock.state.cfg.chipCount}`)
  console.log(`  writes ${mock.state.cfg.writesEnabled ? 'enabled' : 'DENIED (reply code 45)'}`)
  if (faults.length) console.log(`  faults: ${faults.join(', ')}`)
  console.log('')
  console.log(`try: echo '{"command":"summary"}' | nc ${address.address} ${address.port}`)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { mock.close(); process.exit(0) })
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
