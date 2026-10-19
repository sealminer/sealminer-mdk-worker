#!/usr/bin/env node
'use strict'

// Probe the write path without writing anything.
//
//   node scripts/test-live-ascset-help.js <address> [--port 4028]
//
// `ascset help` is the only ascset subcommand with no effect: it returns the
// list of subcommands this firmware actually implements. Use it to
//   - confirm the ascset path is reachable at all,
//   - see whether the miner answers or refuses with reply code 45
//     (ERR_ACCESS_DENIED), which is how API write permission shows up,
//   - discover subcommands the API document does not describe.
//
// Sends no state-changing command.

const { TcpRpc } = require('../lib/tcp-rpc')
const { readStatus } = require('../lib/parser/status')

const address = process.argv[2]
const argv = process.argv.slice(3)
const portFlag = argv.indexOf('--port')

if (!address) {
  console.error('usage: node scripts/test-live-ascset-help.js <address> [--port 4028]')
  process.exit(1)
}

const main = async () => {
  const rpc = new TcpRpc({
    host: address,
    port: portFlag === -1 ? 4028 : Number(argv[portFlag + 1]),
    timeoutMs: 10000
  })

  const { body } = await rpc.request({ command: 'ascset', parameter: '0,help' })
  rpc.stop()

  const status = readStatus(body)
  console.log(JSON.stringify({ address, code: status.code, letter: status.letter, message: status.msg }, null, 2))

  if (status.code === 45) {
    console.log('')
    console.log('Reply code 45 (Access denied): API write access is not enabled on this miner.')
    console.log('Every write command will be refused until it is enabled on the device.')
    return
  }

  const listed = /help:\s*(.+)$/.exec(status.msg || '')
  if (listed) {
    const subcommands = listed[1].split('&').map((s) => s.trim().replace(/"+$/, '')).filter(Boolean)
    console.log('')
    console.log('subcommands this firmware reports:')
    for (const sub of subcommands) console.log(`  ${sub}`)
  }
}

main().catch((err) => { console.error(String(err.message || err)); process.exitCode = 1 })
