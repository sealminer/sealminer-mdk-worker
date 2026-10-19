'use strict'

const client = require('../client')

// Performance ratio the firmware computes itself: stats PR(Avg), percent.
module.exports = async () => (await client.stats()).pr.avg
