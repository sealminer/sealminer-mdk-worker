'use strict'

// Stable ERR_* codes. Every one of these must also appear in
// mdk-contract.json's capabilities.errors, which is what operators and AI
// agents look the code up in. scripts/validate-contract.js enforces that.

// --- transport -------------------------------------------------------------
const ERR_API_TIMEOUT = 'ERR_API_TIMEOUT'
const ERR_API_CONNECTION = 'ERR_API_CONNECTION'
const ERR_API_RESPONSE_INVALID = 'ERR_API_RESPONSE_INVALID'
const ERR_API_RESPONSE_TOO_LARGE = 'ERR_API_RESPONSE_TOO_LARGE'
const ERR_API_REQUEST_INVALID = 'ERR_API_REQUEST_INVALID'

// --- protocol (SealMiner reply codes) --------------------------------------
const ERR_INVALID_CMD = 'ERR_INVALID_CMD'
const ERR_JSON_CMD = 'ERR_JSON_CMD'
const ERR_ACCESS_DENIED = 'ERR_ACCESS_DENIED'
const ERR_ASCSET_FAILED = 'ERR_ASCSET_FAILED'
const ERR_UPDATE_POOLS_FAILED = 'ERR_UPDATE_POOLS_FAILED'
const ERR_NO_AVAILABLE_POOL = 'ERR_NO_AVAILABLE_POOL'
const ERR_COMMAND_FAILED = 'ERR_COMMAND_FAILED'

// --- parsing ---------------------------------------------------------------
const ERR_STATS_TRUNCATED = 'ERR_STATS_TRUNCATED'
const ERR_STATS_SHAPE_INVALID = 'ERR_STATS_SHAPE_INVALID'
const ERR_SECTION_MISSING = 'ERR_SECTION_MISSING'

// --- command guard ---------------------------------------------------------
const ERR_COMMAND_COOLDOWN = 'ERR_COMMAND_COOLDOWN'
const ERR_COMMAND_IN_PROGRESS = 'ERR_COMMAND_IN_PROGRESS'

// --- capability gating -----------------------------------------------------
const ERR_COMMAND_NOT_SUPPORTED_ON_MODEL = 'ERR_COMMAND_NOT_SUPPORTED_ON_MODEL'
const ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE = 'ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE'
const ERR_MODE_NOT_SUPPORTED_ON_SERIES = 'ERR_MODE_NOT_SUPPORTED_ON_SERIES'

// --- device config ---------------------------------------------------------
const ERR_DEVICE_CONFIG_INVALID = 'ERR_DEVICE_CONFIG_INVALID'

// --- parameter validation --------------------------------------------------
const ERR_PARAM_REQUIRED = 'ERR_PARAM_REQUIRED'
const ERR_PARAM_TYPE = 'ERR_PARAM_TYPE'
const ERR_PARAM_RANGE = 'ERR_PARAM_RANGE'
const ERR_PARAM_ENUM = 'ERR_PARAM_ENUM'
const ERR_PARAM_SHAPE = 'ERR_PARAM_SHAPE'

// SealMiner universal reply codes (doc section 2) plus the per-command codes
// documented for ascset (4.1) and updatepools (3.5.7).
const REPLY_CODES = {
  14: ERR_INVALID_CMD,
  23: ERR_JSON_CMD,
  45: ERR_ACCESS_DENIED,
  120: ERR_ASCSET_FAILED,
  201: ERR_UPDATE_POOLS_FAILED,
  8: ERR_NO_AVAILABLE_POOL
}

// Codes that mean success and must not be mapped to an error.
const SUCCESS_CODES = new Set([119, 200])

/**
 * Throwable carrying a stable code. `message` always starts with the code so
 * WorkerRuntimeV2's `status: 'FAILED'` payload is greppable by operators.
 */
class SealMinerError extends Error {
  constructor (code, detail, meta) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'SealMinerError'
    this.code = code
    if (meta) Object.assign(this, meta)
  }
}

const fail = (code, detail, meta) => {
  throw new SealMinerError(code, detail, meta)
}

/** Extract a stable code from any error, for audit events. */
const stableCode = (err) => {
  if (err && err.code && /^ERR_[A-Z0-9_]+$/.test(err.code)) return err.code
  const match = /ERR_[A-Z0-9_]+/.exec((err && err.message) || '')
  return match ? match[0] : ERR_COMMAND_FAILED
}

module.exports = {
  SealMinerError,
  fail,
  stableCode,
  REPLY_CODES,
  SUCCESS_CODES,
  ERR_API_TIMEOUT,
  ERR_API_CONNECTION,
  ERR_API_RESPONSE_INVALID,
  ERR_API_RESPONSE_TOO_LARGE,
  ERR_API_REQUEST_INVALID,
  ERR_INVALID_CMD,
  ERR_JSON_CMD,
  ERR_ACCESS_DENIED,
  ERR_ASCSET_FAILED,
  ERR_UPDATE_POOLS_FAILED,
  ERR_NO_AVAILABLE_POOL,
  ERR_COMMAND_FAILED,
  ERR_STATS_TRUNCATED,
  ERR_STATS_SHAPE_INVALID,
  ERR_SECTION_MISSING,
  ERR_COMMAND_COOLDOWN,
  ERR_COMMAND_IN_PROGRESS,
  ERR_COMMAND_NOT_SUPPORTED_ON_MODEL,
  ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE,
  ERR_MODE_NOT_SUPPORTED_ON_SERIES,
  ERR_DEVICE_CONFIG_INVALID,
  ERR_PARAM_REQUIRED,
  ERR_PARAM_TYPE,
  ERR_PARAM_RANGE,
  ERR_PARAM_ENUM,
  ERR_PARAM_SHAPE
}
