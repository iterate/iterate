# Defect: a worker deploy leaves the device publishing into a socket nobody reads

**Status:** ROOT-CAUSED and fixed; awaiting proof on the reflashed board.
Raw evidence: `evidence/waveshare-capabilities-20260803/stale-socket-20260804/`. **Severity:** the device is unreachable until someone power-cycles
it, while every local indicator says it is healthy.

## What happened

`apps/os` was deployed to preview_3 at ~04:08Z on 2026-08-04. From that moment
the project reported `capability "kit.waveshare" is offline` on every call, for
more than 80 seconds of bounded polling and for several minutes in total.

The device did not agree. Its console, read over ten seconds while the capability
was offline:

```
I (3218750) iterate-voicelab: pulse loops=640460 outbox=0/64 inPub=2985 inCon=2985
                              sent=3778 frames=0 | batches=355 rx=2746 gaps=0
                              played=1835 conceal=6 under=0 ringMs=0
```

Uptime 3,218,750 ms (~54 minutes). `loops` advancing, `sent` climbing, `outbox`
empty at 0/64, no gaps, no underruns. By every local measure it was working: it
believed it was publishing, and its writes were succeeding — into a socket whose
reader had gone away with the old isolate.

Recovery required a hard reset of the board. It came back at `uptimeMs 23141`
with `transport: "ready"` and mounted immediately.

## Why this is a defect and not a note

A device that cannot notice it has been orphaned is a device that needs hands.
Everything the firmware exposes — counters, pulse log, outbox depth — said
"fine", so no amount of remote observation would have found it; the only symptom
was on the other side of the connection. Worse, this shape is not exotic: any
worker deploy produces it, and deploys are routine.

## What the firmware already has, and why the evidence is confusing

This exact failure is anticipated in the code. `main.c` (waveshare target):

```c
/*
 * NOBODY HAS ASKED US FOR ANYTHING IN A LONG TIME.
 *
 * The downlink watchdog needs a call in progress and the liveness one keys on
 * pings, so an idle device whose mount has gone offline server-side is watched
 * by neither: the socket stays healthy, the pings keep answering, and every RPC
 * fails until somebody power-cycles it.
 */
if (runtime.voicelab_generation == runtime.connection.generation &&
    runtime.last_served_ms != 0U &&
    iterate_kit_voice_elapsed_ms(now, runtime.last_served_ms) > IDLE_REMOUNT_MS) {
  ESP_LOGW(tag, "no RPC served in %us — replacing the session to re-mount", ...);
  runtime.last_served_ms = now;
  iterate_kit_esp_idf_itx_transport_request_restart(&runtime.transport);
}
```

`ITERATE_KIT_VOICE_IDLE_REMOUNT_MS` is **90000** (`voice_device_profile.h`), and
`control_recovery.c` reasons correctly about why it counts _application
dispatches_ rather than pings: "a transport can keep answering RFC 6455 and
Cap'n Web pings after the server-side capability host has evicted its live
provider."

So detection should have fired. The last RPC served was roughly fifteen minutes
before the reset — an order of magnitude past the window.

That leaves two candidate causes, and they need different fixes:

1. **Detection did not run.** The guard `voicelab_generation == connection.generation`
   or `last_served_ms != 0U` excluded this state, so the timer never armed.
2. **Detection fired and recovery did not work.** `request_restart` replaced the
   session every 90 s and each new session failed to re-mount — retrying
   silently, because `last_served_ms = now` resets the window on every attempt
   whether or not the remount succeeded.

The ten-second console sample cannot distinguish them: at a 90 s cadence it would
most likely miss the warning either way. **Do not guess between these.** The
repro below decides it.

## It reproduced spontaneously, with no deploy at all

At 04:26Z on 2026-08-04, mid-capability-proof, the device dropped again — this
time with nothing deployed. That kills the original theory that the trigger was
an isolate going away; a deploy merely makes it likely.

Captured on both clocks for 189 seconds (04:27:20 → 04:30:29):

