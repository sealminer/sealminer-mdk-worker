# SealMiner Worker usage

Field provenance and operational semantics. [`mdk-contract.json`](mdk-contract.json) is the authoritative
reference; this document answers the question a contract cannot: **where does each number come from, and what
does it mean.**

## Device reads

Every channel is served from three cached device reads, not one call per channel:

| Read | Command | Cache TTL | Serves |
| --- | --- | ---: | --- |
| stats | `{"command":"stats"}` | 4 s | most channels |
| summary | `{"command":"summary"}` | 4 s | share counters and reject rate |
| pools | `{"command":"pools"}` | 8 s | `pools`, `pool_url` |
| version | `{"command":"version"}` | process lifetime | `firmware_info` |
| config | `{"command":"config"}` | 8 s | `snap` |

Kernel pulls `metrics` every 10 seconds by default, which invokes **all 27 handlers concurrently**. Reads are
single-flight: concurrent callers share one in-flight request rather than opening 27 sockets to a
single-threaded API. A successful write invalidates the caches so its effect is visible on the next pull.

`snap.ageMs` reports how stale the view is; `snap.cached` says whether this pull touched the device.

## Telemetry provenance

Unit conversion happens once, in the parser. Every hashrate field in the API is MH/s and is published as TH/s.

| Channel | Type | Source field | Conversion / derivation |
| --- | --- | --- | --- |
| `hashrate_rt` | number TH/s | `stats MHS(1m)` | ÷ 1e6 |
| `hashrate_avg` | number TH/s | `stats MHS(Avg)` | ÷ 1e6 |
| `hashrate_ideal` | number TH/s | `stats MHS(Ideal)` | ÷ 1e6 |
| `hashrate_pr` | number % | `stats PR(Avg)` | as reported |
| `power` | number W | `stats PSU Input Power` | as reported |
| `efficiency` | number W/TH | `stats W/T(Avg)` | as reported (already W/TH) |
| `temperature` | number C | `stats Temp` | as reported |
| `fan_speed` | number RPM | `stats "<n> Speed"` | max across fans |
| `power_mode` | string | `stats Mining Mode` | canonical token |
| `status` | string | `stats PM State` | canonical token |
| `tune_status` | string | `stats Tune Status` | canonical token |
| `uptime` | number s | `stats System Uptime` | as reported |
| `accepted_shares` | number | `summary Accepted` | as reported |
| `rejected_shares` | number | `summary Rejected` | as reported |
| `reject_rate` | number % | `summary Pool Rejected%` | as reported |
| `pool_url` | string | `pools[] Stratum URL` / `URL` | stratum-active pool, else highest-priority alive pool |
| `pools` | array | `pools` | normalized; no password field is mapped |
| `hashboards` | array | `stats "<n> ..."` | grouped by board; `null` when clipped |
| `fans` | array | `stats "<n> PWM" / "<n> Speed"` | grouped by fan |
| `psu_info` | object | `stats PSU *` | `PSU Error` published as **`errorWord`** |
| `chip_health` | object | `Chip Count`, `Bad Chip Count`, `Error Chip`, per-board ratios | ratio derived; `boards: null` when clipped |
| `device_info` | object | `Model`, `ASIC`, `MAC`, `Ctrl Board`, `Ctrl Board SN` | plus the resolved series and its source |
| `firmware_info` | object | `Firmware`, `Software Version`, `BIN *` + `version` | — |
| `errors` | array | aggregated (see below) | — |
| `capabilities` | object | derived from series + firmware | — |
| `health` | object | derived | overrides the runtime builtin |
| `snap` | object | stats + summary + pools + version + config | plus `ts`, `cached`, `ageMs`, `truncated`, `boardsComplete` |

### Why `psu_info.errorWord` and not `error`

