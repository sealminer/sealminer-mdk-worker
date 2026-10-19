'use strict'

const {
  fail,
  REPLY_CODES,
  SUCCESS_CODES,
  ERR_COMMAND_FAILED,
  ERR_API_RESPONSE_INVALID,
  ERR_SECTION_MISSING
} = require('../errors')

// `restart` and `reboot` answer with a bare string STATUS instead of the
// usual array of status objects (doc 3.9 / 3.10).
const BARE_STATUSES = new Set(['RESTART', 'REBOOT'])

// Letter in STATUS[].STATUS: S=success, I=info, W=warning, E=error, F=fatal.
const FAILED_LETTERS = new Set(['E', 'F'])

/**
 * Normalize the reply envelope into a flat status descriptor.
 * Never throws — use assertOk for that.
 */
const readStatus = (body) => {
  if (typeof body?.STATUS === 'string') {
    return {
      ok: BARE_STATUSES.has(body.STATUS),
      bare: body.STATUS,
      letter: null,
      code: null,
      msg: body.STATUS,
      description: null
    }
  }
  const entry = Array.isArray(body?.STATUS) ? body.STATUS[0] : null
  if (!entry) return { ok: false, bare: null, letter: null, code: null, msg: null, description: null }
  return {
    ok: !FAILED_LETTERS.has(entry.STATUS) && !REPLY_CODES[entry.Code],
    bare: null,
    letter: entry.STATUS || null,
    code: typeof entry.Code === 'number' ? entry.Code : null,
    msg: entry.Msg || null,
    description: entry.Description || null
  }
}

/**
 * Throw a stable error unless the reply reports success.
 * @param {object} body parsed reply
 * @param {string} command the command that produced it, for the error detail
 */
const assertOk = (body, command) => {
  if (!body || typeof body !== 'object') {
    fail(ERR_API_RESPONSE_INVALID, `${command}: reply is not an object`)
  }
  const status = readStatus(body)
  if (status.ok) return status

  if (status.code !== null && REPLY_CODES[status.code]) {
    fail(REPLY_CODES[status.code], `${command}: ${status.msg || `code ${status.code}`}`, {
      replyCode: status.code
    })
  }
  if (status.letter === null && status.bare === null) {
    fail(ERR_API_RESPONSE_INVALID, `${command}: missing STATUS`)
  }
  fail(ERR_COMMAND_FAILED, `${command}: ${status.msg || status.letter || status.bare}`, {
    replyCode: status.code
  })
}

/** True when the reply carries an explicit success code (ascset 119, updatepools 200). */
const isAcknowledged = (body) => {
  const { code } = readStatus(body)
  return code !== null && SUCCESS_CODES.has(code)
}

/**
 * Pull one payload section out of a validated reply.
 * @param {object} body parsed reply
 * @param {string} name section key, e.g. 'STATS' or 'POOLS'
 * @param {object} [opts]
 * @param {boolean} [opts.list] return the whole array instead of the first entry
 * @param {boolean} [opts.optional] return null instead of throwing when absent
 */
const section = (body, name, opts = {}) => {
  const value = body?.[name]
  if (!Array.isArray(value)) {
    if (opts.optional) return opts.list ? [] : null
    fail(ERR_SECTION_MISSING, name)
  }
  return opts.list ? value : (value[0] ?? null)
}

module.exports = { readStatus, assertOk, isAcknowledged, section, BARE_STATUSES }
