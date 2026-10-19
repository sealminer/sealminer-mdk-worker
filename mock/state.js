'use strict'

// Mock miner state machine. Knows nothing about MDK — it models the
// SealMiner 4028 API's own reply shapes (SealMinerAPI_V0.5) so the worker's
// device client can be driven with no hardware.
//
// It is a state machine, not a canned-response server: `ascset workmode`
// changes what `stats` reports afterwards, `suspend` stops the fans and
// zeroes the hashrate. Command effects have to be observable or the tests
// prove nothing.
//
// Field names and values are calibrated against six real miners — one per
// product, air and water cooled across all three series — captured with
// scripts/dump-stats.js. Where the API document and the hardware disagree,
// the hardware wins and the difference is commented at the line.

const SERIES = ['a2', 'a3', 'a4']

// Display strings exactly as the firmware emits them (doc 3.7).
const MINING_MODE_LABEL = {
  low_power: 'Low Power',
  normal: 'Normal',
  high_performance: 'High Performance',
  ultra_low_power: 'Ultra Low Power',
  custom: 'Custom',
  smartboost: 'Smartboost'
}
const PM_STATE_LABEL = {
  idle: 'Idle',
  initializing: 'Initializing',
  running: 'Running',
  resuming: 'Resuming',
  resume_failed: 'Resume Failed',
  suspended: 'Suspended',
  suspending: 'Suspending',
  suspend_failed: 'Suspend Failed'
}
const TUNE_STATUS_LABEL = {
  tuning_idle: 'Tuning Idle',
  coarse_tuning: 'Coarse Tuning',
  coarse_tuning_done: 'Coarse Tuning Done',
  fine_tuning: 'Fine Tuning',
  fine_tuning_done: 'Fine Tuning Done'
}

// `workmode` values the firmware accepts, per series (doc 4.1.4). A2 is the
// only series with low_power.
const WORKMODES = {
  a2: ['low_power', 'normal', 'high_performance', 'sleep'],
  a3: ['normal', 'high_performance', 'sleep'],
  a4: ['normal', 'high_performance', 'sleep']
}

// Relative hashrate by mining mode, for plausible mock numbers only.
const MODE_FACTOR = {
  low_power: 0.7,
  normal: 1,
  high_performance: 1.15,
  ultra_low_power: 0.5,
  custom: 1,
  smartboost: 1.05
}

const COOLINGS = ['air', 'hydro']

