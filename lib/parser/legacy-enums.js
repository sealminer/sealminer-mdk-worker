'use strict'

// Firmware builds before the V0.5-era change emitted these fields as
// integers; newer builds emit strings (doc 3.7, "These have changed from Int
// to String"). The document only specifies the new string values, so the old
// integer encodings are unknown.
//
// Policy: do NOT guess. An unmapped integer normalizes to null, the channel
// reports null, and lib/parser/normalize.js records a debug line. A wrong
// guess here would silently mislabel a miner's power mode, which is worse
// than reporting "unknown".
//
// TODO(sealminer-firmware): fill these in once SealMiner confirms the legacy
// integer encodings, then extend tests/unit/normalize.test.js's legacy
// fixtures. Until then every table stays empty on purpose.

/** @type {Record<number, string>} */
const MINING_MODE = {}

/** @type {Record<number, string>} */
const PM_STATE = {}

/** @type {Record<number, string>} */
const TUNE_STATUS = {}

module.exports = { MINING_MODE, PM_STATE, TUNE_STATUS }
