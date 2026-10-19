#!/usr/bin/env node
'use strict'

// Contract self-check. Runs with no MDK checkout and no hardware, so it can
// gate every commit.
//
// Beyond the published schema's own rules it enforces the three things that
// have actually bitten MDK worker authors:
//   1. every declared handler file exists and exports a function
//   2. every number parameter declares min and max — Kernel enforces bounds
//      only when they are declared and the firmware does not range-check at
//      all, so an undeclared bound leaves a physical setpoint unguarded
//   3. every ERR_* code the code can throw is documented in the contract,
//      and every documented code is one the code can actually throw

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CONTRACT = path.join(ROOT, 'mdk-contract.json')

const errors = []
const warnings = []
const fail = (msg) => errors.push(msg)
const warn = (msg) => warnings.push(msg)

// --- load ------------------------------------------------------------------

let contract
try {
  contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'))
} catch (err) {
  console.error(`ERR_CONTRACT_INVALID_JSON: ${err.message}`)
  process.exit(1)
}

// --- MDK's own published schema --------------------------------------------

// Where MDK keeps this schema has moved. Up to v0.8.0 there were two copies
// and they were not identical, the mdk-skill one being the stricter; v0.10.0
// removed that duplicate and ships only the mdk-worker copy. Both paths are
// listed and whichever exist are checked, so this validates against 0.8.0 and
// 0.10.0 alike and will not start warning the next time upstream moves it.
//
// A missing MDK checkout is a warning, not a failure — this script has to keep
// working standalone so it can gate every commit.
const SCHEMA_PATHS = [
  ['mdk-skill', 'packages/mdk-skill/src/mdk-contract.schema.json'],
  ['mdk-worker', 'backend/core/mdk-worker/mdk-contract.schema.json']
]
const MDK_REPO = process.env.MDK_REPO
  ? path.resolve(process.env.MDK_REPO)
  : path.join(ROOT, '..', 'mdk')

const schemaResults = []
{
  let Ajv
  try {
    Ajv = require('ajv')
  } catch {
    warn('ajv is not installed — MDK\'s published schema was not checked (npm i)')
  }

  const found = SCHEMA_PATHS
    .map(([label, rel]) => [label, path.join(MDK_REPO, rel)])
    .filter(([, file]) => fs.existsSync(file))

  if (Ajv && found.length === 0) {
    warn(`no mdk-contract.schema.json under ${MDK_REPO} — set MDK_REPO to check the published schema`)
  }

  for (const [label, file] of (Ajv ? found : [])) {
    try {
      const schema = JSON.parse(fs.readFileSync(file, 'utf8'))
      // The schema declares draft 2020-12; this ajv build resolves drafts by
      // its own default meta-schema, so the declaration is dropped rather
      // than left to fail resolution.
      delete schema.$schema
      const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)
      if (validate(contract)) {
        schemaResults.push(`${label}: valid`)
      } else {
        schemaResults.push(`${label}: ${validate.errors.length} error(s)`)
        for (const e of validate.errors) {
          fail(`schema(${label}) ${e.instancePath || '(root)'} ${e.message}`)
        }
      }
    } catch (err) {
      warn(`schema(${label}) could not be applied: ${err.message}`)
    }
  }
}

// --- metadata --------------------------------------------------------------

const REQUIRED_METADATA = ['provider', 'deviceFamily', 'brand', 'modelsSupported', 'overview']
const metadata = contract.metadata
if (!metadata || typeof metadata !== 'object') {
  fail('ERR_PLUGIN_CONTRACT_METADATA_MISSING')
} else {
  for (const key of REQUIRED_METADATA) {
    if (metadata[key] === undefined) fail(`metadata.${key} is required`)
  }
  if (!Array.isArray(metadata.modelsSupported) || metadata.modelsSupported.length === 0) {
    fail('metadata.modelsSupported must be a non-empty array')
  }
  if (typeof metadata.overview === 'string' && metadata.overview.length < 80) {
    warn('metadata.overview is short — it is the primary semantic context an AI operator gets')
  }
}

// --- capabilities ----------------------------------------------------------

const caps = contract.capabilities
if (!caps || typeof caps !== 'object') {
  fail('ERR_PLUGIN_CONTRACT_CAPABILITIES_MISSING')
  report()
}

for (const key of ['telemetry', 'commands', 'health', 'errors']) {
  if (caps[key] === undefined) fail(`capabilities.${key} is required`)
}

const TELEMETRY_TYPES = new Set(['number', 'string', 'boolean', 'object', 'array'])
const PARAM_TYPES = new Set(['number', 'string', 'boolean', 'object'])

const seen = { telemetry: new Set(), commands: new Set() }