// Per-PRODUCT hardware profile, each entry measured against one real miner.
//
// The unit here is a product, not a series, because cooling is NOT a property
// of the series: every series ships both an air-cooled and a water-cooled
// product. An earlier version of this file keyed the profile by series alone
// and hardcoded A2/A3 as air and A4 as water, which is not what the product
// line is — and it left the liquid-cooling path unreachable for A2 and A3,
// so the two `Liquid Cooling` behaviours could only ever be exercised on one
// series.
//
//   key        product          firmware when measured
//   a2-air     A2               2026040101
//   a2-hydro   A2 Pro Hydro     2026092000
//   a3-air     A3 Air           2026073000
//   a3-hydro   A3 Pro Hydro     2026091400
//   a4-air     A4 Pro Air       20260915FF
//   a4-hydro   A4 Ultra Hydro   2026083100
//
// Only the A2 reports a bare series in Model; the rest are product names,
// which is what lib/capabilities.js resolves by prefix.
//
// Two axes move together in the measurements and neither is safe to infer
// from the other:
//
//   cooling  hydro reports 'Liquid Cooling': true, emits NO 'Fan Count' key
//            and no fan keys at all, and carries two temperature sensors per
//            board rather than four.
//   product  chip and board counts, power limit and target temperature vary
//            per product, not per series — an A2 Pro Hydro carries 840 chips
//            on 2 boards against the A2's 459 on 3.
const PRODUCT_PROFILE = {
  'a2-air': {
    model: 'A2',
    asic: 'Seal02-V1',
    chipCount: 459,
    boardCount: 3,
    fanCount: 4,
    boardTempSensors: 4,
    powerLimit: 4300,
    ratedMhs: 230573624,
    targetCtrlTemp: 70,
    // Measured while healthy; a mock must not ship DEGRADED.
    temp: 70,
    psuModel: 'BTPSU04KSA-03.00',
    psuTempAmb: 34,
    ctrlBoard: 'taurus_air_v1.1',
    liquidCooling: false
  },
  'a2-hydro': {
    model: 'A2 Pro Hydro',
    // A later ASIC revision than the air A2's Seal02-V1, so a consumer must
    // not key anything off the ASIC string per series either.
    asic: 'Seal02-V2',
    chipCount: 840,
    boardCount: 2,
    fanCount: 0,
    boardTempSensors: 2,
    // This machine reported 7800 W, then 9500 W after a firmware upgrade
    // landed under us mid-session. The same physical miner changed its own
    // power limit, which is the strongest argument for the contract
    // declaring a family envelope rather than a per-device range.
    powerLimit: 9500,
    ratedMhs: 503950000,
    // Real hydro products report MHS(Rated) as 0 while still reporting a
    // sane MHS(Ideal). Reproduced below; see reportedRatedMhs.
    reportedRatedMhs: 0,
    targetCtrlTemp: 60,
    temp: 46,
    psuModel: 'BTPSU10KTL-02.00',
    psuTempAmb: 49,
    ctrlBoard: 'taurus_hydro_v1.1',
    liquidCooling: true
  },
  'a3-air': {
    model: 'A3 Air',
    asic: 'Seal03Y-V1',
    chipCount: 459,
    boardCount: 3,
    fanCount: 4,
    boardTempSensors: 4,
    powerLimit: 4300,
    ratedMhs: 272460000,
    targetCtrlTemp: 65,
    temp: 66,
    psuModel: 'BTPSU05KSA-01.00',
    psuTempAmb: 28,
    ctrlBoard: 'taurus_air_v1.2',
    liquidCooling: false
  },
  'a3-hydro': {
    model: 'A3 Pro Hydro',
    // Same ASIC as the air A3, unlike the A2 pair.
    asic: 'Seal03Y-V1',
    chipCount: 792,
    boardCount: 2,
    fanCount: 0,
    boardTempSensors: 2,
    powerLimit: 10000,
    ratedMhs: 755180000,
    targetCtrlTemp: 60,
    temp: 50,
    psuModel: 'BTPSU10KTL-02.00',
    psuTempAmb: 56,
    ctrlBoard: 'taurus_hydro_v1.2',
    liquidCooling: true
  },
  'a4-air': {
    model: 'A4 Pro Air',
    asic: 'Seal04-V1',
    // The same 459-chip, 3-board layout as the air A2, on an A4 ASIC.
    chipCount: 459,
    boardCount: 3,
    fanCount: 4,
    boardTempSensors: 4,
    powerLimit: 4300,
    ratedMhs: 244270000,
    reportedRatedMhs: 0,
    targetCtrlTemp: 70,
    temp: 70,
    // A BD- prefix where every other measured product uses BT-.
    psuModel: 'BDPSU5K8SA-01.00',
    psuTempAmb: 30,
    ctrlBoard: 'taurus_air_v1.2',
    liquidCooling: false
  },
  'a4-hydro': {
    model: 'A4 Ultra Hydro',
    asic: 'Seal04-V1',
    chipCount: 620,
    boardCount: 2,
    fanCount: 0,
    boardTempSensors: 2,
    // 2.5x the air products, which is why the contract's declared powerlimit
    // range has to be an envelope across the family.
    powerLimit: 10800,
    ratedMhs: 869860000,
    targetCtrlTemp: 60,
    temp: 67,
    psuModel: 'BTPSU10KTL-02.00',
    // Runs its PSU far hotter than any other measured product.
    psuTempAmb: 71,
    ctrlBoard: 'taurus_hydro_v1.2',
    liquidCooling: true
  }
}

