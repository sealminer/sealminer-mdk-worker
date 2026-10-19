# Real-hardware captures

Verbatim `4028` replies from a real SealMiner, captured with
`scripts/dump-stats.js`. They are the ground truth the mock is calibrated
against: where the API document and these files disagree, these win.

| Source | |
| --- | --- |
| Device | SealMiner A2 |
| Model / ASIC | `A2` / `Seal02-V1` |
| Firmware | `2026040101` |
| bdminer | `4.11.1-08730-g0c2d5ff4`, API `3.7` |
| Captured | 2026-09-21 |

Redacted before publication, and nothing else is altered: the pool worker
name, the pool hostnames, and the device identities — `IP`, `MAC`,
`Ctrl Board SN`, the per-board `<n> SN` values and `PSU SN`. Placeholders keep
each field's real shape and length so the parsers still meet the format they
will meet in production; the MAC comes from RFC 7042's documentation range and
the hostnames from RFC 2606's `example.com`, so neither can collide with a real
NIC or a real pool. The two relationships in `pools.json` that carry meaning are
kept: the first entry's `Stratum URL` still matches its own `URL`, and the
second and third are still the same host on two ports, which is what a pool's
failover port looks like. Every value that carries engineering meaning —
counts, readings, firmware strings, key names and types — is exactly as the
miner sent it.

## What these captures corrected

| The document says | Real firmware sends |
| --- | --- |
| `version` → `Bdminer` | `BDMiner` |
| `Chip voltage` | `Chip Voltage` |
| one `<n> Temp` per board | four sensors, `<n> Temp 0`..`<n> Temp 3` |
| `<n> LVT PMOS(Avg)` | `ELVT` and `ULVTLL` domains; no `LVT` |
| `Startup Times` | `Boot Count` |
| per-chip keys (`0.107 Freq`, …) | none at all |
| `Model: "K10Pro"` | `Model: "A2"` — the series itself |
| `PSU Temp HOT` | absent; only `PSU Temp AMB` |
| — | `Power Limit`, `Fast Raise Freq`, `Pools Locked`, `IP`, `PSU SN`, `Total Energy Consumption`, `Raise Freq Done Reason`, `<n> Marking`, `<n> Total MH`, a `30s` window and `MHS(Avg2)` |

`ascset help` on this firmware reports 12 subcommands and **does not list
`resume`** — independent confirmation that the firmware-gating table is
right, since 2026040101 falls inside the window where `resume` was removed.
It does list `miner-status`, which the document never describes.

## A write the firmware accepts and defers (first read as 'ignores')

On this device `ascset powerlimit` answers **`code 119 "ASC 0 set OK"` for every
value and changes nothing**:

| Sent | Reply | `Power Limit` after 18s | bdminer restarted |
| --- | --- | --- | --- |
| `{"value":"3000"}` | `119 ASC 0 set OK` | 4300 (unchanged) | no |
| `{"value":"4200"}` | `119 ASC 0 set OK` | 4300 (unchanged) | no |
| `{"value":"4400"}` | `119 ASC 0 set OK` | 4300 (unchanged) | no |
| `{"value":4200}` (number) | `120 ASC 0 set failed: Missing "value"` | 4300 | no |

`System Uptime` kept climbing and `Boot Count` stayed at 17 throughout, so
mining never restarted — the document states this command "automatically
restart[s] mining".

Two conclusions:

1. **The value must be a string.** A numeric `value` is refused with
   `Missing "value"`, so the client sends `String(watts)`.
2. **A successful reply is not evidence of a change.** The worker therefore
   polls the `power_limit` channel after the write and fails with
   `ERR_WRITE_NOT_APPLIED` unless the device reports the new value. The
   behaviour is reproducible in CI through the mock's `powerlimit_noop` fault.

Why the command is inert on this firmware is a question for the firmware team:
the limit may be administratively locked (the same device reports
`Pools Locked: true`), it may only apply in a particular mining mode, or it may
be a defect. **Reporting success for a write it does not perform is a defect
either way.**

