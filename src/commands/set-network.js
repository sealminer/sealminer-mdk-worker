'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')
const v = require('../../lib/validate')

// The one command that can make a miner unreachable, so it is classified
// RISKY: single attempt, never retried, and a 5-minute cooldown to stop a
// script from walking a rack off the network. Static mode requires a
// complete, well-formed ip/netmask/gateway set — Kernel validates none of it.
const { describeBlindWrite } = require('./_write-result')

const describeWrite = describeBlindWrite('the network configuration')

module.exports = guard({
  name: 'setNetwork',
  danger: DANGER.RISKY,
  cooldownMs: 5 * 60 * 1000,
  validate: (params) => ({ network: v.networkConfig(params.network) }),
  describe: (params) => describeWrite(params)
})(({ network }) => client.setNetwork(network))