// Which product `{ series }` alone resolves to: the one measured first for
// that series. This is a default for callers that do not care about cooling,
// not a claim that the series has one cooling type — pass `cooling` to pick.
const DEFAULT_COOLING = { a2: 'air', a3: 'air', a4: 'hydro' }

const DEFAULTS = {
  series: 'a2',
  // 10-digit YYYYMMDDNN build, the shape the firmware gates are expressed in.
  firmware: '2026060901',
  softwareVersion: '4.11.1-08730-g0c2d5ff4',
  bdminerVersion: '4.11.1',
  apiVersion: '3.7',
  legacyTypes: false,
  writesEnabled: true,
  // Real firmware emits NO per-chip keys, despite the document describing
  // them. Off by default so the mock matches hardware; tests that exercise
  // the documented shape turn it on explicitly.
  includeChips: false
}

const round2 = (v) => Math.round(v * 100) / 100

const createState = (opts = {}) => {
  const series = String(opts.series || DEFAULTS.series).toLowerCase()
  if (!SERIES.includes(series)) throw new Error(`mock: unknown series ${series}`)

  const cooling = String(opts.cooling || DEFAULT_COOLING[series]).toLowerCase()
  if (!COOLINGS.includes(cooling)) throw new Error(`mock: unknown cooling ${cooling}`)

  const product = `${series}-${cooling}`
  const profile = PRODUCT_PROFILE[product]
  if (!profile) throw new Error(`mock: no measured profile for ${product}`)

  // Explicit opts still win over the product profile, so a test can pin one
  // field — a hydro machine at an air product's temperature, say — without
  // inventing a whole profile for it.
  const cfg = { ...DEFAULTS, ...profile, ...opts, series, cooling, product }
  const boardCount = cfg.boardCount
  const chipsPerBoard = Math.floor(cfg.chipCount / boardCount)

  const state = {
    cfg,
    series,
    model: cfg.model,
    firmware: String(cfg.firmware),
    miningMode: cfg.miningMode || 'normal',
    pmState: 'running',
    tuneStatus: 'fine_tuning_done',
    powerLimit: cfg.powerLimit,
    targetCtrlTemp: cfg.targetCtrlTemp,
    temp: cfg.temp,
    systemUptime: 331986,
    startupTimes: 56,
    freq: 381,
    chipVoltage: 308,
    stratumDisconnect: false,
    errorCode: '',
    errorChip: '',
    timezone: 'UTC',
    hostname: 'sealminer',
    network: { dhcp: '1' },
    fastRaiseFreq: false,
    preheat: null,
    idleFanTimer: null,
    stratumDisconnectTimeout: 120,
    // Mining settings written on firmware that does not auto-restart wait
    // here until a bdminer restart applies them.
    pending: {},
    faults: new Set(opts.faults || []),
    boards: Array.from({ length: boardCount }, (_, i) => ({
      index: i,
      sn: `S00000000000000${i + 1}`,
      marking: 'A040CFBK04000',
      online: true,
      chipCount: chipsPerBoard,
      badChipCount: 0,
      freq: 380,
      temp: 57 + i,
      lowHash: false,
      mw: 5999,
      hw: 0
    })),
    fans: Array.from({ length: cfg.fanCount }, (_, i) => ({
      index: i,
      pwm: 148,
      speed: 4500 + i * 30
    })),
    pools: [{
      index: 0,
      url: 'stratum+tcp://stratum.example.com:3333',
      user: 'sealminer.001',
      status: 'Alive',
      priority: 0,
      stratumActive: true,
      accepted: 893,
      rejected: 7
    }]
  }

  applyFaults(state)
  return state
}