const checkHandler = (kindKey, name, handler) => {
  if (!handler) {
    fail(`ERR_PLUGIN_HANDLER_MISSING: ${kindKey}.${name}`)
    return
  }
  const resolved = path.join(ROOT, handler)
  if (!fs.existsSync(resolved)) {
    fail(`ERR_PLUGIN_HANDLER_NOT_FOUND: ${kindKey}.${name}: ${handler}`)
    return
  }
  // The runtime only require()s handlers per device, so a non-function export
  // would not surface until a device opens. Catch it here instead.
  try {
    const mod = require(resolved)
    if (typeof mod !== 'function') {
      fail(`ERR_PLUGIN_HANDLER_NOT_FUNCTION: ${kindKey}.${name}: ${handler}`)
    }
  } catch (err) {
    // A handler that reads the ambient device module cannot load outside the
    // runtime; that is expected and is covered by the smoke test instead.
    if (!/@tetherto\/mdk-worker\/device/.test(err.message)) {
      fail(`ERR_PLUGIN_HANDLER_LOAD_FAILED: ${kindKey}.${name}: ${err.message}`)
    }
  }
}

// telemetry
if (Array.isArray(caps.telemetry)) {
  for (const entry of caps.telemetry) {
    const name = entry?.name
    if (!name) { fail('ERR_PLUGIN_ENTRY_NAME_MISSING: telemetry'); continue }
    if (seen.telemetry.has(name)) fail(`ERR_PLUGIN_DUPLICATE_NAME: telemetry.${name}`)
    seen.telemetry.add(name)
    if (!TELEMETRY_TYPES.has(entry.type)) fail(`telemetry.${name}.type must be one of ${[...TELEMETRY_TYPES].join('|')}`)
    if (!entry.description) fail(`telemetry.${name}.description is required`)
    else if (entry.description.length < 40) warn(`telemetry.${name}.description is a label, not a semantic boundary`)
    checkHandler('telemetry', name, entry.handler)
  }
} else {
  fail('ERR_PLUGIN_SECTION_NOT_ARRAY: telemetry')
}

// hashrate_rt is how MDK's own reference site classifies a device as a miner
// (examples/mvp-site adaptContractMiners). Losing it silently drops every
// SealMiner off the fleet overview.
if (!seen.telemetry.has('hashrate_rt')) {
  fail('telemetry must declare hashrate_rt: MDK sites use it to classify a device as a miner')
}

// commands
if (Array.isArray(caps.commands)) {
  for (const entry of caps.commands) {
    const name = entry?.name
    if (!name) { fail('ERR_PLUGIN_ENTRY_NAME_MISSING: commands'); continue }
    if (seen.commands.has(name)) fail(`ERR_PLUGIN_DUPLICATE_NAME: commands.${name}`)
    seen.commands.add(name)
    if (!entry.description) fail(`commands.${name}.description is required`)
    if (!Array.isArray(entry.params)) fail(`commands.${name}.params must be an array`)
    checkHandler('commands', name, entry.handler)

    for (const param of entry.params || []) {
      const label = `commands.${name}.params.${param?.name}`
      if (!param?.name) { fail(`${label}: name is required`); continue }
      if (!PARAM_TYPES.has(param.type)) fail(`${label}: type must be one of ${[...PARAM_TYPES].join('|')}`)
      if (param.type === 'number') {
        // MDK's build-a-worker guide requires it in three places, including
        // its conformance checklist: the handler "must reject missing,
        // wrong-type, out-of-range, or disallowed values". A declared bound is
        // also the only validation Kernel performs pre-dispatch.
        //
        // The firmware does NOT range-check — it answers 'ASC 0 set OK' to
        // values it silently ignores — so the declared range is this layer's
        // own guard and nothing else enforces it. That makes the direction of
        // error one-sided: too wide only catches typos, while too narrow
        // refuses a legitimate setting, which has happened twice against real
        // hardware. Declare generously; narrowing one later is a breaking
        // change for a caller that reads a value and writes it back.
        if (param.min === undefined || param.max === undefined) {
          fail(`${label}: a number parameter must declare min and max — Kernel enforces bounds only when declared, and the firmware does not range-check at all`)
        } else if (param.min > param.max) {
          fail(`${label}: min ${param.min} > max ${param.max}`)
        }
      }
      if (param.enum !== undefined && (!Array.isArray(param.enum) || param.enum.length === 0)) {
        fail(`${label}: enum must be a non-empty array`)
      }
    }
    // The constraints text is what an operator and an integrator actually
    // read; a declared bound they cannot see is a bound they will not respect.
    // These three rules exist because the prose and the declarations drifted
    // apart once already: ranges were removed, then restored two commits
    // later, and four commands were left telling the reader NO RANGE IS
    // DECLARED OR ENFORCED while declaring one. Saying the opposite of the
    // contract is worse than saying nothing.
    const numbers = (entry.params || []).filter((p) => p.type === 'number' && p.min !== undefined)
    const prose = entry.constraints || ''
    if (numbers.length > 0) {
      if (/NO RANGE IS (?:DECLARED|ENFORCED)/i.test(prose)) {
        fail(`commands.${name}.constraints claims no range is declared, but ${numbers.map((p) => p.name).join(', ')} declare one`)
      }
      if (!/DECLARED RANGES?\b/i.test(prose)) {
        fail(`commands.${name}.constraints must state its declared range — ${numbers.map((p) => `${p.name} ${p.min}..${p.max}`).join(', ')}`)
      }
      // Any range the prose spells out must be the range the contract declares.
      // Only an explicit "<param> <min>-<max>" or a single-parameter command's
      // "DECLARED RANGE <min>-<max>" is checked, so prose that discusses the
      // firmware's own bands is not mistaken for an announcement.
      const pair = '(-?\\d+)\\s*(?:-|–|to|TO)\\s*(-?\\d+)'
      for (const p of numbers) {
        const named = new RegExp(`\\b${p.name}\\s+${pair}`).exec(prose)
        const bare = numbers.length === 1
          ? new RegExp(`DECLARED RANGES?\\s+${pair}`, 'i').exec(prose)
          : null
        const found = named || bare
        if (!found) continue
        const [, lo, hi] = found
        if (Number(lo) !== p.min || Number(hi) !== p.max) {
          fail(`commands.${name}.constraints says ${p.name} is ${lo}..${hi} but the contract declares ${p.min}..${p.max}`)
        }
      }
    }
    if (!entry.constraints && (entry.params || []).length > 0) {
      warn(`commands.${name} takes parameters but declares no constraints`)
    }
  }
} else {
  fail('ERR_PLUGIN_SECTION_NOT_ARRAY: commands')
}

