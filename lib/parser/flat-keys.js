'use strict'

// `stats` packs three levels into one flat object, distinguished only by a
// numeric key prefix (doc 3.7):
//
//   "Temp"          whole device
//   "0 Temp"        board 0        |  "0 Speed"  fan 0
//   "0.107 Freq"    board 0, chip 107
//
// Boards and fans share the "<n> " prefix, so the field name is the only
// discriminator. PWM and Speed are the two fan fields the firmware emits;
// "PSU Fan Speed" carries no numeric prefix and so never collides.
const FAN_FIELDS = new Set(['PWM', 'Speed'])

const CHIP_KEY = /^(\d+)\.(\d+)\s+(.+)$/
const INDEXED_KEY = /^(\d+)\s+(.+)$/

/**
 * Split a raw `stats` object into its three levels.
 *
 * Board and fan counts come from the device-level `Board Count` / `Fan Count`
 * fields, never from which keys happen to be present — a truncated reply
 * (`id: 0`) drops trailing keys, and inferring the count from them would
 * silently report fewer boards than the miner has.
 *
 * @param {object} raw the STATS[0] object
 * @param {object} [opts]
 * @param {boolean} [opts.parseChips] build the per-chip array too. Off by
 *   default: a 1092-chip miner yields ~6500 chip keys with no telemetry
 *   value. Diagnostic tooling turns it on.
 * @returns {{device: object, boards: object[], fans: object[], chips: object[],
 *   declaredBoardCount: number|null, declaredFanCount: number|null,
 *   complete: boolean}}
 */
const group = (raw, opts = {}) => {
  const device = {}
  const boardMap = new Map()
  const fanMap = new Map()
  const chips = []

  for (const [key, value] of Object.entries(raw || {})) {
    const chipMatch = CHIP_KEY.exec(key)
    if (chipMatch) {
      if (!opts.parseChips) continue
      chips.push({
        board: Number(chipMatch[1]),
        index: Number(chipMatch[2]),
        field: chipMatch[3],
        value
      })
      continue
    }

    const indexed = INDEXED_KEY.exec(key)
    if (indexed) {
      const index = Number(indexed[1])
      const field = indexed[2]
      const target = FAN_FIELDS.has(field) ? fanMap : boardMap
      if (!target.has(index)) target.set(index, { index })
      target.get(index)[field] = value
      continue
    }

    device[key] = value
  }

  const declaredBoardCount = numberOrNull(device['Board Count'])
  const declaredFanCount = numberOrNull(device['Fan Count'])

  const boards = ordered(boardMap)
  const fans = ordered(fanMap)

  // A reply is complete when every declared board and fan actually arrived.
  const complete =
    (declaredBoardCount === null || boards.length === declaredBoardCount) &&
    (declaredFanCount === null || fans.length === declaredFanCount)

  return {
    device,
    boards,
    fans,
    chips: opts.parseChips ? foldChips(chips) : [],
    declaredBoardCount,
    declaredFanCount,
    complete
  }
}

const ordered = (map) => [...map.values()].sort((a, b) => a.index - b.index)

const numberOrNull = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Turn the flat [{board, index, field, value}] list into one object per chip.
const foldChips = (entries) => {
  const byChip = new Map()
  for (const { board, index, field, value } of entries) {
    const id = `${board}.${index}`
    if (!byChip.has(id)) byChip.set(id, { board, index })
    byChip.get(id)[field] = value
  }
  return [...byChip.values()].sort((a, b) => a.board - b.board || a.index - b.index)
}

module.exports = { group, FAN_FIELDS }