const applyFaults = (state) => {
  const f = state.faults
  if (f.has('fan_stopped')) state.fans[0].speed = 0
  if (f.has('board_offline')) {
    state.boards[0].online = false
    state.boards[0].lowHash = true
  }
  if (f.has('bad_chip')) state.boards[0].badChipCount = Math.max(1, Math.floor(state.boards[0].chipCount * 0.1))
  if (f.has('board_low_hash')) state.boards[0].lowHash = true
  if (f.has('overheat')) state.temp = state.targetCtrlTemp + 10
  if (f.has('device_error')) state.errorCode = '0x00000101'
  if (f.has('stratum_disconnect')) {
    state.stratumDisconnect = true
    state.pools[0].stratumActive = false
    state.pools[0].status = 'Dead'
  }
}

/** Whole-miner hashrate in MH/s for the current state. */
const currentMhs = (state) => {
  if (state.pmState === 'suspended' || state.miningMode === 'sleep') return 0
  const factor = MODE_FACTOR[state.miningMode] ?? 1
  const online = state.boards.filter((b) => b.online).length || 0
  const share = state.boards.length ? online / state.boards.length : 0
  return state.cfg.ratedMhs * factor * share
}

const idealMhs = (state) => state.cfg.ratedMhs * (MODE_FACTOR[state.miningMode] ?? 1)

const bool = (state, value) => (state.cfg.legacyTypes ? (value ? 1 : 0) : value)

const enumValue = (state, token, labels) => {
  if (state.cfg.legacyTypes) {
    // Old firmware sent integers. The document does not specify the encoding,
    // so the mock emits the index — which the parser must treat as unknown
    // (null) rather than guess, and the tests assert exactly that.
    return Object.keys(labels).indexOf(token)
  }
  return labels[token] ?? ''
}

const hashWindows = (mhs, prefix, out) => {
  for (const label of ['Sample', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '2h', 'Avg', 'Avg2']) {
    out[`${prefix}(${label})`] = round2(mhs)
  }
}

const rateWindows = (value, prefix, out) => {
  for (const label of ['30s', '1m', '2m', '5m', '15m', '30m', '1h', '2h', 'Avg']) {
    out[`${prefix}(${label})`] = round2(value)
  }
}