`WorkerRuntimeV2` signals a failed telemetry channel by returning `{ error: ... }` under that channel's key. A
`psu_info` object with an `error` field therefore makes every consumer that checks `value.error` read a healthy
PSU (`0x00000000`) as a broken channel. The field is named `errorWord` so that cannot happen.

### Canonical tokens

Firmware display strings are normalized to stable lowercase tokens, so a consumer never matches on presentation:

- `power_mode`: `low_power`, `normal`, `high_performance`, `ultra_low_power`, `custom`, `smartboost`
- `status`: `idle`, `initializing`, `running`, `resuming`, `resume_failed`, `suspended`, `suspending`, `suspend_failed`
- `tune_status`: `tuning_idle`, `coarse_tuning`, `coarse_tuning_done`, `fine_tuning`, `fine_tuning_done`

Firmware builds before the V0.5-era change reported these three fields as **integers**, and the API document
does not specify that encoding. Those values normalize to `null` and raise `warn.enum_unreadable` rather than
being guessed — a wrong guess would silently mislabel a miner's power mode. Numeric telemetry is unaffected.

### `null` means unknown

Absent, unparseable and truncated values are `null`, never `0`. `0` is reserved for a genuine zero: a suspended
miner really does draw 0 W and really does report 0 RPM.

## Truncated replies

`stats` carries `"id": 1` when complete and `"id": 0` when the firmware clipped it. Production hardware reports
1092 chips × 6 fields ≈ 6500 keys, so clipping is a real possibility. Handling is tiered:

| Situation | Behaviour |
| --- | --- |
| Device-level fields complete | channels serve normally; `snap.truncated: true` |
| Fewer boards than `Board Count` | `hashboards` and `chip_health.boards` are `null`; `warn.stats_truncated` raised |
| Device-level fields missing | affected channels report their error |

Board counts always come from the firmware's own `Board Count` / `Fan Count`, never from which keys arrived —
inferring the count from a clipped reply would under-report the miner.

## Commands

| Command | 4028 call | Class | Cooldown | Firmware gate |
| --- | --- | --- | ---: | --- |
| `setTimezone` | `ascset timezone` | safe | — | — |
| `setStratumDisconnectTimeout` | `ascset stratum-disconnect-timeout` | safe | — | unconfirmed |
| `setPowerMode` | `ascset workmode` | reversible | 60 s | `sleep` ≥ 2025101601 |
| `setPowerLimit` | `ascset powerlimit` | reversible | 60 s | — |
| `setFastRaiseFreq` | `ascset fast-raise-freq` | reversible | 60 s | — |
| `setPreheat` | `ascset preheat` | reversible | 30 s | — |
| `setIdleFanTimer` | `ascset idle-fan-timer` | reversible | 30 s | ≥ 2025081801 |
| `setHostname` | `ascset hostname` | reversible | 30 s | ≥ 2025062602 |
| `restartMiner` | `restart` | disruptive | 60 s | — |
| `suspend` | `ascset suspend` | disruptive | 60 s | — |
| `resume` | `ascset resume` | disruptive | 60 s | ≥ 2026060101, removed 2025080401–2026053100 |
| `setupPools` | `updatepools` | disruptive | 30 s | — |
| `reboot` | `reboot` | disruptive | 5 min | — |
| `setNetwork` | `ascset network` | **risky** | 5 min | ≥ 2025062602 |

Only `safe` commands are marked retryable. Everything else is attempted once: a timeout leaves the physical
outcome unknown.

### reboot vs restartMiner vs suspend vs sleep

Four operations stop hashing and they are not interchangeable:

| | Effect | Recovery | Uptime | Share counters |
| --- | --- | --- | --- | --- |
| `restartMiner` | restarts the bdminer process | automatic, re-tunes | preserved | reset |
| `reboot` | reboots the controller | automatic, 2–3 min | reset | reset |
| `suspend` | stops mining, PSU output **and fans** | needs `resume`/`restartMiner` | preserved | preserved |
| `setPowerMode sleep` | mining mode that stops hashing | another mode change | preserved | preserved |

