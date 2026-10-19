'use strict'

const client = require('../client')

// summary Rejected. Read together with accepted_shares or use reject_rate.
module.exports = async () => (await client.summary()).shares.rejected