/** Build the STATS[0] payload: a flat object, exactly as the firmware sends. */
const buildStats = (state) => {
  const mhs = currentMhs(state)
  const ideal = idealMhs(state)
  const ths = mhs / 1e6
  const powerW = state.pmState === 'suspended' ? 0 : state.powerLimit
  const out = {
    STATS: 0,
    ID: `${state.model}0`,
    Elapsed: state.systemUptime,
    Calls: 0,
    Wait: 0,
    Max: 0,
    Min: 99999999,
    Model: state.model,
    ASIC: state.cfg.asic,
    Firmware: state.firmware,
    'Software Version': state.cfg.softwareVersion,
    IP: '127.0.0.1',
    MAC: '00:00:5e:00:53:01',
    // The control board string encodes the cooling type and a board
    // revision: measured taurus_air_v1.1 on the A2, taurus_hydro_v1.1 on the
    // A2 Pro Hydro, and v1.2 of each on the A3 and A4 products. It was
    // hardcoded to the air A2's board for every product, so a hydro mock
    // reported an air control board.
    'Ctrl Board': state.cfg.ctrlBoard,
    'Ctrl Board SN': 'S000000000000000',
    'Public Key': 'publ_key_user1.key',
    Debug: bool(state, true),
    'PM State': enumValue(state, state.pmState, PM_STATE_LABEL),
    'BIN Version': 0,
    'BIN Number': 61,
    'Chip Count': state.boards.reduce((sum, b) => sum + b.chipCount, 0),
    'Bad Chip Count': state.boards.reduce((sum, b) => sum + b.badChipCount, 0),
    'Mining Mode': enumValue(state, state.miningMode, MINING_MODE_LABEL),
    Temp: state.temp,
    'Error Chip': state.errorChip,
    'Stratum Disconnect': bool(state, state.stratumDisconnect),
    'Error Code': state.errorCode,
    'Boot Time': 126.725616,
    'Boot Temp': 34,
    'Coarse Tune Time': 1639.452293,
    'Fine Tune Time': 3262.95912,
    'Tune Status': enumValue(state, state.tuneStatus, TUNE_STATUS_LABEL),
    'Tune Time': 4922.877731,
    'Raise Freq Done': bool(state, true),
    'Raise Freq Done Reason': 'Power Efficiency Limit',
    'Raise Freq Time': 325.874367,
    'Fast Raise Freq': bool(state, state.fastRaiseFreq),
    'Custom Power Ratio': 27,
    'Liquid Cooling': bool(state, state.cfg.liquidCooling),
    'Boot Count': state.startupTimes,
    'System Uptime': state.systemUptime,
    'Target Ctrl Temp': state.targetCtrlTemp,
    // Two measured products (A2 Pro Hydro, A4 Pro Air) report MHS(Rated) as
    // 0 while still reporting a sane MHS(Ideal), so the field is not a
    // reliable rating. `ratedMhs` stays the mock's internal hashrate basis —
    // zeroing that would zero the simulation — and only the reported value
    // is overridden, which is what a consumer actually sees.
    'MHS(Rated)': state.cfg.reportedRatedMhs ?? state.cfg.ratedMhs,
    'Hashrate Boost Ratio': 0,
    'Profit Boost Ratio': 0,
    'Power Limit': state.powerLimit,
    'Total Energy Consumption': 9583.428637,
    'Pools Locked': bool(state, true),
    'MHS(Ideal)': round2(ideal),
    Freq: state.freq
  }

  hashWindows(mhs, 'MHS', out)
  rateWindows(ideal > 0 ? (mhs / ideal) * 100 : 0, 'PR', out)

  Object.assign(out, {
    'PSU Model': state.cfg.psuModel,
    'PSU Firmware': '222121',
    'PSU SN': '3C000000000',
    'PSU Input Voltage': 233.35,
    'PSU Output Voltage': 13.665,
    'PSU Output Current': 274.3,
    'PSU Input Power': powerW,
    'PSU Output Power': Math.round(powerW * 0.936),
    'PSU Fan Speed': state.pmState === 'suspended' ? 0 : 7500,
    'PSU Temp AMB': state.cfg.psuTempAmb,
    // A real A2 reports no hot-spot temperature at all, so the field is
    // present only when the fault is injected — that keeps the
    // alert.psu_overheat path tested without pretending hardware has it.
    ...(state.faults.has('psu_overheat') ? { 'PSU Temp HOT': 85 } : {}),
    'PSU Efficiency': 0.913741,
    // A real A2 reports a non-zero error word while suspended, because the
    // output has been deliberately shut down. Modelled so the health rule
    // that must not alert on it stays tested.
    'PSU Error': state.faults.has('psu_error')
      ? '0x00000080'
      : (state.pmState === 'suspended' ? '0x00000040' : '0x00000000'),
    'Chip Voltage': state.chipVoltage
  })

  rateWindows(ths > 0 ? powerW / ths : 0, 'W/T', out)

  // A liquid-cooled miner emits neither 'Fan Count' nor any fan keys. That
  // is byte-identical to a miner whose every fan died, which is exactly why
  // health has to read 'Liquid Cooling' rather than infer cooling from the
  // absence of fans.
  if (!state.cfg.liquidCooling) {
    out['Fan Count'] = state.fans.length
  }
  for (const fan of state.cfg.liquidCooling ? [] : state.fans) {
    out[`${fan.index} PWM`] = state.pmState === 'suspended' ? 0 : fan.pwm
    out[`${fan.index} Speed`] = state.pmState === 'suspended' ? 0 : fan.speed
  }

  out['Board Count'] = state.boards.length
  const perBoardMhs = state.boards.length ? mhs / state.boards.length : 0
  for (const b of state.boards) {
    const boardMhs = b.online ? perBoardMhs : 0
    const p = b.index
    out[`${p} SN`] = b.sn
    out[`${p} Marking`] = b.marking
    out[`${p} Online`] = bool(state, b.online)
    out[`${p} Chip Count`] = b.chipCount
    out[`${p} Bad Chip Count`] = b.badChipCount
    out[`${p} Bad Chip Ratio`] = b.chipCount ? round2(b.badChipCount / b.chipCount) : 0
    out[`${p} Tune Status`] = enumValue(state, state.tuneStatus, TUNE_STATUS_LABEL)
    out[`${p} Total MH`] = 26256267294550
    out[`${p} MHS(Ideal)`] = round2(ideal / state.boards.length)
    out[`${p} Freq`] = b.freq
    hashWindows(boardMhs, `${p} MHS`, out)
    rateWindows(ideal > 0 ? (boardMhs / (ideal / state.boards.length)) * 100 : 0, `${p} PR`, out)
    out[`${p} Low Hash`] = bool(state, b.lowHash)
    // A real A2 reports four sensors per board as "<n> Temp 0".."<n> Temp 3";
    // the document shows a single "<n> Temp". Emit the real shape, with the
    // board's nominal temperature as the hottest sensor.
    for (let sensor = 0; sensor < state.cfg.boardTempSensors; sensor++) {
      out[`${p} Temp ${sensor}`] = b.temp - (state.cfg.boardTempSensors - 1 - sensor) * 3
    }
    out[`${p} MW`] = b.mw
    out[`${p} HW`] = b.hw
    out[`${p} ULVT PMOS(Avg)`] = 18025
    out[`${p} ULVT NMOS(Avg)`] = 20218
    out[`${p} ELVT PMOS(Avg)`] = 6998
    out[`${p} ELVT NMOS(Avg)`] = 7181
    out[`${p} ULVTLL PMOS(Avg)`] = 39870
    out[`${p} ULVTLL NMOS(Avg)`] = 45824

    if (state.cfg.includeChips) {
      for (let c = 0; c < b.chipCount; c++) {
        const key = `${p}.${c}`
        out[`${key} Bad`] = 0
        out[`${key} Disabled`] = 0
        out[`${key} Freq`] = b.freq - 26
        out[`${key} MW`] = 0
        out[`${key} HW`] = 0
        out[`${key} PR`] = 99.1
      }
    }
  }

  return out
}

