'use strict'

// EVERY write on this API is asynchronous: the firmware replies first and
// executes afterwards. 'ASC 0 set OK' (code 119) means the request was
// ACCEPTED, not that it has been applied — confirmed by the vendor and
// visible in reboot/restart, where the reply arrives before the device even
// goes away.
//
// So this worker never claims a write was applied, and never fails a command
// because a readback has not caught up: any such verdict would be premature
// by construction. What it does instead is say what was accepted, and where
// and when the effect will become visible. Confirming it is the caller's job,
// one or two telemetry cycles later — which is what the contract's examples
// tell an operator or agent to do.
//
// The same answer for every firmware, by decision: when a mining setting
// takes effect is no longer distinguished per device. Older builds store the
// value and apply it at the next bdminer restart, and the API cannot read the
// pending one back, so this was never a fact the device could supply — only
// one a version table could guess at. Rather than report a guess, every write
// names the channel that confirms it and leaves the timing to the miner.
//
// The consequence a caller has to know is in the contract's constraints for
// setPowerMode, setPowerLimit and setFastRaiseFreq: on an older build the
// readback can keep showing the old value for a while, and that means armed,
// not ignored.
const describeSettingWrite = (channel) => async (requested) => ({
  accepted: requested,
  appliesOn: 'asynchronously, after this reply',
  confirmWith: channel
})

/** For writes with no readback at all: say so rather than implying one. */
const describeBlindWrite = (what) => async (requested) => ({
  accepted: requested,
  appliesOn: 'asynchronously, after this reply',
  confirmWith: null,
  detail: `the API exposes no readback for ${what}, so this cannot be confirmed through it`
})

module.exports = { describeSettingWrite, describeBlindWrite }
