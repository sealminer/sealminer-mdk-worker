#!/usr/bin/env node
'use strict'

// Capture a real miner's raw replies, to calibrate mock/fixtures against
// hardware instead of against the API document's (truncated) examples.
//
//   node scripts/dump-stats.js <address> --out <dir> [--port 4028] [--raw]
//
// Read-only: issues version, summary, config, devs, pools, devdetails,
// stats and coin, and writes each reply. No write command is sent.
//
// Also reports whether stats came back clipped (reply id 0) and how many
// keys it carried — the two numbers that decide how the worker must treat
// board-level channels on this hardware.
//
// `--out` is required. It used to default to mock/fixtures, which quietly
// overwrote the committed capture — and a miner's `pools` reply carries the
// worker name the site actually mines under, which in our case embeds the
// facility. Pool users are redacted on the way out unless --raw is passed;
// point --raw somewhere outside the repo.

const fs = require('node:fs')
const path = require('node:path')
const { TcpRpc } = require('../lib/tcp-rpc')

const READ_COMMANDS = ['version', 'summary', 'config', 'devs', 'pools', 'devdetails', 'stats', 'coin']

const address = process.argv[2]
const argv = process.argv.slice(3)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const raw = argv.includes('--raw')

if (!address || !flag('out')) {
  console.error('usage: node scripts/dump-stats.js <address> --out <dir> [--port 4028] [--raw]')
  console.error('  --out is required; --raw keeps real pool user names (write outside the repo)')
  process.exit(1)
}

// A pool `User` is the site's own worker name. Redact it unless asked not to.
const redact = (body) => {
  for (const pool of body?.POOLS || []) {
    if (pool.User) pool.User = 'REDACTED.worker'
  }
  return body
}

const main = async () => {
  const outDir = path.resolve(flag('out'))
  fs.mkdirSync(outDir, { recursive: true })

  const rpc = new TcpRpc({ host: address, port: Number(flag('port', 4028)), timeoutMs: 15000 })
  const summary = []

  for (const command of READ_COMMANDS) {
    try {
      const { body, truncated, bytes } = await rpc.request({ command })
      const file = path.join(outDir, `${command}.json`)
      fs.writeFileSync(file, JSON.stringify(raw ? body : redact(body), null, 2))
      const keys = command === 'stats' ? Object.keys(body.STATS?.[0] || {}).length : null
      summary.push({ command, bytes, truncated, keys, file: path.relative(process.cwd(), file) })
    } catch (err) {
      summary.push({ command, error: err.code || err.message })
    }
  }

  rpc.stop()

  for (const row of summary) {
    if (row.error) { console.log(`  ${row.command.padEnd(11)} FAILED  ${row.error}`); continue }
    const extra = [row.keys !== null && `${row.keys} keys`, row.truncated && 'TRUNCATED (id: 0)']
      .filter(Boolean).join(', ')
    console.log(`  ${row.command.padEnd(11)} ${String(row.bytes).padStart(8)} bytes  ${extra}`)
  }

  const stats = summary.find((r) => r.command === 'stats')
  if (stats?.truncated) {
    console.log('')
    console.log('NOTE: stats was clipped on this device. Board-level channels will')
    console.log('      report null for this hardware; see lib/api-client.js.')
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
