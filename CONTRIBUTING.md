# Contributing

Patches and issues are welcome. Security reports go privately through
[SECURITY.md](SECURITY.md), not as public issues.

## Before you send a change

```bash
MDK_REPO=../mdk npm test          # lint, contract, unit, integration
MDK_REPO=../mdk npm run test:e2e  # Kernel, HRPC and the client SDK
```

Both run against the bundled mock. No miner is needed for any of it.

## Three rules the reviews will hold you to

These are not style preferences. Each one is here because breaking it caused a
real defect against real hardware.

**Unknown is `null`, never `0`.** A field the firmware did not send must not
arrive as a zero, because a consumer cannot tell that apart from a real
reading of zero. The water-cooled A4 has no fans at all; `fan_speed` is
`null` on it, and a dashboard that renders `Number(x) || 0` shows "0 RPM" —
which reads as failed fans.

**Never claim an effect you did not observe.** Every write on this API is
asynchronous: the firmware replies before it executes, so a successful reply
means *accepted*, not *applied*. Commands report what was accepted, when it
applies and which channel confirms it. An earlier version checked the
readback inside the command and failed writes that had in fact been accepted
and stored — the more dangerous error, because an operator who reads "not
applied" walks away having left a change armed.

**`mdk-contract.json` is the public API, not an implementation detail.** A
consumer and an AI operator both read it to learn what the device can do. So
removing or renaming a channel, command, parameter or error code is a
breaking change — and so is *narrowing* a declared numeric range, because a
caller that read a value and writes it back must not start failing. That has
happened twice with `setPowerLimit` against real hardware: `[1500, 4200]`
against a shipped A2 at 4300 W, then `4600` against an A4 Ultra Hydro at
10800 W.

**Declare a range on every number, and declare it generously.** MDK's build
guide requires the handler to reject out-of-range values, and a declared
bound is the only validation Kernel performs pre-dispatch. Nothing below this
layer checks at all — the firmware answers `ASC 0 set OK` to settings it
silently ignores — so the bound is a typo guard rather than a correctness
guarantee, and the error is one-sided: too wide catches only absurd values,
too narrow refuses a real setting.

## Where things live

| | |
| --- | --- |
| `lib/` | the SealMiner SDK — parsers, transport, capability table, health rules. No MDK dependency; usable on its own. |
| `src/` | the MDK plugin — one file per telemetry channel and per command. |
| `mock/` | a standalone 4028 simulator, plus verbatim captures from real miners in `fixtures/`. No MDK dependency. |
| `tests/unit` · `integration` · `e2e` | one directory per layer. |
| `scripts/` | tools, not tests: the console, the mock runner, the contract validator, and the `test-live-*.js` probes — the only things here that need a real miner. |

CI enforces that `lib/` and `mock/` never import MDK. `lib/` is meant to be
usable without it, and a mock that imports the worker's own code could only
ever prove the worker agrees with itself.

## Changing behaviour that depends on firmware

Read [FIRMWARE.md](FIRMWARE.md) first. Two things bite people:

- **Add a value, do not switch on one.** Read a renamed field as
  `d['New Name'] ?? d['Old Name']`, so fixing one build does not break
  another.
- **Make the mock refuse what the firmware refuses.** The mock enforces the
  firmware gates itself, deliberately duplicating the version logic. A mock
  more permissive than the device is how a real behaviour gets mistaken for a
  no-op — which is exactly what happened with `workmode sleep`.

## Confirming a provisional constant

Nine values in `lib/provisional.js` are placeholders awaiting confirmation
from SealMiner, and `npm run validate:contract` lists them on every run.
Confirming one is a deliberate edit: set `confirmed: true` and cite the
source in the comment. Do not quietly change a value and leave it marked
unconfirmed, or the reverse.
