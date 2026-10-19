'use strict'

const client = require('../client')

// The firmware build is what gates five of the write commands, so this is
// the first channel to read when a write comes back ERR_INVALID_CMD.
module.exports = async () => {
  const [s, version] = await Promise.all([client.stats(), client.version()])
  return {
    firmware: s.firmware.firmware,
    softwareVersion: s.firmware.softwareVersion,
    bdminer: version.bdminer,
    apiVersion: version.api,
    binVersion: s.firmware.binVersion,
    binNumber: s.firmware.binNumber,
    liquidCooling: s.firmware.liquidCooling
  }
}
