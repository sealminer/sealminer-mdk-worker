'use strict'

const { id } = require('@tetherto/mdk-worker/device')
const client = require('../client')
const db = require('../db')
const { createGuard, DANGER } = require('../../lib/command-guard')

// One guard per device: WorkerRuntimeV2 loads this module into a private
// registry for each miner, so the cooldown timestamps and in-flight set it
// holds already belong to exactly one device. No keying by id, no leakage.
//
// `store` moves the cooldown clock out of process memory, so declared
// spacing between physical commands survives a worker restart instead of
// being silently reset by one. `audit` keeps the console line the MDK guide
// specifies and additionally lands every event in SQLite, because a
// console-only audit trail is gone the moment the process is.
const guard = createGuard({
  deviceId: id,
  getCapabilities: () => client.getCapabilities(),
  store: db,
  audit: (event) => {
    console.info(JSON.stringify(event))
    try {
      db.recordCommand(event)
    } catch {
      // An audit sink that cannot be written must not block a physical
      // command — the console line above is already out.
    }
  }
})

module.exports = { guard, DANGER }
