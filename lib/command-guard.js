'use strict'

const debug = require('debug')('sealminer:guard')
const {
  fail,
  stableCode,
  ERR_COMMAND_COOLDOWN,
  ERR_COMMAND_IN_PROGRESS,
  ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE
} = require('./errors')

// Safety rail every physical command passes through. One place, so 14
// handlers cannot each forget a different part of it.
//
// It enforces, in this order:
//   1. parameter validation   — pure, cheap, never reaches the device, and
//                               gives the most informative failure
//   2. capability gating      — refuse what this firmware/series cannot do,
//                               naming the fallback when there is one
//   3. concurrency            — one in-flight command of a kind per device
//   4. cooldown               — declared minimum spacing between attempts
//   5. audit                  — structured event for started/succeeded/
//                               failed/rejected
//   6. result annotation      — say what the device accepted, and where the
//                               effect will show up
//
// Rule 6 is deliberately an annotation and not a verdict. Every write on this
// API is asynchronous — the firmware replies first and executes afterwards —
// so a "did it apply?" check run inside the command would be premature by
// construction. An earlier version of this guard did exactly that and failed
// writes that had in fact been accepted and stored, which is the more
// dangerous error: an operator who reads "not applied" walks away having left
// a change armed. Confirming an effect belongs to the caller, a telemetry
// cycle or two later.
//
// Validation runs before cooldown on purpose: a malformed call never touches
// hardware, so masking it with a cooldown rejection would be misleading.
//
// Cooldown is recorded *before* device I/O. A write that times out has an
// unknown physical outcome — the miner may well have executed it — so a
// failed attempt must consume the cooldown just like a successful one.
//
// Cooldown state is in-process by default, which means a worker restart
// clears it: a DISRUPTIVE command could be issued twice in a row across a
// restart, spacing be damned. Pass `deps.store` to keep it somewhere durable
// (src/db.js does, in SQLite). The seam is a plain get/set pair so this file
// stays storage-agnostic and free of any MDK or database dependency.

/** How a command behaves physically. Drives retry policy and audit context. */
const DANGER = {
  /** No physical effect, fully reversible. A read-level retry is acceptable. */
  SAFE: 'safe',
  /** Changes a setting that can be set back. */
  REVERSIBLE: 'reversible',
  /** Interrupts mining; recoverable without a site visit. */
  DISRUPTIVE: 'disruptive',
  /** Can make the device unreachable. Single attempt, ever. */
  RISKY: 'risky'
}

const OUTCOME = {
  STARTED: 'started',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  REJECTED: 'rejected'
}

/**
 * Build a guard bound to one device.
 *
 * WorkerRuntimeV2 loads the handler modules into a private registry per
 * device, so one guard instance — and the cooldown/in-flight state it holds —
 * already belongs to exactly one miner. There is no Map keyed by device id
 * and no cross-device leakage by construction.
 *
 * @param {object} deps
 * @param {string} deps.deviceId for audit events
 * @param {Function} [deps.audit] receives the event object; defaults to a
 *   structured console.info line, the shape MDK's guide specifies
 * @param {Function} [deps.getCapabilities] async () => capability descriptor
 * @param {Function} [deps.now] clock seam for tests
 * @param {object} [deps.store] durable cooldown state:
 *   `{ getLastAttempt(name) => number|null, setLastAttempt(name, ts) }`.
 *   Synchronous, because the cooldown check sits on the command path. Faults
 *   are tolerated — the guard falls back to process-local state.
 */
