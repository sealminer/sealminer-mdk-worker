# Firmware changes

Firmware is the one thing under this worker that moves on its own. This is
what it has actually done, how the code copes, and what to do when a new
build arrives.

## What firmware has changed so far

Not hypotheticals — each of these was found by pointing `scripts/dump-stats.js`
at a real miner and diffing the reply against `mock/fixtures/`.

| Change | Example |
| --- | --- |
| A field is renamed | `Chip voltage` → `Chip Voltage`; `BDMiner` vs `Bdminer` |
| A field's type drifts | the same field arrives as an integer, a boolean or a string |
| Undocumented fields appear | ten of them, including `Liquid Cooling`, which is how water-cooled miners are told apart |
| A field is reported as 0 rather than omitted | `MHS(Rated)` reads 0 on an A2 Pro Hydro and an A4 Pro Air while `MHS(Ideal)` is sane, so the field is not a usable rating |
| A version string stops being a 10-digit build | an A4 Pro Air reports `20260915FF`; 8-to-10 leading digits are taken and padded, so the comparison rounds down rather than failing |
| **A command is removed** | `resume` was gone from 2025080401 to 2026053100, then restored |
| **A behaviour changes** | mining-setting writes were deferred to the next bdminer restart; from ~2026060101 the firmware restarts bdminer itself |

The last two matter most, because they break the assumption a version table
quietly makes: that features are only ever added.

## How the code copes

Four mechanisms, each for a different kind of uncertainty.

**The device answers where it can.** `ascset help` returns the subcommand list
this firmware actually has, so for the eleven commands that map to an ascset
subcommand the miner itself is the authority and the version table is only a
fallback. Verified on six miners across three series and both cooling types:
an A2 on 2026040101 omits `resume` exactly as the removal window says, while
every later build lists it, and the three newest — an A2 Pro Hydro on
2026092000, an A3 Pro Hydro on 2026091400 and an A4 Pro Air on 20260915FF —
each answered with the same thirteen subcommands and reported
`capabilitySource: device`. `capabilities.commands[name].source` says
`discovered` or `table` for every command, so a consumer can see which
verdicts were asked for and which were assumed.

**What the table still covers is now small, and shrinking.** `ascset help`
gives subcommand *names* only, so three things stay static:

- **Which values `workmode` accepts.** Hardcoded in `SERIES_MODES` by
  decision: A2 has `low_power` and A3/A4 do not, and that is a settled fact
  about the product line rather than something worth discovering.
- **That `reboot`, `restartMiner` and `updatepools` exist.** They are
  top-level 4028 commands, absent from `ascset help`, and the API has no
  command listing. Assumed present on every miner by decision — probing
  `reboot` to find out would reboot the miner.
- **The envelopes on writable parameters.** Four of them are guesses, listed
  by `npm run validate:contract` on every run. They cannot be measured:
  `ascset powerlimit` answers `ASC 0 set OK` for every value and applies some
  of them, so the firmware's accepted range cannot be probed by observing
  what it refuses, because it refuses nothing. They are declared anyway
  because MDK's build guide requires the handler to reject out-of-range
  values and Kernel enforces a bound only when one is declared — and
  deliberately wide, since too narrow refuses a real setting while too wide
  only catches a typo. Three more bounds come from the vendor document and
  are not guesses at all.

**Nothing is version-keyed that the device could have answered.** The one
remaining firmware-keyed behaviour used to be whether a mining setting
applies at once or at the next bdminer restart. The device cannot report it
(the API exposes no pending value), so it was a version-table guess, and it
is no longer reported at all. Every write names the channel that confirms it
and leaves the timing to the miner. The cost is real and worth stating: on an
older build a readback can keep showing the old value for a while, and a
caller who does not know that can read a write as failed when it is armed.
That warning lives in the contract's `constraints` for `setPowerMode`,
`setPowerLimit` and `setFastRaiseFreq`.

**An unmeasured build says so.** Firmware newer than `NEWEST_KNOWN_FIRMWARE`
sets `capabilities.firmwareNewerThanKnown` and raises
`warn.firmware_unverified`. Nothing is refused on that basis — the point is
only that a stale capability view must not pass for a complete one. It is a
warning, not a degradation: a fleet that just took an upgrade should not go
DEGRADED, or operators learn to ignore the channel.

**Nothing claims an effect it did not observe.** Every write reports what was
accepted, when it applies and which channel confirms it. A firmware that
changes what a command does cannot make this layer lie, because it never
asserts success — it points at the readback. That is also the only protection
against a command that reports success and does nothing, which `powerlimit`
on 2026040101 does.

## When a new build arrives

