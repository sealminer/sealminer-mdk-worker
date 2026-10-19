# Changelog

Notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with one thing
worth stating plainly, because this package's public surface is not only its
code:

**`mdk-contract.json` is part of the API.** A consumer, and an AI operator,
reads it to know what the device can do. So removing or renaming a telemetry
channel, a command, a parameter or an error code is a **breaking** change.
Adding any of them is a minor change. Every number parameter declares a
numeric range, and **narrowing** one is breaking too: a caller that reads a
value and writes it back must not start failing.

## [Unreleased]

### Added

- **`warn.fields_unreadable` — a stats key that stopped arriving is now
  reported instead of left as a silent null.** Nine device-level fields that
  all six measured products send, on every firmware from 2026040101 to
  20260915FF and in every state, are checked each cycle: temperature, target
  temperature, power limit, model, firmware, chip count, board count, uptime
  and PSU model. Any of them reading null raises one warning naming all of
  them.

  This closes the last kind of firmware drift nothing else catches. Capability
  discovery answers which *commands* exist, never which *keys* a stats reply
  uses — and the parser reads keys by name, so a rename makes a channel read
  null, which is also the honest answer for "not reported" and therefore
  invisible. Firmware has renamed keys repeatedly (`Chip voltage` to
  `Chip Voltage`, `BDMiner` to `Bdminer`). Previously that surfaced as an
  empty dashboard; now it surfaces as a warning that names the field and
  points at the diff procedure in FIRMWARE.md.

  A warning rather than an alert, and the miner stays OK: the device is fine,
  this worker's description of it is not. Fields that are legitimately absent
  are excluded — `Fan Count` on water-cooled products, `PSU Temp HOT` which
  no measured product sends, `MHS(Rated)` which reads 0 on two of them — and
  the check is skipped on a clipped reply, which `warn.stats_truncated`
  already covers.

### Fixed

- `info.liquid_cooled` rendered an unreadable temperature as `temp nullC`.
  Surfaced by the warning above while testing it.

- **Four commands told the reader the opposite of what the contract declares.**
  `setPowerLimit`, `setPreheat`, `setIdleFanTimer` and
  `setStratumDisconnectTimeout` still carried `NO RANGE IS DECLARED OR
  ENFORCED` in their `constraints` after the ranges were restored, and
  `setPreheat` also still said none of the documented limits were refused. Each
  now states its declared range, and `setPreheat` spells out the rule its
  handler actually applies: `bootPreheatTimeout` is accepted as exactly `-1` or
  `300` to `600`, and `0`-`299` is refused rather than silently raised to 300
  by the firmware. The declared minimum of `-1` is wider than that because the
  contract format carries only `min` and `max` and cannot express a disjoint
  range.

  The CHANGELOG's own preamble said no parameter declares a numeric range,
  which contradicted `README.md`. Both now say the same thing: narrowing a
  declared range is a breaking change.

  `npm run validate:contract` now enforces the agreement, because prose and
  declarations have drifted apart once already. A command that declares a
  numeric bound must state it, must not claim it has none, and any range its
  text spells out must be the range the contract declares — which also fails
  when the declaration is changed and the text is left behind.

### Changed

- **When a write takes effect is no longer reported per device.**
  `capabilities.settingsApplyImmediately` is gone, and every mining-setting
  write now returns the same shape: `accepted`, `appliesOn` and the
  `confirmWith` channel, with no `pending` flag. `FW.SETTINGS_AUTO_RESTART`
  and its gate are removed from `lib/capabilities.js`.

  The reasoning: the API exposes no pending value, so the device could never
  confirm this — the flag was derived from a firmware version, which is a
  guess dressed as a fact. The device behaviour has not changed and is still
  covered by tests: on builds below roughly 2026060101 the firmware stores a
  mining setting and applies it at the next bdminer restart.

  The cost, stated plainly because it is the more dangerous direction of
  error: on an older build the confirming channel can keep showing the old
  value, and a caller who does not know that can read an armed write as a
  failed one and re-send it. That warning is now carried in the contract's
  `constraints` for `setPowerMode`, `setPowerLimit` and `setFastRaiseFreq`
  as a family-level fact rather than a per-device claim.