const createGuard = (deps = {}) => {
  const deviceId = deps.deviceId ?? null
  const now = deps.now || (() => Date.now())
  const getCapabilities = deps.getCapabilities || null

  const emit = deps.audit || ((event) => {
    // Never include credentials or raw device responses. The host process is
    // responsible for forwarding these to a durable audit sink.
    console.info(JSON.stringify(event))
  })

  const lastAttemptAt = new Map()
  const inFlight = new Set()

  // Durable cooldown, when a store is supplied. The in-memory map stays the
  // write-through cache and the fallback: a storage fault degrades to
  // process-local spacing rather than refusing — or silently permitting — a
  // physical command. A store that returns a stale-but-real timestamp is
  // always safer than no timestamp, so the newer of the two wins.
  const store = deps.store || null

  const readLastAttempt = (name) => {
    const inMemory = lastAttemptAt.has(name) ? lastAttemptAt.get(name) : null
    if (!store) return inMemory ?? -Infinity
    try {
      const stored = store.getLastAttempt(name)
      if (typeof stored !== 'number' || !Number.isFinite(stored)) return inMemory ?? -Infinity
      return inMemory === null ? stored : Math.max(inMemory, stored)
    } catch (err) {
      debug('cooldown store read failed for %s, using process-local state: %s', name, err.message)
      return inMemory ?? -Infinity
    }
  }

  const writeLastAttempt = (name, ts) => {
    lastAttemptAt.set(name, ts)
    if (!store) return
    try {
      store.setLastAttempt(name, ts)
    } catch (err) {
      debug('cooldown store write failed for %s, cooldown is process-local: %s', name, err.message)
    }
  }

  const audit = (name, outcome, extra = {}) => {
    emit({ event: 'physical_command', command: name, deviceId, outcome, ts: now(), ...extra })
  }

  /**
   * @param {object} spec
   * @param {string} spec.name contract command name, used in audit events
   * @param {string} spec.danger one of DANGER
   * @param {number} [spec.cooldownMs=0]
   * @param {boolean} [spec.exclusive=true] reject while one is in flight
   * @param {string} [spec.capability] capability key to check; defaults to name
   * @param {Function} [spec.validate] (params) => normalized params, throws ERR_PARAM_*
   * @returns {Function} (fn) => guarded handler
   */
  return (spec) => {
    const {
      name,
      danger,
      cooldownMs = 0,
      exclusive = true,
      capability = spec.name,
      validate,
      describe
    } = spec

    const retryable = danger === DANGER.SAFE

    return (fn) => async (rawParams = {}) => {
      const params = rawParams ?? {}
      const context = { class: danger, retryable }

      // 1. parameters
      let checked = params
      if (validate) {
        try {
          checked = validate(params) ?? params
        } catch (err) {
          audit(name, OUTCOME.REJECTED, { ...context, errorCode: stableCode(err) })
          throw err
        }
      }

      // 2. capability
      if (capability && getCapabilities) {
        let caps = null
        try {
          caps = await getCapabilities()
        } catch (err) {
          // An unreachable device is not a capability verdict: let the command
          // itself fail against the device rather than inventing a reason.
          caps = null
        }
        const entry = caps?.commands?.[capability]
        if (entry && entry.supported === false) {
          const detail = [entry.reason, entry.fallback && `use ${entry.fallback} instead`]
            .filter(Boolean).join('; ')
          audit(name, OUTCOME.REJECTED, {
            ...context,
            errorCode: ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE,
            firmware: caps.firmware ?? null,
            fallback: entry.fallback ?? null
          })
          fail(ERR_COMMAND_NOT_SUPPORTED_ON_FIRMWARE, `${name}: ${detail}`, {
            fallback: entry.fallback ?? null
          })
        }
      }

      // 3. concurrency
      if (exclusive && inFlight.has(name)) {
        audit(name, OUTCOME.REJECTED, { ...context, errorCode: ERR_COMMAND_IN_PROGRESS })
        fail(ERR_COMMAND_IN_PROGRESS, name)
      }

      // 4. cooldown
      const remaining = cooldownMs - (now() - readLastAttempt(name))
      if (cooldownMs > 0 && remaining > 0) {
        audit(name, OUTCOME.REJECTED, { ...context, errorCode: ERR_COMMAND_COOLDOWN, remainingMs: remaining })
        fail(ERR_COMMAND_COOLDOWN, `${name} for another ${remaining}ms`, { remainingMs: remaining })
      }

      // 5. run. Record the attempt first: a timed-out physical write may
      // still have been executed by the miner.
      writeLastAttempt(name, now())
      inFlight.add(name)
      audit(name, OUTCOME.STARTED, context)
      try {
        const result = await fn(checked)

        // The device accepted the request. It has not necessarily executed
        // it yet — see the note at the top of this file.
        let annotation = null
        if (describe) annotation = await describe(checked, result)

        audit(name, OUTCOME.SUCCEEDED, {
          ...context,
          ...(annotation?.pending ? { pending: true } : {}),
          ...(annotation?.detail ? { detail: annotation.detail } : {})
        })

        if (!annotation) return result
        const base = typeof result === 'object' && result !== null ? result : { result }
        return { ...base, ...annotation }
      } catch (err) {
        audit(name, OUTCOME.FAILED, {
          ...context,
          errorCode: stableCode(err),
          ...(err.detail ? { detail: err.detail } : {})
        })
        throw err
      } finally {
        inFlight.delete(name)
      }
    }
  }
}

module.exports = { createGuard, DANGER, OUTCOME }
