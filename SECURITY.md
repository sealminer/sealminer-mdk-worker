# Security

## Reporting a vulnerability

Report suspected vulnerabilities in this package **privately**, to
<wei.zhou@bitdeer.com>.

Please do not open a public issue for a security report. Include, as far as
you have it:

- what an attacker can do, and what access they need to start
- the miner series and firmware version, if it is device-specific
- a request or configuration that reproduces it

We will acknowledge receipt, tell you whether we can reproduce it, and agree
a disclosure timeline with you.

## What is in scope

This package is a **device worker**: it translates between MDK's protocol and
the SealMiner 4028 JSON API. The interesting boundary is therefore what it
sends to a miner and what it reports back up.

In scope:

- any path by which a caller can reach a miner with a command this package
  should have refused — an unvalidated parameter, a bypassed capability gate,
  a bypassed cooldown
- a telemetry channel that discloses more than the device reading it reports,
  including anything from the device configuration
- a parser or transport defect reachable from a device reply, such as one
  crashing the worker or corrupting another device's state
- cross-device leakage: anything from one miner appearing in another's
  telemetry, audit trail or store

Out of scope, because they are not this package's to control:

- **the 4028 API has no authentication.** Anyone who can route to a miner's
  port 4028 can command it directly, without MDK and without this worker.
  Restricting that is network design, not something a worker can enforce.
- **authentication, authorization and rate limiting**, which MDK places in the
  Gateway plugin layer — an extension point a deployment writes and owns.
  Neither Kernel nor a Worker provides them, so this package cannot enforce
  them however it is configured; a host must supply them above it. See
  [Safety](README.md#safety).
- defects in MDK itself — report those to Tether.
- the miner's own web interface and firmware.

## What this package does and does not hold

It holds **no credentials**. The 4028 API takes none, so nothing secret
belongs in a device's `config`, and there is nothing for a telemetry channel
to disclose. If a future firmware adds authentication, read it from the
ambient `env`, never from `opts`, and keep it out of logs.

One consequence is worth stating because it is easy to get wrong: MDK's
runtime provides a **builtin `health` channel** for any plugin that does not
declare its own, and that builtin answers with the device's `opts` included.
A worker whose device config holds a password would disclose it to every
consumer that pulls `health`. This package declares its own `health` handler,
which returns a verdict and nothing else; `tests/integration/runtime-v2.test.js`
asserts that the device options are absent from it.

## Physical-command safety

Commands here change physical state — power, pools, network, reboot. The
guard in `lib/command-guard.js` validates parameters, gates on the device's
real capabilities, enforces one-in-flight and a declared cooldown, and emits
a structured audit event for every attempt. Two properties matter for anyone
reasoning about abuse:

- **a write is never retried automatically.** A timed-out write has an
  unknown physical outcome, and repeating it can duplicate the operation.
- **cooldowns survive a restart** when `dbPath` is configured. Without it
  they are process-local, and restarting the host clears them.

## Supported versions

Pre-1.0. Fixes land on `main` and there is no back-porting. Pin a commit if
you need stability, and read the release notes before upgrading.