- **Two static assumptions are now deliberate rather than provisional.**
  `SERIES_MODES` stays hardcoded — which `workmode` values each series
  accepts is a settled fact about the product line, not something to
  discover. And `reboot`, `restartMiner` and `updatepools` are assumed
  present on every miner: they are top-level 4028 commands, absent from
  `ascset help`, and probing `reboot` to find out would reboot the miner.

- **Two parameter envelopes widened, and two unmarked guesses registered.**
  `setStratumDisconnectTimeout.seconds` goes from 30-3600 to 1-86400, and
  `setIdleFanTimer`'s `interval` and `onDuration` from 1-3600 and 0-3600 to
  1-86400 and 0-86400. Neither old bound had evidence behind either end.

  The reasoning, which is the part worth keeping: nothing below this layer
  range-checks. The firmware answers `ASC 0 set OK` to settings it silently
  ignores — a real A2 accepted 3000, 4200 and 4400 W and changed nothing — so
  a declared bound is this worker's own typo guard, not a correctness
  guarantee, and the error is one-sided. Too wide catches only absurd values;
  too narrow refuses a legitimate setting, which has happened twice against
  real hardware. So the envelopes are deliberately generous.
  `setPowerLimit.watts` goes to 2000-20000: 12000 was tried first and left
  only about 11% above the highest setting measured (10800 W), the same thin
  margin behind both earlier failures, and products do shift upward — one A2
  Pro Hydro moved 7800 to 9500 W across a single firmware upgrade. At 20000 a
  missing or extra digit is still rejected while no plausible product sits
  outside the bound.

  `IDLE_FAN_TIMER_INTERVAL_S` and `IDLE_FAN_TIMER_ON_DURATION_S` are now in
  `lib/provisional.js`. They were guesses all along, but the contract carried
  the numbers while nothing declared them, so `unconfirmed()` never listed
  them and `npm run validate:contract` never warned. Provisional values go
  from 8 to 10 as a result — the count rose because the bookkeeping got
  honest, not because anything new was invented.

  Bounds the vendor document actually states are not treated as guesses:
  `setPreheat`'s temperature (0-35) and timeout (-1, or 300-600) come from
  SealMinerAPI_V0.5 §4.1.6 and the fan speed percentage (0-100) from §4.1.12.

- `MAX_POOLS` is confirmed at three by Bitdeer engineering. The document says
  only "at least one pool" (§3.5.7), but its own `config` example reports
  `"Pool Count":3`.

- **The publishing account is decided: `github.com/sealminer`.** `repository`,
  `homepage` and `bugs` in `package.json`, and this file's compare links, point
  there. `.github/CODEOWNERS` carries the organization but stays commented out:
  neither the organization nor its review team exists yet, and an entry naming
  an account the host cannot resolve fails silently — no review is requested
  and nothing says so — so it is left inactive rather than filled in with a
  plausible guess.

- **The copyright holder is stated as the legal entity: STRAITDEER PTE. LTD.**
  `NOTICE` and `package.json`'s `author` name it. The trademark clause keeps
  the "Bitdeer" and "SealMiner" names, because that clause exists to identify
  those marks, and `metadata.provider` stays `bitdeer`, which is an identifier
  consumers match on rather than an attribution. This matters downstream:
  Apache-2.0 section 4 requires anyone redistributing this package to carry
  `NOTICE` along with it, so the name in it travels.

- **`npm run console` starts the evaluation console.** The README asked a
  reviewer to type `MDK_REPO=../mdk node scripts/dev-console.js`; the script
  already defaults to MDK as a sibling directory, so the variable was only
  needed for a checkout somewhere else. Arguments pass through:
  `npm run console -- --all` boots one mock per product. Nothing about the
  console itself changed — this is the documented way in rather than a new one.

- **`SECURITY.md` names a working address.** The vulnerability channel was a
  `<SECURITY-CONTACT@bitdeer.com>` placeholder with a note to maintainers that
  it had to be filled before the repository went public. It is now
  wei.zhou@bitdeer.com, and the note is gone with it. This is the only route
  by which a defect in this package can be reported privately.

