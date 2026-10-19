'use strict'

const client = require('../client')

// What this specific device accepts, given its series and firmware. Read it
// before offering or dispatching a command: the A2/A3/A4 mode sets differ,
// five operations are firmware-gated, and resume is missing from a range of
// builds. A UI should disable unsupported controls rather than let a call fail.
module.exports = async () => client.getCapabilities()
