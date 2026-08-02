# StackChan avatar integration: bounded Fable review prompt

You are an independent, extremely skeptical embedded-systems reviewer. Work
read-only. Do not edit files, flash hardware, deploy, commit, or push. Produce
a concise but evidence-rich report to stdout.

The immediate goal is to restore the talking-head sprite avatars on the real
M5Stack CoreS3 StackChan without regressing the already-proven production
full-duplex Grok voice, interruption, AEC, bounded freshness, or resource
behavior. The working tree is:

`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`

Inspect at least:

- `apps/kit/firmware/components/avatar/`
- `apps/kit/firmware/platforms/iterate_stackchan_avatar/`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/`
- `apps/kit/firmware/targets/stackchan/`
- `apps/kit/docs/stackchan-vertical-slice-landing-2026-08-02.md`
- the relevant first-party ESP-IDF/FreeRTOS/LCD/SPI/Wi-Fi sources and docs in
  `/Users/jonastemplestein/esp/esp-idf`
- the measured prior implementation in
  `/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`

Observed evidence to account for, not hand-wave away:

- The pre-avatar StackChan production voice proof was green with CPU about
  452 permille and minimum internal heap 81,307 bytes.
- An LVGL avatar attempt left only about 3.6 KiB minimum internal heap and used
  about 819 permille CPU, so it was rejected.
- The direct-panel 160x120 RGB565/15 Hz implementation leaves about 27-30 KiB
  minimum internal heap and used about 471-503 permille CPU in real Grok runs.
- Its one-slot overwrite-latest handoff consumes PCM only after physical
  speaker completion; audio does not wait for the avatar.
- A first build pinned its priority-2 avatar task to core 0, where this target
  pins ESP-IDF Wi-Fi. LAN probes while active showed intermittent 5-10% loss.
  The current source moves visuals to core 1, where audio I/O/AEC run at
  priorities 23/20, matching the prior renderer's affinity. This build has not
  yet been flashed because the StackChan USB/JTAG endpoint disappeared while
  the device remained online over Wi-Fi.
- One measured avatar stack had only 464 bytes headroom at 3072 bytes; the
  current 4096-byte stack measured 1556 bytes headroom.
- A recent audible story was cut after “once upon a time” by the harness's
  deliberate barge-in test. Do not misclassify that as an organic dropout.
- The most recent run also showed extra Grok VAD starts from residual room
  noise and was network-invalid, so it is not acceptance evidence.

Answer these questions with file/line or first-party source citations wherever
possible:

1. Is core 1 at priority 2 the cleanest affinity, or is there a materially
   simpler/better scheduling architecture that preserves audio and Wi-Fi?
2. Can the current full-frame render/byte-swap/SPI DMA path block or perturb
   audio indirectly through PSRAM/cache/GDMA/SPI/lwIP, even with task priority?
3. Are the ISR callback, one-slot mailbox, semaphore completion, timeout, and
   framebuffer ownership actually race-safe and bounded under ESP-IDF?
4. What is the shortest truthful on-device acceptance proof for avatar motion,
   display transfers, audio/AEC, memory, CPU, and network validity without
   serial observation or a camera oracle?
5. Which code/abstractions should be deleted or simplified now? Explicitly
   identify any local maximum, premature generality, hidden unbounded work,
   giant-resource mistake, or counter whose semantics are misleading.
6. List only near-term fixes that are worth doing before the next production
   proof, ordered by impact. Separate those from later improvements.

Do not recommend increasing queues or tolerating unexplained loss. Audio is the
highest-priority workload; visual work must always discard stale detail rather
than delay audio or network recovery.