Nothing was left changed on the device. Before and after the test:
`Power Limit 4300 W · ~3990 W draw · ~240 TH/s · 70 C · Running ·
Fine Tuning Done · Boot Count 17`.

## Every ascset value must be a JSON string

Probing each subcommand with a deliberately wrong key makes the firmware name
what it wanted — a free, zero-side-effect way to check our parameter shapes
against the device:

| Subcommand | Firmware requires | Matches our client |
| --- | --- | --- |
| `powerlimit` | `value` | yes |
| `workmode` | `mode` | yes |
| `timezone` | `value` | yes |
| `preheat` | `enable_boot_preheat`, **and then** `boot_preheat_temp`, `boot_preheat_timeout`, `enable_tune_preheat` — all four required | **no, fixed** |
| `fast-raise-freq` | `value`, as `"1"`/`"0"` | **no, fixed** |
| `hostname` | `value` | yes |
| `webpasswd` | `user`, `new-pass` | yes |
| `idle-fan-timer` | `interval`, `on_duration`, `speed` | yes |
| `stratum-disconnect-timeout` | `value` | yes |

**The value type is the trap.** Every value must be a JSON *string*:

| Sent | Reply |
| --- | --- |
| `{"value":"3000"}` | `119 ASC 0 set OK` |
| `{"value":3000}` (number) | `120 Missing "value"` |
| `{"value":true}` (boolean) | `120 Missing "value"` |
| `{"value":"true"}` | `120 Invalid "enable_fast_raise_freq"` |
| `{"value":"1"}` | `119 ASC 0 set OK` |

That cost this worker two bugs the document's own wording had hidden — it
calls `boot_preheat_temp` an `int` and `enable_fast_raise_freq` a `boolean`,
and the firmware accepts neither as such. `setFastRaiseFreq` sent a JSON
boolean and `setPreheat` sent numbers plus only the fields the document
emphasised; both would have failed on every real miner. The mock now enforces
the string rule and the required-field set, so CI catches it rather than a
field engineer.

## Other firmware behaviour worth knowing

- **`boot_preheat_temp: "99"` is accepted** although the document says 0–35.
  The firmware does not range-check it, so the contract's declared bound and
  the handler check are the only protection.
- **`hostname` and `timezone` really do execute**, and report genuine
  failures: `Failed to set hostname: bad name`,
  `Failed to set timezone: Not/AZone`. So the silent no-op is specific to the
  persistent mining settings (`powerlimit`, `fast-raise-freq`), not to
  `ascset` as a whole — which points at those settings being locked rather
  than at a broken command dispatcher.
- **One malformed reply in roughly forty reads.** A `stats` reply came back as
  JSON cut off mid-key at byte 4344 of ~7249. Not reproducible in 35 further
  attempts, including 15 read-immediately-after-write sequences. Reads now get
  one bounded retry on a corrupted reply; writes still never retry.

## Correction: those writes are deferred, not ignored

The section above was written from an incomplete test and its conclusion was
wrong. `powerlimit`, `workmode` and `fast-raise-freq` on firmware 2026040101
are **not** inert. They are **stored immediately and applied at the next
bdminer restart**, and `stats` keeps reporting the *running* value — there is
no field anywhere in the API that reports the pending one.

How it surfaced: `workmode sleep` was sent during parameter-name probing and
answered `119 ASC 0 set OK`. `Mining Mode` stayed `Normal` and the miner kept
hashing at 239 TH/s, so it was recorded as another no-op. A later
`restartMiner` applied the stored value and the miner went to
`PM State: Suspended`, 0 TH/s, ~95 W. It took setting `workmode normal` plus
another restart to get it back.

The root cause is in the API document's own revision history: V0.5
(2026-06-09) records the change that made `workmode/powerlimit/preheat`
restart bdminer themselves. **Firmware 2026040101 predates that change.** So
this is firmware-version-gated behaviour, which is exactly what the capability
matrix is for — `FW.SETTINGS_AUTO_RESTART` and
`capabilities.settingsApplyImmediately` now carry it.

Two consequences for the worker:

