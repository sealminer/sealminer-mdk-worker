'use strict'

const { group } = require('./flat-keys')
const n = require('./normalize')

// The document lists Sample/1m/2m/5m/15m/30m/1h/2h/Avg. Real firmware also
// emits a 30s window and a second average (Avg2); both are included so the
// values are not discarded, and absent windows normalize to null.
const HASH_WINDOWS = [
  ['sample', 'Sample'], ['s30', '30s'], ['m1', '1m'], ['m2', '2m'], ['m5', '5m'],
  ['m15', '15m'], ['m30', '30m'], ['h1', '1h'], ['h2', '2h'], ['avg', 'Avg'], ['avg2', 'Avg2']
]
const RATE_WINDOWS = HASH_WINDOWS.filter(([key]) => key !== 'sample' && key !== 'avg2')

const hashSeries = (src, prefix) => {
  const out = {}
  for (const [key, label] of HASH_WINDOWS) out[key] = n.mhsToThs(src[`${prefix}(${label})`])
  return out
}

const rateSeries = (src, prefix) => {
  const out = {}
  for (const [key, label] of RATE_WINDOWS) out[key] = n.toNumber(src[`${prefix}(${label})`])
  return out
}

const psu = (d) => ({
  model: n.toString(d['PSU Model']),
  firmware: n.toString(d['PSU Firmware']),
  // Observed on real hardware, absent from the document.
  sn: n.toString(d['PSU SN']),
  inputVoltage: n.toNumber(d['PSU Input Voltage']),
  outputVoltage: n.toNumber(d['PSU Output Voltage']),
  outputCurrent: n.toNumber(d['PSU Output Current']),
  inputPower: n.toNumber(d['PSU Input Power']),
  outputPower: n.toNumber(d['PSU Output Power']),
  fanSpeed: n.toNumber(d['PSU Fan Speed']),
  tempAmb: n.toNumber(d['PSU Temp AMB']),
  tempHot: n.toNumber(d['PSU Temp HOT']),
  efficiency: n.toNumber(d['PSU Efficiency']),
  // Deliberately NOT named `error`: WorkerRuntimeV2 signals a failed
  // telemetry channel by returning `{ error: ... }` under that channel's key,
  // so a psu_info object carrying an `error` field makes every consumer that
  // checks `value.error` read a healthy PSU as a broken channel.
  errorWord: n.toString(d['PSU Error'])
})

// Per-board temperature sensors. The document shows a single "<n> Temp";
// a real A2 reports four sensors as "<n> Temp 0".."<n> Temp 3". Collect
// whatever is present, and publish the hottest as the board's temperature —
// averaging would hide a single hot spot, which is the thing worth catching.
const boardTemps = (b) => {
  const temps = Object.keys(b)
    .filter((key) => /^Temp(\s+\d+)?$/.test(key))
    .sort()
    .map((key) => n.toNumber(b[key]))
    .filter((value) => value !== null)
  return temps
}

const board = (b) => {
  const temps = boardTemps(b)
  return {
    index: b.index,
    sn: n.toString(b.SN),
    // Observed on real hardware, absent from the document.
    marking: n.toString(b.Marking),
    online: n.toBoolean(b.Online),
    chipCount: n.toNumber(b['Chip Count']),
    badChipCount: n.toNumber(b['Bad Chip Count']),
    badChipRatio: n.toNumber(b['Bad Chip Ratio']),
    tuneStatus: n.tuneStatus(b['Tune Status']),
    freq: n.toNumber(b.Freq),
    temp: temps.length ? Math.max(...temps) : null,
    temps,
    lowHash: n.toBoolean(b['Low Hash']),
    mw: n.toNumber(b.MW),
    hw: n.toNumber(b.HW),
    totalMh: n.toNumber(b['Total MH']),
    hashrateIdeal: n.mhsToThs(b['MHS(Ideal)']),
    hashrate: hashSeries(b, 'MHS'),
    pr: rateSeries(b, 'PR'),
    // Voltage domains vary by ASIC generation: the document names ULVT and
    // LVT, a Seal02-V1 board reports ULVT, ELVT and ULVTLL. Absent domains
    // are null rather than omitted, so the shape stays stable.
    voltage: {
      ulvtPmos: n.toNumber(b['ULVT PMOS(Avg)']),
      ulvtNmos: n.toNumber(b['ULVT NMOS(Avg)']),
      lvtPmos: n.toNumber(b['LVT PMOS(Avg)']),
      lvtNmos: n.toNumber(b['LVT NMOS(Avg)']),
      elvtPmos: n.toNumber(b['ELVT PMOS(Avg)']),
      elvtNmos: n.toNumber(b['ELVT NMOS(Avg)']),
      ulvtllPmos: n.toNumber(b['ULVTLL PMOS(Avg)']),
      ulvtllNmos: n.toNumber(b['ULVTLL NMOS(Avg)'])
    }
  }
}

const fan = (f) => ({
  index: f.index,
  pwm: n.toNumber(f.PWM),
  speed: n.toNumber(f.Speed)
})

