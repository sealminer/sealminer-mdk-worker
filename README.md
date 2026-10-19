# SealMiner MDK Worker

Bitdeer SealMiner Worker plugin for [Tether MDK](https://github.com/tetherto/mdk). The package is loaded
directly from this directory by MDK's `WorkerRuntimeV2`; it exports no module of its own and bundles neither a
Kernel nor a process supervisor.

Supports the **A2, A3 and A4** series over the bdminer **4028 JSON API**. The three series share one API; A2
additionally accepts the `low_power` mining mode, and five write operations are gated on firmware version. Rather
than inferring any of that from the model number, read the `capabilities` telemetry channel: it reports what the
device in front of you actually accepts.

| | |
| --- | --- |
| Telemetry channels | 29 |
| Commands | 14 |
| Device protocol | TCP 4028, JSON, one request per connection |
| Authentication | none at the protocol level; API write access is controlled on the miner |
| Runtime | `WorkerRuntimeV2` (directory-loaded plugin) |

## Requirements

- Node.js 24 or newer
- An MDK checkout containing `WorkerRuntimeV2` (see below). Verified against **v0.8.0 and v0.10.0**: the whole
  suite below, including the Kernel chain and MDK's own smoke harness, passes unchanged on both.
- Network access from the Worker host to the miner's port 4028

## Install

`@tetherto/mdk-worker` is not published to the npm registry yet, so MDK is resolved from a checkout by path — the
same way every in-repo MDK worker resolves it:

```bash
git clone https://github.com/tetherto/mdk.git            # keep it as a sibling directory
npm install --prefix mdk/backend/core/mdk-worker          # the runtime's own dependencies
npm install --prefix mdk/backend/core/kernel              # only needed for the integration tests
npm install
```

Pin MDK to a tag rather than tracking `main`: it is pre-1.0 and the contract schema and runtime still move.

## Host the Worker

```js
'use strict'

const path = require('node:path')
const { WorkerRuntimeV2 } = require('@tetherto/mdk/backend/core/mdk-worker')

const runtime = new WorkerRuntimeV2(path.resolve('/path/to/sealminer-mdk-worker'), {
  workerId: 'sealminer-rack-1',
  storeDir: './store/sealminer-rack-1',   // pass this, or the RPC identity changes on restart
  devices: [{
    deviceId: 'SM-A2-001',
    config: { address: '10.0.0.21', series: 'A2' }
  }]
})

await runtime.start()
```

### Device configuration

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `address` | Yes | — | Miner IPv4 address or hostname. `host` is accepted as an alias. |
| `port` | No | `4028` | bdminer API port. |
| `series` | No | inferred | `A2`, `A3` or `A4`. Inferred from the model string, which is a *product* name — `A2`, `A3 Air`, `A4 Ultra Hydro` all resolve. Declaring it is still recommended: an unrecognised product name is left unresolved rather than guessed, and then falls back to the modes common to all three series. |
| `timeoutMs` | No | `8000` | Per-request device timeout. |
| `cacheTtlMs` | No | `4000` | Freshness window for `stats`/`summary`. Keep it below the Kernel telemetry cadence. |
| `poolsCacheTtlMs` | No | `8000` | Freshness window for `pools`. |
| `parseChips` | No | `false` | Also normalize per-chip data (~6500 keys on production hardware). Diagnostics only. |
| `dbPath` | No | in-memory | SQLite file for this device's own store: the `history` channel, a durable copy of the command audit trail, and the cooldown clock. One path per device. |

The 4028 API takes no credentials, so nothing secret belongs in `config`.

#### Why `dbPath` is worth setting

Without it the worker runs exactly as before, with its store in memory. Two things change when you set it:

- **Command cooldowns survive a worker restart.** The declared spacing between physical commands is otherwise
  process-local, so restarting the host resets it and a `reboot` or `suspend` can be re-issued immediately. That
  is the one behaviour here that is a safety property rather than a convenience.
- **`history` and the command audit trail outlive the process.** The `console.info` audit lines are gone with
  the process; the SQLite copy is not. Production hosts should still forward the console events to a durable
  audit sink — this is a local record, not a replacement for one.

Retention is bounded and pruned on write: 7 days of samples, 90 days of command events. Sampling is driven by the
runtime's own telemetry cadence, so `history` resolution equals that interval.

## Evaluating this worker

No hardware needed, and no access to a real miner:

```bash
git clone https://github.com/tetherto/mdk.git ../mdk     # v0.8.0 and v0.10.0 are both verified
for p in mdk-worker kernel mdk client; do npm install --prefix ../mdk/backend/core/$p; done
npm install && npm run console
```

Four of MDK's packages, not two: `mdk-worker` and `kernel` are enough to boot the console and run every suite
except the Kernel chain, which also needs `mdk` and `client`. Installing all four up front means **Run all**
works on the first press.

The console listens on 7070. If something already holds it — usually another console left running — it says so
and suggests `--port`; `pkill -f dev-console.js` clears a stray one.

`npm run console` expects MDK as a sibling directory, as cloned above. Set `MDK_REPO` to point somewhere else:
`MDK_REPO=/path/to/mdk npm run console`. Arguments pass through — `-- --port 7071` moves the port. `--all` is
still accepted and now does nothing: all seven products boot by default.

### What is on the page

| Panel | What it is for |
| --- | --- |
| **Live readings** | Collapsed bar at the top. Closed it shows hashrate, power, temperature and health; open it shows the tiles and all 29 channels, refreshed every 2s. The watch view; the API panel is the call view. |
| **Test suites** | Every test layer, lint through the Kernel chain. `Run all` is the one button that proves the most. |
| **The API surface** | Two collapsible halves — **29 read interfaces** and **14 write interfaces** — every one of them callable from the page. |
| **Health** | The one channel that returns a *verdict* rather than a reading: `OK`/`DEGRADED`/`OFFLINE` plus alert codes. |
| **Inject a fault** | Break the mock on purpose, then watch **Health** react. The only way to see an alert without a failing miner. |
| **Audit events** | The command guard's structured events, as they are emitted. |

Both halves of the API panel are generated from `mdk-contract.json`, never from a hand-kept list, so the page
cannot drift from what Kernel publishes. Expand a read channel to call it and see the raw `{ name, value }`
reply; `history` gets a parameter field. Expand a command to get a form built from the contract's own types,
ranges and enums. **Check all** pulls every channel by name, cross-checks it against the
`metrics` fan-out, and marks each row in place:

| | |
| --- | --- |
| ✓ | a reading |
| ○ | answered `null` — the channel correctly reports that it does not know. **Never a zero stand-in.** |
| ✗ | wrong type, an error, or the two read routes disagreeing |

Only type and shape are compared. Values legitimately move between two calls — the mock's hashrate jitters,
`history` grows a row, `snap.ts` advances — so asserting equality would put red rows on a healthy miner.

A `null` is a pass, but it is the difference between *the miner told us* and *it did not*, so it is counted
separately. The clearest case is a clipped `stats` reply: board-level channels read `null` and `health` says
`warn.stats_truncated`, rather than the worker reporting two boards for a miner that declared three — which
would look exactly like a failed hashboard. Every device in the console carries a real product's measured
profile, so that case is not offered there; reproduce it with
`node scripts/run-mock.js --truncate 6000 --chips 1092`, or read the tests that cover it.

### What the console does and does not exercise

It hosts this package on a **real** `WorkerRuntimeV2` and drives it with real MDK protocol envelopes — built by
Kernel's own protocol module when `backend/core/kernel` is installed. So the contract loading, the per-device
module registry, telemetry routing by `query.type`, command dispatch, the `health` channel overriding the
runtime builtin, and the stripping of handler paths from the published contract are all genuine.

**Kernel, HRPC and the Gateway are not in the loop.** The console calls `handleRequest` directly, which is what
Kernel would do — so the Worker sees exactly what it would in production, but Kernel's own behaviour is not
covered: discovery and registration, the 10-second telemetry cadence, the command state machine, its
pre-dispatch numeric bound check, and the encrypted key-addressed transport. `tests/e2e/kernel-chain.js`
([below](#the-full-chain-through-kernel)) covers all of it against real hardware, and `npm run test:integration`
covers the envelope path with Kernel's own builder.

One consequence worth knowing: the out-of-range parameter check the console can demonstrate is rejected by
**this worker's** validation, not by Kernel's. Both would reject it; only ours is proven without Kernel in the
loop, which is what `npm run test:e2e` is for.

All seven mock miners appear in the device selector: the three series, each in both its air-cooled and
water-cooled form, plus one product twice on two firmware builds. Grouped by series, with the pair that matters
most at the end:

| Device | What it demonstrates |
| --- | --- |
| `SM-A2-001` | A2, current firmware — **nothing is restricted**: every channel and every command works |
| `SM-A2-006` | A2 Pro Hydro — the **same series**, water cooled: **no fans at all**, 840 chips on 2 boards |
| `SM-A3-002` | A3 Air, current firmware — **the series** removes `low_power` from `setPowerMode` |
| `SM-A3-007` | A3 Pro Hydro — water cooled, 792 chips on 2 boards |
| `SM-A4-008` | A4 Pro Air — the A4 series air cooled, and the product that reports `MHS(Rated)` as **0** |
| `SM-A4-003` | A4 Ultra Hydro on firmware 2025090101 — **the firmware** removes `sleep` and `resume` |
| `SM-A4-004` | The **same** product on firmware 20250620. The older build **has** `resume` and lacks `hostname`/`network`/`idle-fan-timer`: features are not only ever added, which is why capability is asked of the device |

Switch between them and watch the command panel change: on the A4, `setPowerMode`'s dropdown has neither
`low_power` nor `sleep`, and `resume` is marked **gated** with the required version and `restartMiner` named as
the fallback. That is the `capabilities` channel driving the UI, not a hard-coded list.

### Adding a real miner

`--live` adds real hardware alongside the mocks, and `SEALMINER_LIVE` does the same without retyping the flag:

```bash
npm run console -- --live 10.0.0.21
SEALMINER_LIVE=10.0.0.21,10.0.0.22 npm run console
```

A target may carry a port (`10.0.0.21:4029`); it defaults to 4028.

Live devices are probed at boot and re-probed every 15 seconds. **An unreachable one is dropped from the
selector** — with the reason shown in the header — rather than left there producing a wall of channel errors, and
it reappears on its own when it answers again. No restart either way: `WorkerRuntimeV2` fixes its device list at
construction, so the device stays registered and only its reachability changes.

Fault injection is mock-only. The page says so on a live device instead of offering controls that cannot work.

See [What is on the page](#what-is-on-the-page) above for the rest.

Everything above runs against simulated miners. What was verified on real hardware is in
[mock/fixtures/README.md](mock/fixtures/README.md), including the nine places where the API document and the
firmware disagree — the fixtures in that directory are verbatim captures from an A2 and are the ground truth the
mock is calibrated against.

## Test

**No hardware required at any layer, including the Kernel chain.** Every suite runs against the bundled mock.

All the automated suites live under `tests/`, one directory per layer:

| Layer | Where | Scale | Needs MDK |
| --- | --- | --- | --- |
| Unit | `tests/unit/` | 195 tests / 1051 asserts, incl. a 9-combination series × firmware matrix | no |
| Integration | `tests/integration/` | 21 tests / 162 asserts — real `WorkerRuntimeV2` over mocks | yes |
| End-to-end | `tests/e2e/` | 13 checks — real Kernel, HRPC and client SDK | yes |

`scripts/` holds tools rather than tests: the console, the mock runner, the contract validator, the capture tool,
and the `test-live-*.js` probes, which are the only things here that need a real miner.

```bash
npm run lint
npm run validate:contract                  # MDK's published schema, handlers, bounded params, error codes
npm run test:unit
MDK_REPO=../mdk npm run test:integration
MDK_REPO=../mdk npm run test:e2e           # Kernel + HRPC + client SDK, on a local DHT testnet
                                           # needs backend/core/mdk and /client installed too
MDK_REPO=../mdk npm test                   # lint + contract + unit + integration
```

Plus MDK's own smoke harness, which is the most independent check here — MDK's code, not ours:

```bash
# MDK_WORKER_BASE must be absolute: the harness resolves it relative to its own location
MDK_WORKER_BASE="$(cd ../mdk/backend/core/mdk-worker && pwd)" \
  node ../mdk/packages/mdk-skill/src/skills/mdk-worker-plugin/scripts/worker-smoke.mjs .
```

### Or run every layer from the console

If you would rather not learn which script proves what, the console runs all of it from one page:

```bash
npm run console
```

Open <http://127.0.0.1:7070> and press **Run all** in the *Test suites* panel. One card per layer, each stating
what it runs, what that proves, and the exact command, with the suite's own output streamed live. The suites are
a fixed allowlist in the console source — the page sends an id, never a command — and they run sequentially,
because the integration and e2e suites each boot their own runtime, mocks and DHT.

### The development console

See [Evaluating this worker](#evaluating-this-worker) for what the console shows, and
[Adding a real miner](#adding-a-real-miner) for `--live`. The only other flag moves the port:

```bash
npm run console -- --port 7071
```

The console is a tool for developing *this package*. It is not an MDK site UI: a fleet dashboard is a different
MDK extension point (a Gateway plugin plus the UI devkit) and belongs to whoever operates the site.

### The mock miner

`mock/` is a standalone simulator of the 4028 API with no MDK dependency. It is a state machine, not a canned
response server: a mode change shows up in the next `stats`, and `suspend` stops the fans and zeroes the power
reading.

```bash
node scripts/run-mock.js --port 4028 --series a2 --chips 1092
node scripts/run-mock.js --series a3 --firmware 20250620 --no-writes
node scripts/run-mock.js --fault fan_stopped --fault psu_error --truncate 65536
echo '{"command":"summary"}' | nc 127.0.0.1 4028
```

| Option | Purpose |
| --- | --- |
| `--series a2\|a3\|a4` | Which `workmode` values the firmware accepts |
| `--firmware <build>` | Which version-gated commands exist |
| `--chips <n>` | Response size; production hardware reports 1092 |
| `--truncate <bytes>` | Reproduce a clipped reply (`id: 0`) |
| `--legacy-types` | Emit the pre-V0.5 integer forms of the enum and boolean fields |
| `--no-writes` | Refuse every write with reply code 45 |
| `--fault <name>` | `fan_stopped`, `psu_error`, `psu_overheat`, `board_offline`, `board_low_hash`, `bad_chip`, `overheat`, `device_error`, `stratum_disconnect` |

## Against real hardware

Run these in order. The first three are safe on a producing miner; the fourth is not.

```bash
# 1. read-only: fails if any telemetry channel errors. Sends no write.
MDK_REPO=../mdk node scripts/test-live-readonly.js 10.0.0.21 --series A2

# 2. probe the write path without writing: `ascset help` has no effect and
#    reveals whether API writes are permitted (reply code 45) and which
#    subcommands this firmware really has.
node scripts/test-live-ascset-help.js 10.0.0.21

# 3. every rejection path, through the real guard. Nothing reaches the miner and
#    no physical state changes, so this is safe on a producing machine. It is the
#    only way to prove the series and firmware gates on hardware.
MDK_REPO=../mdk node scripts/test-live-rejections.js 10.0.0.21 --series A3

# 4. the only verifiable reversible write. Interrupts mining — test miners only.
MDK_REPO=../mdk node scripts/test-live-power-mode.js 10.0.0.21 --confirm
```

Capture a real reply set to calibrate the mock fixtures against hardware instead of against the API document's
truncated examples:

```bash
node scripts/dump-stats.js 10.0.0.21 --out mock/fixtures
```

`--out` is required, and pool `User` values are redacted on the way out — a miner's `pools` reply carries the
worker name the site mines under, which usually embeds the facility. `--raw` keeps them; point it outside the
repo.

### The full chain, through Kernel

Everything above talks to the miner directly, or through this worker's runtime. This one puts **Kernel, HRPC and
the client SDK** in the loop and answers the question an operator actually has: *can a user discover and operate
a real miner through MDK?*

```bash
# read-only, safe on a producing miner
MDK_REPO=../mdk node tests/e2e/kernel-chain.js 10.0.0.21 --series A2

# adds setTimezone UTC — no physical effect, and the value the miner already has
MDK_REPO=../mdk node tests/e2e/kernel-chain.js 10.0.0.21 --series A2 --write
```

It starts a Kernel, hosts this package on a real `WorkerRuntimeV2`, registers the worker by key, and then talks
to the miner only as a consumer would — by `deviceId`, never by address. 13 checks; each prints what it verified
and why that matters.

It runs a **local `hyperdht` testnet** by default and points all three tiers at it. HRPC is key-addressed over a
DHT even when every end is on one machine, and the public bootstrap made the first client call time out
non-deterministically. `--public-dht` opts out.

Three of the checks cannot be demonstrated any other way, because they are Kernel's behaviour and not ours:
Kernel rejects an out-of-range parameter, a wrong-typed parameter, and an unknown command **before dispatch**,
using the `min`/`max` this contract declares. That is the second line of defence a declared bound buys.

### What this found about command results

Kernel's command dispatch is asynchronous. `sendCommand` returns `{ commandId, status: 'QUEUED' }`, and on
MDK v0.8.0 and v0.10.0 alike the terminal result is **not readable by a remote consumer**:

- Kernel deletes a command from memory *and* the WAL as soon as it reaches a terminal state, so the
  `command.status` action answers only while the command is still in flight, and `ERR_COMMAND_NOT_FOUND`
  afterwards.
- The result leaves Kernel solely as an in-process `command:done` event, which an out-of-process consumer has
  no way to subscribe to.
- `createMdkClient` wraps no status method at all: `client.getCommandStatus(...)` throws
  `ERR_MDK_CLIENT_NO_SUCH_METHOD`.

So a consumer learns that a command was *accepted*, never that it *worked*. This is why every command in this
contract names a **`confirmWith`** channel: on this version of MDK, reading that channel is the only
confirmation path a consumer has. The end-to-end script asserts this explicitly rather than working around it,
so the check will fail — loudly and in the right place — if a later MDK makes results readable.

## Safety

To report a vulnerability, see [SECURITY.md](SECURITY.md) — privately, not as a public issue.

- Commands change physical state. Pool, network and power operations have consequences; `setNetwork` can make a
  miner unreachable and needs physical access to undo.
- **A write that times out has an unknown outcome and is never retried automatically.** Read the affected
  telemetry channel to establish the actual state before acting again.
- Every command enforces a cooldown and rejects a second concurrent attempt. A *failed* attempt consumes the
  cooldown too, because the miner may have executed it anyway.
- Every command emits a structured audit event (`started`, `succeeded`, `failed`, `rejected`) on `console.info`.
  The host process is responsible for forwarding those to a durable sink. They never contain credentials or raw
  device responses.
- Unknown, unsupported or truncated data is reported as `null`, never as `0`. A dashboard showing zero rejected
  shares must mean zero, not "could not tell".
- API write access is controlled by the miner. Enable it only while it is needed and disable it afterwards.

## Status

Pre-release. Several thresholds and bounds are **provisional placeholders** awaiting confirmation from SealMiner
and are collected in [`lib/provisional.js`](lib/provisional.js); `npm run validate:contract` lists them on every
run and asserts that the contract and the code never drift apart. The most important is the `setPowerLimit`
range: until it is confirmed, that command must not be used in production.

See [FIRMWARE.md](FIRMWARE.md) for what firmware has changed so far, how the code copes, and the procedure when a
new build arrives. See [USAGE.md](USAGE.md) for per-channel field provenance and
[mdk-contract.json](mdk-contract.json) for the authoritative field reference.

## Maintenance and releases

Maintained by Bitdeer QA. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the suite and the three rules a
review will hold you to; security reports go privately through [SECURITY.md](SECURITY.md) rather than as public
issues.

| | |
| --- | --- |
| Maintainer | Wei Zhou &lt;wei.zhou@bitdeer.com&gt; |
| Changes | [CHANGELOG.md](CHANGELOG.md) |
| Versioning | Semantic Versioning, pre-1.0 |

**`mdk-contract.json` is part of the public API**, not an implementation
detail — a consumer and an AI operator both read it to learn what the device
can do. So a release is breaking if it removes or renames a telemetry
channel, a command, a parameter or an error code, and also if it *narrows* a
declared numeric range: a caller that read a value and writes it back must
not start failing. Adding any of those is a minor release.

Every number parameter declares a range, and the ranges are deliberately
wide. Nothing below this layer range-checks — the firmware answers
`ASC 0 set OK` to settings it silently ignores — so a declared bound is this
worker's own typo guard, and its only real failure mode is being too narrow.

Cutting a release is three steps, and the first is the one that matters:

```bash
MDK_REPO=../mdk npm test          # lint, contract, unit, integration
MDK_REPO=../mdk npm run test:e2e  # Kernel, HRPC and the client SDK
npm version minor                 # or patch/major, per the rule above
git push --follow-tags
```

`npm test` is what catches contract drift, in two places. `validate:contract`
fails if a declared handler no longer resolves, if a number parameter has lost
a `min`/`max`, or if an `ERR_` code is declared without being throwable — or
thrown without being declared. The unit suite additionally fails if a health
alert code is declared that no code path can raise. Fix the drift rather than
the check.

Nothing is published to the npm registry yet: MDK itself is resolved from a
checkout by path, so this package is consumed the same way. A release is a
git tag and a CHANGELOG entry.

Confirming one of the provisional constants in
[`lib/provisional.js`](lib/provisional.js) is a deliberate one-line edit —
set `confirmed: true` and cite the source in the comment. Do not quietly
adjust a value and leave it marked unconfirmed, or the reverse.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