1. **Readback verification is wrong for those builds.** It reported
   `ERR_WRITE_NOT_APPLIED` for a write that had in fact been accepted and
   stored. An operator reading "not applied" walks away having left a change
   armed — which is precisely the trap above. Those commands now succeed with
   `pending: true` and `appliesOn: "next bdminer restart"`, and readback
   verification runs only where the firmware does auto-restart.
2. **The mock models it.** Below the threshold a mining setting goes to a
   pending bag and only a `restart`/`reboot` applies it. A sleeping miner is
   modelled as `PM State: Suspended` with the reported mode unchanged, because
   the documented `Mining Mode` values contain no `Sleep` and that is how the
   real device presented. A permissive mock is what allowed the wrong
   conclusion in the first place.

Also worth recording: `enable_boot_preheat: "1"` with `boot_preheat_temp: "99"`
was accepted during the same probe and left set. On a miner that is not
hashing the board cools, so a 99 C preheat target can never be reached — a
second way to leave a miner parked. Probing writes must be rolled back in the
same breath, and a preheat target above the boot target should be refused by
the caller, which the contract's 0–35 bound now does.

## Correction, second pass: all writes are asynchronous by design

Confirmed by the vendor: **every** write on this API replies first and
executes afterwards. `119 ASC 0 set OK` means the request was *accepted*, not
that it has been applied. `reboot` makes it obvious — the reply arrives before
the device even goes away — but the rule is general.

That invalidates the readback verification this worker had just added, in
principle rather than in detail: a "did it apply?" check with any timeout is
premature by construction, and its verdict can only be wrong in the dangerous
direction. An operator who reads "not applied" for a write that was in fact
stored walks away having left a change armed.

So the worker no longer adjudicates writes. `ERR_WRITE_NOT_APPLIED` is gone.
Each write result now says what was accepted, when the effect applies and
which channel confirms it:

```
setPowerLimit(4300) -> SUCCESS
  accepted: 4300
  appliesOn: "next bdminer restart"
  pending: true
  confirmWith: "power_limit"
  detail: "stored; firmware 2026040101 does not apply this until bdminer
           restarts, and the API cannot read the pending value back"
```

Writes with no readback at all — timezone, hostname, idle-fan-timer,
stratum-disconnect-timeout, preheat, network — say exactly that
(`confirmWith: null`) rather than implying a confirmation that does not
exist. Confirming an effect is the caller's job, one or two telemetry cycles
later, which is what the contract's `examples` already tell an operator or
agent to do.

## Measured timings and behaviour of the disruptive commands

All three were executed against the live A2. The reply always came back before
the device acted, which is the asynchrony the vendor described.

| Command | Reply | API unreachable | System Uptime | Boot Count |
| --- | --- | --- | --- | --- |
| `restartMiner` (from running) | immediate | ~30 s | preserved | +1 |
| `restartMiner` (recovering from suspend) | immediate | **~4.5 min** | preserved | +1 |
| `reboot` | 1232 ms | **~5.5 min** | **reset** | +1 |

The document says `reboot` "takes 2-3 minutes to resume"; it took about twice
that here, and hashrate then ramped for several more minutes (41 → 105 → 240
TH/s). The contract now states the measured figures.

`suspend` behaved as documented and then some:

- power fell from ~4000 W to 95 W
- fans wound down 5160 → 420 → 0 RPM over about 35 seconds
- board temperature fell 70 → 63 C
- **the PSU began reporting a non-zero error word**, because its output is
  deliberately off

That last one produced a false `alert.psu_error` and degraded a miner an
operator had just suspended on purpose — the exact failure mode `info.suspended`
exists to prevent, which had been applied to the fan alert but not the PSU one.
It is now reported as `info.psu_output_off` and does not degrade health, and the
mock emits the word while suspended so the rule stays tested.

A second false alarm showed up during recovery: `alert.hashrate_low` fired on a
miner that had come back seconds earlier and was behaving correctly, because
`tune_status` was not yet in a tuning state. Health now reports `info.starting`
while bdminer's own `Elapsed` is inside the ramp window and suppresses both
`alert.hashrate_low` and `alert.fan_failure` for its duration — fans run flat
out during startup before settling.