/**
 * Normalize a raw `stats` reply.
 *
 * @param {object} raw STATS[0]
 * @param {object} [opts]
 * @param {boolean} [opts.truncated] the reply carried `id: 0`
 * @param {boolean} [opts.parseChips] also normalize per-chip entries
 * @returns {object} normalized snapshot. Every absent or unparseable field is
 *   null — never 0, so consumers can tell "no data" from "zero".
 */
const parseStats = (raw, opts = {}) => {
  const grouped = group(raw, { parseChips: opts.parseChips })
  const d = grouped.device

  return {
    truncated: Boolean(opts.truncated),
    // Declared counts vs. what actually arrived. When these disagree the
    // reply lost trailing keys and board-level channels must report null.
    boardsComplete: grouped.complete,
    declaredBoardCount: grouped.declaredBoardCount,
    declaredFanCount: grouped.declaredFanCount,

    identity: {
      model: n.toString(d.Model),
      asic: n.toString(d.ASIC),
      mac: n.toString(d.MAC),
      // Observed on real hardware, absent from the document.
      ip: n.toString(d.IP),
      ctrlBoard: n.toString(d['Ctrl Board']),
      ctrlBoardSn: n.toString(d['Ctrl Board SN'])
    },

    firmware: {
      firmware: n.toString(d.Firmware),
      softwareVersion: n.toString(d['Software Version']),
      binVersion: n.toNumber(d['BIN Version']),
      binNumber: n.toNumber(d['BIN Number']),
      liquidCooling: n.toBoolean(d['Liquid Cooling'])
    },

    // Settings the firmware reports back. `Power Limit` and `Fast Raise Freq`
    // are absent from the document but present on real hardware, and they
    // matter disproportionately: they are the only readbacks for two of the
    // write commands, which turns "assert it worked" into "verify it worked".
    settings: {
      powerLimit: n.toNumber(d['Power Limit']),
      fastRaiseFreq: n.toBoolean(d['Fast Raise Freq']),
      poolsLocked: n.toBoolean(d['Pools Locked'])
    },

    state: {
      pmState: n.pmState(d['PM State']),
      miningMode: n.miningMode(d['Mining Mode']),
      tuneStatus: n.tuneStatus(d['Tune Status']),
      stratumDisconnect: n.toBoolean(d['Stratum Disconnect']),
      raiseFreqDone: n.toBoolean(d['Raise Freq Done']),
      debug: n.toBoolean(d.Debug),
      errorCode: n.toString(d['Error Code']),
      errorChip: n.toString(d['Error Chip']),
      systemUptime: n.toNumber(d['System Uptime']),
      elapsed: n.toNumber(d.Elapsed),
      // The document calls this Startup Times; real firmware calls it Boot
      // Count. Accept either.
      startupTimes: n.toNumber(d['Startup Times'] ?? d['Boot Count']),
      totalEnergyKwh: n.toNumber(d['Total Energy Consumption'])
    },

    thermal: {
      temp: n.toNumber(d.Temp),
      targetCtrlTemp: n.toNumber(d['Target Ctrl Temp']),
      bootTemp: n.toNumber(d['Boot Temp']),
      // Undocumented, present on all six products measured, and false or
      // true on every series — an A2 Pro Hydro and A3 Pro Hydro report true
      // while an A4 Pro Air reports false. It is the only reliable way
      // to tell a water-cooled machine from one whose fans have all failed —
      // a hydro miner reports no `Fan Count` and an empty fan list, which is
      // indistinguishable from total fan loss without this flag.
      liquidCooling: n.toBoolean(d['Liquid Cooling'])
    },

    tuning: {
      coarseTuneTime: n.toNumber(d['Coarse Tune Time']),
      fineTuneTime: n.toNumber(d['Fine Tune Time']),
      tuneTime: n.toNumber(d['Tune Time']),
      raiseFreqTime: n.toNumber(d['Raise Freq Time']),
      raiseFreqDoneReason: n.toString(d['Raise Freq Done Reason']),
      customPowerRatio: n.toNumber(d['Custom Power Ratio']),
      hashrateBoostRatio: n.toNumber(d['Hashrate Boost Ratio']),
      profitBoostRatio: n.toNumber(d['Profit Boost Ratio'])
    },

    chip: {
      count: n.toNumber(d['Chip Count']),
      badCount: n.toNumber(d['Bad Chip Count']),
      freq: n.toNumber(d.Freq),
      // The document spells this with a lowercase v; a real A2 uses an
      // uppercase V. Accept both.
      voltage: n.toNumber(d['Chip Voltage'] ?? d['Chip voltage'])
    },

    hashrate: {
      rated: n.mhsToThs(d['MHS(Rated)']),
      ideal: n.mhsToThs(d['MHS(Ideal)']),
      ...hashSeries(d, 'MHS')
    },
    pr: rateSeries(d, 'PR'),
    // W/T(*) is already W/TH in the firmware's own units.
    wattsPerTh: rateSeries(d, 'W/T'),

    psu: psu(d),
    boards: grouped.boards.map(board),
    fans: grouped.fans.map(fan),
    chips: grouped.chips
  }
}

module.exports = { parseStats }
