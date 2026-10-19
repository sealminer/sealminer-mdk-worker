'use strict'

const {
  fail,
  ERR_PARAM_REQUIRED,
  ERR_PARAM_TYPE,
  ERR_PARAM_RANGE,
  ERR_PARAM_ENUM,
  ERR_PARAM_SHAPE
} = require('./errors')

// Parameter validation for command handlers.
//
// Kernel's dispatcher validates only two things: that a number/string
// parameter has the declared primitive type, and that a number falls inside
// a declared min/max. It skips `required` entirely (an undefined value is
// passed through) and never looks at `enum`. So required-ness, enums,
// booleans, objects and every shape check are the handler's job, and every
// failure has to carry a stable code the contract documents.

const present = (params, name) => params !== null && params !== undefined && params[name] !== undefined

const requireParam = (params, name) => {
  if (!present(params, name)) fail(ERR_PARAM_REQUIRED, name)
  return params[name]
}

/**
 * @param {object} params
 * @param {string} name
 * @param {object} [spec]
 * @param {boolean} [spec.required=true]
 * @param {string[]} [spec.enum] allowed values
 * @param {RegExp} [spec.pattern]
 * @param {number} [spec.maxLength]
 */
const string = (params, name, spec = {}) => {
  const required = spec.required !== false
  if (!present(params, name)) {
    if (required) fail(ERR_PARAM_REQUIRED, name)
    return undefined
  }
  const value = params[name]
  if (typeof value !== 'string') fail(ERR_PARAM_TYPE, `${name} must be a string`)
  const trimmed = value.trim()
  if (required && trimmed === '') fail(ERR_PARAM_REQUIRED, `${name} must not be empty`)
  if (spec.maxLength && trimmed.length > spec.maxLength) {
    fail(ERR_PARAM_RANGE, `${name} exceeds ${spec.maxLength} characters`)
  }
  if (spec.enum && !spec.enum.includes(trimmed)) {
    fail(ERR_PARAM_ENUM, `${name} must be one of ${spec.enum.join(', ')}`)
  }
  if (spec.pattern && !spec.pattern.test(trimmed)) {
    fail(ERR_PARAM_SHAPE, `${name} has an invalid format`)
  }
  return trimmed
}

/**
 * @param {object} params
 * @param {string} name
 * @param {object} [spec]
 * @param {boolean} [spec.required=true]
 * @param {number} [spec.min]
 * @param {number} [spec.max]
 * @param {boolean} [spec.integer]
 * @param {number[]} [spec.allow] values accepted outside [min, max], e.g. -1 as a sentinel
 */
const number = (params, name, spec = {}) => {
  const required = spec.required !== false
  if (!present(params, name)) {
    if (required) fail(ERR_PARAM_REQUIRED, name)
    return undefined
  }
  const value = params[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ERR_PARAM_TYPE, `${name} must be a finite number`)
  }
  if (spec.integer && !Number.isInteger(value)) fail(ERR_PARAM_TYPE, `${name} must be an integer`)
  if (Array.isArray(spec.allow) && spec.allow.includes(value)) return value
  if (spec.min !== undefined && value < spec.min) {
    fail(ERR_PARAM_RANGE, `${name} ${value} is below the minimum ${spec.min}`)
  }
  if (spec.max !== undefined && value > spec.max) {
    fail(ERR_PARAM_RANGE, `${name} ${value} is above the maximum ${spec.max}`)
  }
  return value
}

const boolean = (params, name, spec = {}) => {
  const required = spec.required !== false
  if (!present(params, name)) {
    if (required) fail(ERR_PARAM_REQUIRED, name)
    return undefined
  }
  const value = params[name]
  // Deliberately strict: accepting "false" or 0 here would let a typo switch
  // a physical setting on.
  if (typeof value !== 'boolean') fail(ERR_PARAM_TYPE, `${name} must be a boolean`)
  return value
}

const object = (params, name, spec = {}) => {
  const required = spec.required !== false
  if (!present(params, name)) {
    if (required) fail(ERR_PARAM_REQUIRED, name)
    return undefined
  }
  const value = params[name]
  if (typeof value !== 'object' || value === null) fail(ERR_PARAM_TYPE, `${name} must be an object`)
  if (spec.array && !Array.isArray(value)) fail(ERR_PARAM_TYPE, `${name} must be an array`)
  if (!spec.array && Array.isArray(value)) fail(ERR_PARAM_TYPE, `${name} must not be an array`)
  return value
}

// --- domain shapes ---------------------------------------------------------

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const POOL_URL = /^stratum\+tcp:\/\/\S+:\d+$/i

/**
 * Validate a pool list for `updatepools`.
 * @param {*} value
 * @param {number} maxPools
 * @returns {{url: string, user: string, pass: string}[]}
 */
const poolList = (value, maxPools) => {
  if (!Array.isArray(value)) fail(ERR_PARAM_TYPE, 'pools must be an array')
  if (value.length === 0) fail(ERR_PARAM_SHAPE, 'pools must contain at least one entry')
  // The cap is optional. Omitted, no upper bound is imposed and the miner
  // answers: updatepools replies 201 or 8 when it refuses a list.
  if (maxPools !== undefined && value.length > maxPools) {
    fail(ERR_PARAM_RANGE, `pools accepts at most ${maxPools} entries`)
  }

  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(ERR_PARAM_SHAPE, `pools[${i}] must be an object`)
    }
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    if (!url) fail(ERR_PARAM_SHAPE, `pools[${i}].url is required`)
    if (!POOL_URL.test(url)) fail(ERR_PARAM_SHAPE, `pools[${i}].url must look like stratum+tcp://host:port`)
    const user = typeof entry.user === 'string' ? entry.user.trim() : ''
    if (!user) fail(ERR_PARAM_SHAPE, `pools[${i}].user is required`)
    const pass = entry.pass === undefined ? 'x' : entry.pass
    if (typeof pass !== 'string') fail(ERR_PARAM_TYPE, `pools[${i}].pass must be a string`)
    return { url, user, pass }
  })
}

/**
 * Validate a network configuration for `ascset network`.
 * DHCP mode needs nothing else; static mode needs a full, self-consistent set
 * because a wrong value makes the miner unreachable.
 */
const networkConfig = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(ERR_PARAM_TYPE, 'network must be an object')
  }
  const dhcp = String(value.dhcp ?? '')
  if (dhcp !== '0' && dhcp !== '1') fail(ERR_PARAM_SHAPE, 'network.dhcp must be "0" (static) or "1" (dhcp)')

  if (dhcp === '1') {
    // The firmware ignores the rest in DHCP mode.
    return { dhcp: '1' }
  }

  const out = { dhcp: '0' }
  for (const field of ['ip', 'netmask', 'gateway']) {
    const v = value[field]
    if (typeof v !== 'string' || !IPV4.test(v.trim())) {
      fail(ERR_PARAM_SHAPE, `network.${field} must be an IPv4 address in static mode`)
    }
    out[field] = v.trim()
  }
  for (const field of ['dns1', 'dns2']) {
    if (value[field] === undefined || value[field] === '') continue
    const v = value[field]
    if (typeof v !== 'string' || !IPV4.test(v.trim())) {
      fail(ERR_PARAM_SHAPE, `network.${field} must be an IPv4 address`)
    }
    out[field] = v.trim()
  }
  return out
}

module.exports = {
  present,
  requireParam,
  string,
  number,
  boolean,
  object,
  poolList,
  networkConfig,
  HOSTNAME,
  IPV4,
  POOL_URL
}