Every tool below already exists. What was missing was the order.

```bash
# 1. capture the new firmware's replies (writes outside the repo, redacts pool users)
node scripts/dump-stats.js <address> --out /tmp/fw-new

# 2. diff against the calibrated captures — renames, new fields, type drift
diff <(jq -S . mock/fixtures/stats.json) <(jq -S . /tmp/fw-new/stats.json)

# 3. does every channel still resolve?  fails if any one errors
MDK_REPO=../mdk node scripts/test-live-readonly.js <address> --series A2

# 4. do the gates still refuse from the right layer?  11 checks,
#    no physical state changes, safe on a producing miner
MDK_REPO=../mdk node scripts/test-live-rejections.js <address> --series A2

# 5. what does the firmware itself say it has?
node -e "require('./lib/api-client').createClient({host:'<address>'}).ascsetHelp().then(s=>console.log(s.msg))"
```

Then, in the repo:

1. If a subcommand appeared or disappeared, the discovery path already handles
   it at runtime — but update `FW` in `lib/capabilities.js` anyway, so the
   fallback stays honest and `warn.firmware_unverified` goes quiet.
2. If a field was renamed or changed type, fix the parser and add the case to
   `tests/unit/parser-stats.test.js`. Read both spellings with `??` rather
   than switching, so one build's fix does not break the other's.
3. Update `mock/fixtures/` and the `mock/state.js` series profile, and note
   the discrepancy in `mock/fixtures/README.md`. The mock is the ground truth
   the tests run against; a mock that is more permissive than the firmware is
   how a real behaviour gets mistaken for a no-op.
4. Add the build to the matrix in `tests/unit/matrix.test.js`.
5. Write it up in `CHANGELOG.md`.

## Noticing an upgrade you were not told about

`history` records the firmware string with every sample, so a fleet that took
an upgrade under a running worker is findable from the worker's own store
rather than noticed when telemetry starts looking odd:

```sql
SELECT device_id, firmware, MIN(ts), MAX(ts)
FROM telemetry GROUP BY device_id, firmware ORDER BY MIN(ts);
```

This only works where `dbPath` is configured. Without it the store is
in-memory and resets with the process.

## What we need from the firmware team

These would shrink everything above. In priority order, most valuable first.

1. **Refuse a value you will not apply.** The one that matters most. Today
   the firmware answers `ASC 0 set OK` to settings it silently ignores: a real
   A2 accepted 3000, 4200 and 4400 W and changed nothing. So a success reply
   is no evidence at any value, and the declared envelope cannot help —
   4200 W sits inside any plausible range and was still ignored. A refusal,
   with a code, would make the firmware the authority in fact rather than
   only in principle, and would let a caller distinguish "rejected" from
   "accepted and pending".

   Exact per-product ranges would be worth much less than this. They would let
   the envelope be narrowed, but narrowing is a breaking change for a caller
   that reads a value and writes it back, and a range does not stay correct
   anyway: an A2 Pro Hydro was read twice in one session, 7800 W then 9500 W,
   after a firmware upgrade landed under us.
2. **Report the pending value of a setting that has not applied yet.** Second
   most valuable. On older builds a mining setting is stored and applied at
   the next bdminer restart, and nothing in the API reports what is stored —
   so a readback showing the old value is indistinguishable from a write that
   did nothing. One readable pending field would make the confirming channel
   sufficient on every firmware.

   A flag saying *whether* a build defers would not help much: it is a
   property of the build, so a version table can guess it, and guessing is
   exactly what was removed. The pending value is the part only the device
   can supply.
3. **Keep adding capability flags like `Liquid Cooling`.** This one already
   works and is worth saying so: it is the only reliable way to tell a
   water-cooled miner from one whose fans have all failed, and it is what
   stopped a healthy A4 Ultra Hydro being reported as overheating. Every
   field of this kind the firmware reports is a version gate we do not have
   to maintain.

   It has since earned its keep twice over. Every series turns out to ship
   both an air-cooled and a water-cooled product — an A2 Pro Hydro and an A3
   Pro Hydro report `true`, an A4 Pro Air reports `false` — so cooling cannot
   be inferred from the series, the product name or the ASIC. Only the flag
   answers it. (`Ctrl Board` also encodes it, as `taurus_air_*` or
   `taurus_hydro_*`, but that is a string pattern rather than a declared
   field and nothing depends on it.)

Nine constants in `lib/provisional.js` are still unconfirmed and
`npm run validate:contract` lists them on every run. The one to treat with
most suspicion is `LIQUID_OVERHEAT_ALERT_C`: it is a guess, and has never
been checked against a water-cooled miner that was actually overheating.
