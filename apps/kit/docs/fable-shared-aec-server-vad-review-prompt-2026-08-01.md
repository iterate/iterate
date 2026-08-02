# Independent Fable Max review: shared AEC + server-VAD device path

You are an independent, read-only Claude Fable Max reviewer. Work from:

`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`

Do not edit source files, documentation, generated files, git state, devices,
secrets, deployments, or processes. Return one self-contained report to stdout.
The primary agent will capture and reconcile it. Cite exact source paths and
line numbers wherever possible; distinguish source-backed facts from guesses.

## Immediate goal and non-negotiable behavior

The already-proven M5StickS3 target keeps manual push-to-talk. The next target,
M5Stack StackChan/CoreS3, must be freshly flashed and physically prove one
continuous call through the deployed Iterate userspace `/pcm` worker with:

- local, measured AEC on-device;
- continuous 16 kHz PCM uplink while the call is active;
- Grok `grok-voice-think-fast-2.0` server-side VAD;
- audible high-volume full-duplex replies and interruption without
  accumulating delay;
- bounded queues, explicit stale-data discard/recovery, exact diagnostics,
  streamed metrics, and network-valid evidence;
- remote capability control, so no human button press is required.

After StackChan, Home Assistant Voice Preview Edition (HAVPE) must reuse the
same call/transport/userspace architecture and also use local AEC + server VAD.
Board wiring, codec/DSP ownership, and AEC implementation may be adapters. Call
state, audio policy, PCM protocol, metrics, recovery, and userspace provider
policy should be shared. Do not expand scope to face/avatar rendering.

The proposed minimal cross-layer change is an authenticated PCM handshake
header that carries the existing portable audio mode (`push-to-talk` or
`full-duplex-aec`). Userspace derives manual commit versus server VAD from that
declared policy, never from a device-name branch. The shared firmware intent
reconciler becomes mode-aware: conversation start enables continuous uplink in
full-duplex mode; PTT mode keeps its existing explicit press/release behavior.

## Read source, not summaries alone

Read at least:

- `apps/kit/firmware/AGENTS.md`
- `apps/kit/docs/reasoning-comments.md`
- `apps/kit/docs/physical-device-voice-goal.md`
- `apps/kit/docs/stackchan-portability-notes-2026-07-31.md`
- `apps/kit/docs/fable-stackchan-fast-port-review-2026-07-31.md`
- `apps/kit/docs/fable-stackchan-first-voice-turn-review-2026-08-01.md`
- `apps/kit/firmware/components/core/`
- `apps/kit/firmware/platforms/iterate_esp_idf/`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/`
- `apps/kit/firmware/devices/{m5sticks3,stackchan}/`
- `apps/kit/firmware/targets/{m5sticks3,stackchan}/`
- `apps/kit/firmware/tests/`
- `apps/kit/src/userspace/config-worker/`
- `/Users/jonastemplestein/src/github.com/iterate/stackchan`, especially
  `experiments/02-minimal-realtime-aec/firmware-ws`
- `/Users/jonastemplestein/esp/esp-idf`
- the pinned ESP-SR, M5Stack CoreS3 BSP, ES7210, AW88298, and ESP codec-device
  component source actually used by the StackChan build
- locally available or upstream first-party Home Assistant Voice Preview
  Edition / ESPHome firmware, board, audio, AEC, and codec source.

Use first-party ESP-IDF, ESP-SR, ESPHome, Home Assistant, M5Stack, and relevant
chip/codec documentation and examples where source alone is ambiguous. Internet
research is allowed, but cite URLs and prefer primary sources.

## Review questions

1. Is the policy-header + one mode-aware reconciler the smallest clean shared
   design, or can code and state be deleted by choosing a materially simpler
   contract? Identify any hidden ordering, authentication, reconnect, or
   capability-lifetime bug.
2. What exact provider event grammar does Grok server VAD require? Audit that
   continuous uplink never emits manual zero-length END, buffer commit, or
   manual `response.create`, and that speech-start interruption cannot admit
   stale downlink from the cancelled response.
3. Audit StackChan's physical pipeline against ESP-IDF/ESP-SR/vendor source:
   codec clocking, DMA cadence, core affinity/priorities, reference/near slot
   choice, AEC reset/discontinuity rules, queue budgets, PSRAM/internal-RAM use,
   high-volume safety, and metrics sufficient to falsify AEC quality.
4. Find the cleanest HAVPE adapter boundary now, so this StackChan change does
   not bake in CoreS3 assumptions. State what first-party HAVPE/ESPHome AEC
   implementation can be reused and what cannot.
5. Propose deletions, smaller interfaces, and test-harness simplifications that
   reduce time to the physical StackChan proof. Avoid speculative frameworks.
6. List concrete failing tests that should exist before each must-fix change.
7. Rank findings as BLOCK-before-flash, FIX-before-HAVPE, or DEFER. For every
   BLOCK item give the shortest correction and acceptance evidence.

Pay special attention to real-time invariants: no microphone backlog; bounded
fresh playback only; audio owners cannot be blocked by logging, Cap'n Web,
network reconnect, or provider lifecycle; after loss/reconnect the first clean
live audio is current rather than queued history. Explain why each proposed
change helps those invariants, not merely what code it changes.

End with a concise reconciliation checklist. Do not commit or push.

## Post-build delta to review

The StackChan target now compiles and links after moving only its sixteen
non-realtime 8 KiB Cap'n Web envelope payload slots (128 KiB total) into
linker-reserved PSRAM with `EXT_RAM_BSS_ATTR` and enabling
`CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY`. PCM rings, ring metadata,
audio-owner state, and DMA-facing buffers were deliberately not moved. Audit
that boundary against ESP-IDF's external-RAM/cache constraints and call out a
smaller safe design if one exists. The generated application binary is
`0x116f40` bytes and the app partition reports 78% free.

Keep the report bounded to the highest-value findings (roughly 3,000 words or
less). Prefer deletions and the shortest physical-proof path. Do not restate
working architecture unless it is necessary to explain a defect.