// health
const health = caps.health
if (!health || !Array.isArray(health.supportedStates) || health.supportedStates.length === 0) {
  fail('capabilities.health.supportedStates must be a non-empty array')
}
if (Array.isArray(health.alerts) && Array.isArray(health.troubleshooting)) {
  // Every alert should have a matching remediation line; an alert an operator
  // cannot act on is noise.
  for (const alert of health.alerts) {
    const key = alert.split('.').pop()
    if (!health.troubleshooting.some((line) => line.includes(alert) || line.includes(key))) {
      warn(`health.alerts ${alert} has no matching troubleshooting entry`)
    }
  }
}

// --- error-code coverage, both directions ----------------------------------

const declared = new Set(Object.keys(caps.errors || {}))
const libErrors = require(path.join(ROOT, 'lib', 'errors.js'))
const thrown = new Set(
  Object.entries(libErrors)
    .filter(([key, value]) => /^ERR_[A-Z0-9_]+$/.test(key) && typeof value === 'string')
    .map(([, value]) => value)
)

for (const code of thrown) {
  if (!declared.has(code)) fail(`capabilities.errors is missing ${code}, which lib/errors.js can throw`)
}
for (const code of declared) {
  if (!thrown.has(code)) warn(`capabilities.errors declares ${code}, which lib/errors.js never throws`)
}
for (const [code, text] of Object.entries(caps.errors || {})) {
  if (typeof text !== 'string' || text.length < 20) warn(`capabilities.errors.${code} needs a usable explanation`)
}

const provisional = require(path.join(ROOT, 'lib', 'provisional.js'))

const stillProvisional = provisional.unconfirmed()

// --- report ----------------------------------------------------------------

function report () {
  const counts = `${seen.telemetry.size} telemetry, ${seen.commands.size} commands, ${declared.size} error codes`

  if (warnings.length) {
    console.log('')
    for (const w of warnings) console.log(`  warn   ${w}`)
  }

  if (stillProvisional.length) {
    console.log('')
    console.log('  ⚠ PROVISIONAL VALUES — not safe for production until confirmed:')
    for (const name of stillProvisional) {
      const entry = provisional.ALL[name]
      const shown = entry.min !== undefined ? `[${entry.min}, ${entry.max}]` : String(entry.value)
      console.log(`      ${name} = ${shown}   (lib/provisional.js)`)
    }
  }

  console.log('')
  if (errors.length) {
    for (const e of errors) console.log(`  FAIL   ${e}`)
    console.log('')
    console.log(`contract INVALID — ${errors.length} error(s), ${warnings.length} warning(s)`)
    process.exit(1)
  }

  const schemaNote = schemaResults.length ? `; schema ${schemaResults.join(', ')}` : ''
  console.log(`contract OK — ${counts}${schemaNote}; ${warnings.length} warning(s), ${stillProvisional.length} provisional value(s)`)
}

report()