/** Build the SUMMARY[0] payload (doc 3.2). */
const buildSummary = (state) => {
  const mhs = currentMhs(state)
  const accepted = state.pools[0]?.accepted ?? 0
  const rejected = state.pools[0]?.rejected ?? 0
  return {
    Elapsed: state.systemUptime,
    'MHS av': round2(mhs),
    'MHS 5s': round2(mhs),
    'MHS 1m': round2(mhs),
    'MHS 5m': round2(mhs),
    'MHS 15m': round2(mhs),
    'Found Blocks': 0,
    Getworks: 762,
    Accepted: accepted,
    Rejected: rejected,
    'Hardware Errors': 1,
    Utility: 3.46,
    Discarded: 9037,
    Stale: 0,
    'Get Failures': 0,
    'Local Work': 942141,
    'Remote Failures': 0,
    'Network Blocks': 62,
    'Total MH': 3203193072389,
    'Work Utility': 2889696.06,
    'Difficulty Accepted': 570927998.99682081,
    'Difficulty Rejected': 4012762.087458,
    'Difficulty Stale': 0,
    'Best Share': 524276597,
    'Device Hardware%': 0,
    'Device Rejected%': accepted + rejected ? round2((rejected / (accepted + rejected)) * 100) : 0,
    'Pool Rejected%': accepted + rejected ? round2((rejected / (accepted + rejected)) * 100) : 0,
    'Pool Stale%': 0,
    'Last getwork': 1693206129
  }
}

