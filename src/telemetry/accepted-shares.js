'use strict'

const client = require('../client')

// summary Accepted. Resets on restartMiner as well as reboot.
module.exports = async () => (await client.summary()).shares.accepted
