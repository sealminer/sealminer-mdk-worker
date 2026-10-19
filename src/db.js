'use strict'

const { DatabaseSync } = require('node:sqlite')
const { id, opts, logger } = require('@tetherto/mdk-worker/device')

// This device's own persistence — a plain SQLite file, no MDK stores. It
// holds three things:
//
//   telemetry  a bounded sample history, served by the `history` channel
//   commands   a durable copy of the audit events the guard emits
//   cooldowns  the last attempt time per command, so declared spacing
//              survives a worker restart
//
// The last one is the reason this file exists rather than being a nicety.
// `lib/command-guard.js` keeps cooldowns in a process-local Map, so a restart
// clears them and a DISRUPTIVE command could be re-issued immediately. The
// guard takes a `store` seam; this is what fills it.
//
// Bound directly to this device's own dbPath, the same way client.js binds to
// its connection opts: the runtime loads this module fresh into a private
// registry per device, so two devices pointed at the same file still get a
// connection each rather than sharing a handle.
//
// `dbPath` is optional. Without it everything below still works, in memory,
// and is lost on exit — history becomes per-process and the cooldown gains
// nothing. Persistence is opt-in because a site that has not chosen where
// worker state lives should not have a file appear somewhere we picked.

const dbPath = opts.dbPath || ':memory:'
const durable = dbPath !== ':memory:'

// Keep the default small. Kernel's `metrics` pull invokes *every* telemetry
// handler, `history` included, so this array rides along in the 10-second
// fleet snapshot. Callers that want more ask for it by name.
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 500

// Bounded on purpose: a worker left running for months must not grow a
// database without limit. Pruning is by age, done on write.
const SAMPLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const COMMAND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000

const db = new DatabaseSync(dbPath)

// WAL lets the sampling writes and the history reads proceed without
// blocking each other; it is a no-op for an in-memory database.
if (durable) {
  try {
    db.exec('PRAGMA journal_mode = WAL')
  } catch (err) {
    logger('sqlite: could not enable WAL on %s: %s', dbPath, err.message)
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    hashrate_ths REAL,
    power_w REAL,
    temperature_c REAL,
    power_mode TEXT,
    pm_state TEXT,
    health TEXT,
    firmware TEXT
  );
  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    command TEXT NOT NULL,
    outcome TEXT NOT NULL,
    danger TEXT,
    error_code TEXT,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS cooldowns (
    device_id TEXT NOT NULL,
    command TEXT NOT NULL,
    last_attempt_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, command)
  );
  CREATE INDEX IF NOT EXISTS telemetry_device_ts ON telemetry (device_id, ts);
  CREATE INDEX IF NOT EXISTS commands_device_ts ON commands (device_id, ts);
`)

// CREATE TABLE IF NOT EXISTS leaves an existing table alone, so a column
// added after a store was already in the field has to be migrated in. Adding
// `firmware` to a database created by an earlier version would otherwise fail
// every insert with "no column named firmware" — and because recordSample is
// best-effort, it would fail silently, leaving the history frozen.
//
// Additive only: new nullable columns, never a rewrite. Old rows keep a null
// where the value was not being recorded yet, which is the truth about them.
const migrate = () => {
  const columns = new Set(db.prepare('PRAGMA table_info(telemetry)').all().map((c) => c.name))
  for (const [name, type] of [['firmware', 'TEXT']]) {
    if (columns.has(name)) continue
    db.exec(`ALTER TABLE telemetry ADD COLUMN ${name} ${type}`)
    logger('sqlite: added telemetry.%s to an existing store', name)
  }
}
migrate()

const insertSample = db.prepare(`
  INSERT INTO telemetry (device_id, ts, hashrate_ths, power_w, temperature_c, power_mode, pm_state, health, firmware)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const insertCommand = db.prepare(`
  INSERT INTO commands (device_id, ts, command, outcome, danger, error_code, detail)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)
const selectSamples = db.prepare(`
  SELECT ts, hashrate_ths AS hashrateThs, power_w AS powerW, temperature_c AS temperatureC,
         power_mode AS powerMode, pm_state AS pmState, health, firmware
  FROM telemetry WHERE device_id = ? ORDER BY ts DESC LIMIT ?`)
const selectCommands = db.prepare(`
  SELECT ts, command, outcome, danger, error_code AS errorCode, detail
  FROM commands WHERE device_id = ? ORDER BY ts DESC LIMIT ?`)
const upsertCooldown = db.prepare(`
  INSERT INTO cooldowns (device_id, command, last_attempt_at) VALUES (?, ?, ?)
  ON CONFLICT (device_id, command) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`)
const selectCooldown = db.prepare(
  'SELECT last_attempt_at AS lastAttemptAt FROM cooldowns WHERE device_id = ? AND command = ?')
const pruneSamples = db.prepare('DELETE FROM telemetry WHERE device_id = ? AND ts < ?')
const pruneCommands = db.prepare('DELETE FROM commands WHERE device_id = ? AND ts < ?')

let lastPruneAt = 0
const pruneIfDue = (nowMs) => {
  if (nowMs - lastPruneAt < PRUNE_EVERY_MS) return
  lastPruneAt = nowMs
  pruneSamples.run(id, nowMs - SAMPLE_RETENTION_MS)
  pruneCommands.run(id, nowMs - COMMAND_RETENTION_MS)
}

const clampLimit = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

// A number that SQLite will accept, or null. Guards against a parser that
// legitimately reports `null` for a field this firmware does not send.
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value) => (typeof value === 'string' && value.length ? value : null)

module.exports = {
  dbPath,
  durable,
  DEFAULT_LIMIT,
  MAX_LIMIT,

  /**
   * Append one telemetry sample. Best-effort by contract: sampling must never
   * be the reason a telemetry pull fails, so the caller swallows throws.
   */
  recordSample (sample = {}) {
    const ts = Date.now()
    insertSample.run(
      id, ts,
      num(sample.hashrateThs), num(sample.powerW), num(sample.temperatureC),
      str(sample.powerMode), str(sample.pmState), str(sample.health),
      // Recorded so a firmware upgrade under a running fleet is discoverable
      // from the worker's own store. Every gate in lib/capabilities.js is
      // keyed to a version, so "when did this device's firmware change" is
      // the question that starts the maintenance procedure in FIRMWARE.md —
      // and without this column the answer is nowhere.
      str(sample.firmware))
    pruneIfDue(ts)
  },

  /** Persist one audit event from the command guard. */
  recordCommand (event = {}) {
    const ts = Number(event.ts) || Date.now()
    insertCommand.run(
      id, ts,
      String(event.command ?? 'unknown'),
      String(event.outcome ?? 'unknown'),
      str(event.class),
      str(event.errorCode),
      str(event.detail))
    pruneIfDue(ts)
  },

  recentSamples (limit) {
    return selectSamples.all(id, clampLimit(limit))
  },

  recentCommands (limit) {
    return selectCommands.all(id, clampLimit(limit))
  },

  // --- the guard's `store` seam --------------------------------------------

  getLastAttempt (command) {
    const row = selectCooldown.get(id, command)
    return row ? Number(row.lastAttemptAt) : null
  },

  setLastAttempt (command, ts) {
    upsertCooldown.run(id, command, Number(ts))
  },

  close () {
    db.close()
  }
}