- **Verified against MDK v0.10.0 as well as v0.8.0.** Nothing in this package
  needed changing: lint, the contract against MDK's published schema, 195 unit
  and 21 integration tests, the 13-check Kernel chain and MDK's own 61-check
  smoke harness all pass on both. Between those releases `mdk-worker` and
  `kernel` changed no code at all, and `client/index.js` only gained a `code`
  property on the errors it rejects with.

  Two things that follow from measuring rather than assuming. The finding
  about command results — Kernel dropping a terminal command, and
  `createMdkClient` carrying no status method — reproduces identically on
  v0.10.0, so README, this file and the e2e check now name both versions
  instead of one. And v0.10.0 removed the duplicate copy of
  `mdk-contract.schema.json` under `packages/mdk-skill/`, leaving the
  `backend/core/mdk-worker` one; `npm run validate:contract` checks whichever
  paths exist, so it reports `schema mdk-worker: valid` with no warning on
  0.10.0 and still checks both on 0.8.0. The comment that described the two
  copies as permanent is corrected.

  `README.md` now states the verified versions where it states the Node one,
  since "any recent tag" told a reviewer nothing about what was actually run.

- **README's test counts were two suites behind.** The table a reviewer reads
  to decide what this package is said 183 unit tests and 879 asserts against
  an actual 195 and 1051, and 18 integration tests and 139 asserts against 21
  and 162 — understating itself, which is the harmless direction but still
  wrong. The 13-check Kernel chain and the 9-combination series × firmware
  matrix were correct.

  The four remaining `node scripts/dev-console.js` invocations now read
  `npm run console`, matching the one the evaluation section was changed to
  earlier. One document telling a reviewer two different ways to start the
  same thing is how they end up wondering which is current.

- **The console boots all seven products by default.** Four of them did, and
  the other three sat behind `--all`: both halves of the firmware pair whose
  older build *has* `resume`, and the A4 Pro Air that reports `MHS(Rated)` as
  0. Those are the three devices that demonstrate the most, so a reviewer
  following the README met the short fleet. `--all` is still accepted and now
  does nothing, so a command or script that passes it keeps working. The
  selector is grouped by series with the firmware pair last.

  Two statements about that flag were wrong independently of this change, and
  are gone with it. README's fleet table listed four devices and marked
  `SM-A4-004` as `--all`-only; it now lists all seven. And the paragraph
  describing what `--all` added named "an A2 whose stats reply is deliberately
  clipped" — a synthetic device removed from the console some time ago,
  because no measured miner clips and the handling is covered by tests.

- **The install steps were two packages short of what they promise.** Run from
  an empty directory exactly as written, the four commands boot the console
  and pass five of the six suites — and the sixth, the Kernel chain, fails
  with `Could not load backend/core/mdk`. It needs `mdk` and `client` as well
  as `mdk-worker` and `kernel`, which nothing said. A reviewer pressing
  **Run all** would have met a red suite on a package that passes.

  Found by cloning the delivery tree into an empty directory and following
  README literally, which is the only way to see what a first-time reader
  sees. Everything else in that path worked: `npm install` reported 0
  vulnerabilities, all seven mocks booted, every channel answered (29 passing
  on an air-cooled A2, 29 with one null — `fan_speed` — on a water-cooled A4),
  and the other five suites passed from the page.

### Fixed

- **Cooling is no longer treated as a property of the series.** The mock kept
  its hardware profile per series and hardcoded A2/A3 as air-cooled and A4 as
  water-cooled. Every series in fact ships both, confirmed on an A2 Pro
  Hydro, an A3 Pro Hydro and an A4 Pro Air, so the profile is now per
  product (`{ series, cooling }`) and all six measured products are
  reproducible. The consequence of the old shape was that the two
  `Liquid Cooling` branches in `lib/health.js` could only ever be exercised
  on one series, and the console showed a misleading product photo — an air
  A2's picture for a water-cooled A2. A product with no photograph now shows
  none rather than one of the wrong cooling type.
- **The mock reported an air-cooled control board for every product.**
  `Ctrl Board` encodes the cooling type (`taurus_air_v1.1`,
  `taurus_hydro_v1.2`, …) and was pinned to the air A2's value. Now measured
  per product, and asserted against the cooling type in the tests.
- **The console overrode every product's measured chip count** with an
  arbitrary 36. The per-chip keys are what make a reply large and they stay
  off by default, so the override bought nothing.
- **`test-live-readonly.js` hid warn- and info-level health details.** It
  printed `health.alerts`, which carries alert severity only — so a live
  check against a miner on an unmeasured firmware showed nothing about it.
  It now reports every detail with its severity, plus whether the capability
  verdicts were read from the device or assumed from the version table.

