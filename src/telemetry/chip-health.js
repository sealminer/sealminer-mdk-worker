'use strict'

const client = require('../client')

// Whole-miner counts survive a clipped reply because they are device-level
// fields; only the per-board breakdown is lost, and that is reported as null
// rather than omitted.
module.exports = async () => {
  const s = await client.stats()
  const count = s.chip.count
  const bad = s.chip.badCount
  return {
    chipCount: count,
    badChipCount: bad,
    badChipRatio: count && bad !== null ? Math.round((bad / count) * 10000) / 10000 : null,
    errorChip: s.state.errorChip,
    boardsComplete: s.boardsComplete,
    boards: s.boardsComplete
      ? s.boards.map((b) => ({
        index: b.index,
        chipCount: b.chipCount,
        badChipCount: b.badChipCount,
        badChipRatio: b.badChipRatio
      }))
      : null
  }
}