`suspend` stops the fans, so it is never the right response to overheating — reduce power instead.

### Validation split

Kernel's dispatcher validates only the primitive type of a `number`/`string` parameter and a `number`'s declared
`min`/`max`. It skips `required` entirely (an `undefined` value passes straight through) and never looks at
`enum`. So this worker declares `min`/`max` on **every** numeric parameter to get that one Kernel-side check, and
enforces required-ness, enums, booleans, object shapes and cross-field rules itself, each with a stable `ERR_*`
code documented in the contract.

## Health and alerts

`health` overrides the runtime's built-in channel and reports `OK`, `DEGRADED` or `OFFLINE` with the alert codes
that justified the verdict. `errors` returns the same findings with per-entry severity and detail.

Two rules keep the signal usable in a fleet:

1. **Expected states are states, not faults.** A tuning miner and a deliberately suspended miner stay `OK`,
   reported as `info.tuning` and `info.suspended`.
2. **`info.tuning` suppresses `alert.hashrate_low`.** Reduced hashrate during a tuning cycle is normal; alerting
   on it teaches operators to ignore the channel.

| Alert | Condition |
| --- | --- |
| `alert.overheat` | `Temp ≥ Target Ctrl Temp + 5` |
| `alert.psu_overheat` | `PSU Temp HOT ≥ 80` *(provisional)* |
| `alert.psu_error` | `PSU Error` is non-zero |
| `alert.fan_failure` | any fan at 0 RPM while `status` is `running` |
| `alert.hashboard_offline` | any board `Online` false |
| `alert.hashboard_low_hash` | any board `Low Hash` true |
| `alert.bad_chip` | any board bad-chip ratio > 5% *(provisional)* |
| `alert.pool_disconnected` | `Stratum Disconnect` true, or no pool stratum-active |
| `alert.device_error` | `Error Code` / `Error Chip` set, or a failed suspend/resume transition |
| `alert.hashrate_low` | `PR(Avg) < 90%` while running and **not** tuning *(provisional)* |
| `alert.unreachable` | no telemetry could be read |
| `warn.stats_truncated` | reply `id: 0` |
| `warn.enum_unreadable` | firmware reports enums as undocumented integers |
| `warn.reject_rate_high` | pool reject rate > 5% (does not degrade the device) |
| `info.tuning` | `tune_status` is `coarse_tuning` or `fine_tuning` |
| `info.suspended` | `status` is `suspended` |

Thresholds marked provisional live in [`lib/provisional.js`](lib/provisional.js).

## Failure semantics

- Read failures surface on the affected channel as `{ error }`; siblings keep working.
- `health` never throws: an unreachable device reports `OFFLINE` so a verdict is always available.
- Every thrown code is a stable `ERR_*` documented in `capabilities.errors`.
- One device's failure never affects another: the runtime gives each device its own module registry, so client
  state, caches, cooldowns and in-flight tracking are per miner by construction.
- `ERR_ACCESS_DENIED` (reply code 45) means API write access is not enabled on the miner. Reads still work.

## Outstanding confirmations

These block production use of the affected feature. Everything else works against the mock and against hardware.

| Item | Blocks |
| --- | --- |
| `powerlimit` unit and per-series range | `setPowerLimit` |
| API write permission model (default state, how to enable, when code 45 fires) | every write on real hardware |
| Full `Model` → A2/A3/A4 map | series inference when the site does not declare `series` |
| Legacy integer encodings for the three enum fields | `power_mode` / `status` / `tune_status` on old firmware |
| A real complete `stats` dump | mock fidelity (use `scripts/dump-stats.js`) |
| Fan index → intake/exhaust position | directional fan channels |
| `miner-status` subcommand format | a possible lighter-weight poll than `stats` |
| PSU hot-spot, bad-chip and PR thresholds | alert accuracy |