/** Build the POOLS payload (doc 3.5.1). */
const buildPools = (state) =>
  state.pools.map((p) => ({
    POOL: p.index,
    URL: p.url,
    Status: p.status,
    Priority: p.priority,
    Quota: 1,
    'Long Poll': 'N',
    Getworks: 879,
    Accepted: p.accepted,
    Rejected: p.rejected,
    Works: 1085882,
    Discarded: 10554,
    Stale: 0,
    'Get Failures': 0,
    'Remote Failures': 0,
    User: p.user,
    'Last Share Time': 1693208639,
    'Diff1 Shares': 899861008,
    'Proxy Type': '',
    Proxy: '',
    'Difficulty Accepted': 693583365.7868737,
    'Difficulty Rejected': 4710633.754842,
    'Difficulty Stale': 0,
    'Last Share Difficulty': 1395743.334768,
    'Work Difficulty': 1395743.334768,
    'Has Stratum': true,
    'Stratum Active': p.stratumActive,
    'Stratum URL': p.stratumActive ? p.url.replace(/^stratum\+tcp:\/\//, '').split(':')[0] : '',
    'Stratum Difficulty': 1395743.334768,
    'Has Vmask': true,
    'Has GBT': false,
    'Best Share': 934535583,
    'Pool Rejected%': 0.6746,
    'Pool Stale%': 0,
    'Bad Work': 56,
    'Current Block Height': 805141,
    'Current Block Version': 536870912
  }))

const buildVersion = (state) => ({
  BDMiner: state.cfg.bdminerVersion,
  API: state.cfg.apiVersion
})

const buildConfig = (state) => ({
  'ASC Count': 1,
  'PGA Count': 0,
  'Pool Count': state.pools.length,
  Strategy: 'Failover',
  'Log Interval': 5,
  'Device Code': '',
  OS: 'Linux',
  Hotplug: 'None'
})

const buildDevDetails = (state) => ({
  DEVDETAILS: 0,
  Name: state.model,
  ID: 0,
  Driver: 'Sealminer',
  Kernel: '',
  Model: state.model,
  'Device Path': ''
})

const buildDevs = (state) => {
  const mhs = currentMhs(state)
  return [{
    ASC: 0,
    Name: state.model,
    ID: 0,
    Enabled: 'Y',
    Status: state.pmState === 'running' ? 'Alive' : 'Sick',
    // The firmware reports 0.00 here; real temperature lives in stats.
    Temperature: 0,
    'MHS av': round2(mhs),
    'MHS 5s': round2(mhs),
    'MHS 1m': round2(mhs),
    'MHS 5m': round2(mhs),
    'MHS 15m': round2(mhs),
    Accepted: state.pools[0]?.accepted ?? 0,
    Rejected: state.pools[0]?.rejected ?? 0,
    'Hardware Errors': 1,
    Utility: 3.49,
    'Device Elapsed': state.systemUptime
  }]
}

const buildCoin = () => ({
  'Hash Method': 'sha256',
  'Current Block Time': 1693217334.313215,
  CurrentBlockHash: '0000000000000000000094ce4e22be9afef6741303a72bc319409c004de39251',
  LP: true,
  'Network Difficulty': 55621444139429.57
})

module.exports = {
  createState,
  buildStats,
  buildSummary,
  buildPools,
  buildVersion,
  buildConfig,
  buildDevDetails,
  buildDevs,
  buildCoin,
  currentMhs,
  WORKMODES,
  SERIES,
  COOLINGS,
  PRODUCT_PROFILE,
  DEFAULT_COOLING,
  MINING_MODE_LABEL,
  PM_STATE_LABEL,
  TUNE_STATUS_LABEL,
  DEFAULTS
}