| source                   | evidence                                                                         |
| ------------------------ | -------------------------------------------------------------------------------- |
| host poll, 24 samples    | `capability "kit.waveshare" is offline`, `capabilities: 1`, unbroken             |
| stream `runtimeState()`  | **`connectionCount: 0`** — the server held no socket at all                      |
| device serial, 190 lines | uptime climbing past 4.17 M ms, `sent` climbing, `outbox 0/64`, `inPub == inCon` |
| device serial            | **not one** watchdog, reconnect, remount or error line                           |

Still offline at 04:33:46 — over seven minutes, no recovery, no intervention. So
the answer to "does recovery restore the same capability on its own?" is **no**.

## Root cause: the device renewed its own liveness lease

Cause (1) above — detection never armed — and the reason is one line in the wrong
function.

`main.c` stamped `runtime.last_served_ms = now_ms(NULL)` inside
`waveshare_health_json()`, on the correct reasoning written directly above it:
_"Answering an RPC is the only proof the mount is still reachable. Pings ride the
socket and prove nothing about it."_

But `append_stats()` calls `waveshare_health_json()` **every five seconds** to
build the `voicelab/dev-stats` telemetry body. So the device refreshed its own
"somebody asked us something" marker twelve times a minute by talking to itself,
and the 90 s watchdog could never expire. Serializing local statistics was
recording remote liveness.

The other watchdog cannot cover for it: the ping liveness check keys on
`ping_count`, and pings are a call-time mechanism, so while idle they never move.
`NO_LIVENESS_RESTART_MS` (180 s) never fires either, for the same reason. An idle
device that loses its mount was watched by nothing — exactly what the comment at
`main.c:2069` feared, written by someone who saw this happen and fixed the wrong
clock.

## The fix, at the abstraction boundary

This target carried its own inline copy of a decision that already exists, is
pure, and is unit-tested: `iterate_kit_control_recovery_poll`. The stackchan
target drives it with `served_dispatches = iterate_kit_peer_served_dispatches()`
— a count of INBOUND capability dispatches, which no amount of outbound telemetry
can inflate. Waveshare's copy diverged in precisely the way that mattered.

So:

- `waveshare_health_json()` is now **pure** — it serializes and records nothing,
  and `last_served_ms` is gone with the duplicate that used it.
- The idle decision comes from the shared `control_recovery`, fed the real
  inbound dispatch count, with a live call as a hard exclusion.
- Recovery is **observable**: `idleRemounts` and `servedDispatches` are published
  in `health()` and described to the model, so a device healing itself — or stuck
  trying — says so in its own metrics instead of looking idle.
- Failure **escalates once, with a reason**: a transport latched failed for
  `UNHEALTHY_RESTART_MS` after N idle remounts logs that sentence and restarts,
  rather than retrying quietly forever.

Five regressions in `firmware/tests/control_recovery_test.c` (10 total, all
passing on the host build) pin: periodic local telemetry cannot suppress idle
recovery and the remount lands at exactly 90 s; a real inbound dispatch resets
the interval; an active call is never spuriously remounted and the window
restarts when it ends; recovery is asked for once per episode across ten minutes
of silence; and a latched failure escalates exactly once.

## Repro to run (production-shaped)

1. Attach to the pinned board's console continuously — `1C:DB:D4:7A:16:C8`,
   resolved to its tty via `ioreg`, never by `usbmodemNNN` suffix.
2. Confirm the capability is online and an RPC has just been served.
3. Deploy `apps/os` to preview_3 (the real drop; a `stream.kill()` is a
   different shape and does not exercise the isolate going away).
4. Watch, for at least 5 minutes, for:
   - `no RPC served in 90s — replacing the session to re-mount`
   - whether a remount follows it, and whether the capability returns
5. Poll the capability from the host on the same clock, so the two views line up.

Outcome (1) means the guard is wrong. Outcome (2) means recovery is wrong and the
retry is hiding it — in which case the restart needs to be observable: a counter
for remount attempts, and a distinct one for attempts that did not restore a
served RPC, so a device stuck in this loop says so in its own telemetry instead
of looking idle.

## Constraints when fixing

Any firmware change here touches the audio/network path, so the prior **10/10
ten-session result is a baseline for the old build, not evidence for the new
one**. Reflash the pinned board only, then rerun reliability evidence
proportionate to the change before treating the fix as proven.
