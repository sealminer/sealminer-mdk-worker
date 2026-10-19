'use strict'

const { guard, DANGER } = require('./_guard')
const client = require('../client')

// Firmware-gated: removed from 2025080401 through 2026053100, restored in
// 2026060101. The guard refuses it on those builds and names restartMiner as
// the fallback, so the caller never has to know the version arithmetic.
module.exports = guard({
  name: 'resume',
  danger: DANGER.DISRUPTIVE,
  cooldownMs: 60 * 1000
})(() => client.resume())
