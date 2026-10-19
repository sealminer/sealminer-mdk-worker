'use strict'

const debug = require('debug')('sealminer:parser')
const legacy = require('./legacy-enums')

// Canonical lowercase tokens, decoupled from the firmware's display strings.
// Consumers (UI, AI agents) match on these; the display strings can change
// across firmware without breaking anyone.
const MINING_MODES = ['low_power', 'normal', 'high_performance', 'ultra_low_power', 'custom', 'smartboost']
const PM_STATES = ['idle', 'initializing', 'running', 'resuming', 'resume_failed', 'suspended', 'suspending', 'suspend_failed']
const TUNE_STATUSES = ['tuning_idle', 'coarse_tuning', 'coarse_tuning_done', 'fine_tuning', 'fine_tuning_done']

/** "High Performance" -> "high_performance" */
const tokenize = (value) =>
  String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')

/**
 * Normalize a value that firmware may send as a display string (new builds)
 * or an integer (old builds).
 *
 * @param {*} value raw field value
 * @param {string[]} allowed canonical tokens
 * @param {Record<number,string>} legacyMap integer -> token, may be empty
 * @param {string} field field name, for debug output
 * @returns {string|null} a canonical token, or null when unknown
 */
const toEnum = (value, allowed, legacyMap, field) => {
  if (value === null || value === undefined || value === '') return null

  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const mapped = legacyMap[Number(value)]
    if (mapped) return mapped
    // Unknown legacy encoding: report unknown rather than inventing a value.
    debug('unmapped legacy enum: %s=%o', field, value)
    return null
  }

  const token = tokenize(value)
  if (allowed.includes(token)) return token
  debug('unknown enum value: %s=%o (token %s)', field, value, token)
  return null
}

/**
 * Fields the document lists as having changed from Int to Boolean. Accept both
 * shapes plus the string forms some builds emit.
 */
const toBoolean = (value) => {
  if (value === true || value === false) return value
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === 'y' || text === 'yes') return true
  if (text === 'false' || text === 'n' || text === 'no') return false
  const n = Number(text)
  return Number.isFinite(n) ? n !== 0 : null
}

/** Finite number or null. Never coerces a missing field to 0. */
const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Non-empty trimmed string or null. */
const toString_ = (value) => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

const MH_PER_TH = 1e6

/** MH/s (every hashrate field in this API) -> TH/s, rounded to 2 decimals. */
const mhsToThs = (value) => {
  const n = toNumber(value)
  if (n === null) return null
  return Math.round((n / MH_PER_TH) * 100) / 100
}

const miningMode = (value) => toEnum(value, MINING_MODES, legacy.MINING_MODE, 'Mining Mode')
const pmState = (value) => toEnum(value, PM_STATES, legacy.PM_STATE, 'PM State')
const tuneStatus = (value) => toEnum(value, TUNE_STATUSES, legacy.TUNE_STATUS, 'Tune Status')

module.exports = {
  tokenize,
  toEnum,
  toBoolean,
  toNumber,
  toString: toString_,
  mhsToThs,
  miningMode,
  pmState,
  tuneStatus,
  MINING_MODES,
  PM_STATES,
  TUNE_STATUSES,
  MH_PER_TH
}
