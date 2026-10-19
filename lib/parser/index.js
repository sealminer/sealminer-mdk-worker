'use strict'

const status = require('./status')
const flatKeys = require('./flat-keys')
const normalize = require('./normalize')
const { parseStats } = require('./stats')
const { parseSummary } = require('./summary')
const { parsePools, parsePool, activePool } = require('./pools')
const { parseVersion, parseConfig, parseDevDetails } = require('./misc')

module.exports = {
  // envelope
  readStatus: status.readStatus,
  assertOk: status.assertOk,
  isAcknowledged: status.isAcknowledged,
  section: status.section,
  // sections
  parseStats,
  parseSummary,
  parsePools,
  parsePool,
  activePool,
  parseVersion,
  parseConfig,
  parseDevDetails,
  // primitives, exported for tests and diagnostic tooling
  group: flatKeys.group,
  normalize
}
