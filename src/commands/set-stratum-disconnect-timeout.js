'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')
const { STRATUM_DISCONNECT_TIMEOUT_S } = require('../../lib/provisional')

// PROVISIONAL BOUNDS: the document states no range. Too short and the miner
// reacts to normal pool jitter; too long and failover is delayed.
const { describeBlindWrite } = require('./_write-result')

const describeWrite = describeBlindWrite('the stratum disconnect timeout')

module.exports = guard({
  name: 'setStratumDisconnectTimeout',
  danger: DANGER.SAFE,
  exclusive: false,
  validate: (params) => ({
    // A wide envelope, not a measurement: the document shows 120 and states
    // no range. One second to one day, so it can only ever catch a typo.
    seconds: v.number(params, 'seconds', { ...STRATUM_DISCONNECT_TIMEOUT_S, integer: true })
  }),
  describe: (params) => describeWrite(params)
})(({ seconds }) => client.setStratumDisconnectTimeout(seconds))