### Added

- Telemetry channel report includes `liquidCooling`, `capabilitySource`,
  `firmwareNewerThanKnown` and the discovered subcommand count in the
  live read-only check.
- A test walking all six products asserts the invariant that no series is
  single-cooling, and that a product reporting `MHS(Rated)` as 0 is not
  mistaken for a broken miner.

### Notes from hardware

- `MHS(Rated)` reads **0** on an A2 Pro Hydro and an A4 Pro Air while
  `MHS(Ideal)` is sane. Nothing in this worker consumes it and no contract
  channel exposes it, so there is no defect to fix — but it is not a usable
  rating, and the mock now reproduces the zero.
- An A4 Pro Air reports its firmware as **`20260915FF`**, not a 10-digit
  build. Already handled — 8-to-10 leading digits are taken and padded, so
  the comparison rounds down rather than failing — and now pinned by a test
  against the measured string.
- A firmware upgrade landed on an A2 Pro Hydro **mid-session**: 2026071500
  to 2026092000, with its power limit changing from 7800 W to 9500 W and its
  4028 API unreachable for about two minutes across the reboot. This is the
  case `history`'s per-sample `firmware` column exists for, and it is why a
  per-device power range would go stale on its own.

## [0.1.0] — 2026-09-22

First release. Supports SealMiner **A2, A3 and A4** over the bdminer 4028
JSON API: 29 telemetry channels, 14 commands, 19 health alert codes, one
runtime dependency.

Validated against live miners — since extended to six, one per product
across three series and both cooling types — and the findings from that are
what most of the code is for.
Where the hardware disagreed with the API document,
[`mock/fixtures/README.md`](mock/fixtures/README.md) lists the field-level
corrections, and the reasoning behind each behavioural one sits in the
comment next to the code it shaped: `lib/capabilities.js` on `Model` being a
product name, `lib/health.js` on liquid cooling, `lib/provisional.js` on the
powerlimit envelope, `lib/api-client.js` on ascset values having to be
strings.

### Behaviour worth knowing before you use it

- **Every write is asynchronous.** The firmware replies before it executes,
  so a successful reply means ACCEPTED, not applied. Each command reports
  what was accepted, when it applies and which channel confirms it, and never
  claims an effect it has not observed.
- **On firmware below 2026060101, mining-setting writes are deferred** to the
  next bdminer restart, and no API field reports the pending value. The
  result then carries `pending: true`; read `capabilities.settingsApplyImmediately`
  before assuming a write is live.
- **Unknown is `null`, never `0`.** A field the firmware did not send reads as
  null, so a missing value cannot be mistaken for a real reading of zero.
- **Capability belongs to the device, not the model number.** Series and
  firmware gate five commands and the mining modes; read the `capabilities`
  channel rather than inferring from `Model`.
- **Liquid-cooled miners report no fans**, which is indistinguishable from
  total fan failure without the firmware's own `Liquid Cooling` flag. Health
  reads that flag, reports `info.liquid_cooled`, and judges overheating
  against an absolute threshold instead of the control target.

### Known limitations

- **Nine constants in `lib/provisional.js` are unconfirmed by SealMiner** and
  `npm run validate:contract` lists them on every run. `LIQUID_OVERHEAT_ALERT_C`
  is the one to treat with most suspicion: it is a guess, and has never been
  checked against an actually overheating water-cooled miner.
- **The declared `setPowerLimit` range is an envelope across the family**
  (2000–12000 W), not any one product's real range, because the contract is
  published once for every model. Kernel's pre-dispatch check uses it as a
  coarse guard; read the `power_limit` channel for what a given miner is
  actually set to.
- **Writes that restart bdminer are not verified on A3/A4 hardware.** They
  cost a re-tuning cycle on a producing miner, so they are covered against
  mocks on both firmware branches instead.
- **A command's terminal result is not readable by a remote consumer** on MDK
  v0.8.0 and v0.10.0 — Kernel deletes the entry on reaching a terminal state and
  `createMdkClient` wraps no status method. This is why every command names a
  `confirmWith` channel; see README.
- One real A2 returned a malformed JSON reply roughly once in forty reads.
  The cause is unexplained; reads retry once, writes never do.

[Unreleased]: https://github.com/sealminer/sealminer-mdk-worker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sealminer/sealminer-mdk-worker/releases/tag/v0.1.0
