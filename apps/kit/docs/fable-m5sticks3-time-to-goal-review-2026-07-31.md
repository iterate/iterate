# Fable Max review: fastest clean M5StickS3 vertical proof

Status: independent time-to-goal review, 2026-07-31. Read-only against this
worktree (`c-capabilities`, uncommitted changes included). The prompt is
retained verbatim in
[`fable-m5sticks3-time-to-goal-review-prompt-2026-07-31.md`](./fable-m5sticks3-time-to-goal-review-prompt-2026-07-31.md).
This report is research input, not an authority; it is written to be
reconciled the same way the earlier Fable reports were.

Method note: every load-bearing physical claim in sections 2–4 was re-derived
in this review with tools run against this machine and worktree (addr2line,
ELF hashing, run-log and evidence greps, ESP-IDF and M5Unified source reads).
File/line citations elsewhere were collected by exploration passes over the
current source and spot-checked; anything not directly verified is flagged in
section 14.

## 1. Bottom line

1. **The brownout is real, verified end to end, and already correctly
   diagnosed and fixed in this worktree's uncommitted change.** The direct-I2S
   path copied M5Unified's ES8311 register table verbatim — including DAC
   volume `0x32 = 0xBF` (0 dB, full scale) — while deleting the M5Unified
   mixer whose digital attenuation is what makes that codec setting safe on
   this board. The uncommitted fix (−18 dB codec ceiling, `0x32 = 0x9B`, plus
   a red-first architecture test) is the smallest safe response. What remains
   is to build, flash, and physically validate it — not to design anything.

2. **The earlier "coupled station outage" family is a different failure
   class than the brownout — but the speaker is a candidate trigger for both,
   and the same −18 dB ladder discriminates.** During this review, the
   parallel station-outage research landed in this same docs directory
   ([`fable-esp32-station-outage-research-2026-07-31.md`](./fable-esp32-station-outage-research-2026-07-31.md),
   completed before the 0508 brownout run and without knowledge of it). It
   falsifies the natural "outages were silent reboots" reading this review
   initially formed: at every cold boot the device mounts ~1.2–1.7 s _before_
   it becomes ping-visible, yet post-outage the Stick answered ~17 s of ICMP
   with zero mounts against a live accepting server — a rebooted device would
   have remounted. The 17–19 s duration instead decomposes as beacon-loss
   detection plus the firmware's own double-defer reconnect ladder (verified
   in this review at `itx_transport.c:757-784`) — the same slow join pipeline
   that makes every boot take ~17 s. What that report could not know: all
   three outages began **while the speaker was playing at the 0 dB codec
   setting**, and the 0508 run now proves that load sags the rail by ~0.9 V.
   A rail-sag-degraded radio (beacon loss without reset) is therefore a
   unifying trigger hypothesis — labeled speculation in §4.3 — that the
   −18 dB ladder tests for free. **Firmware reconnect-policy changes and deep
   network forensics should pause until that ladder has run**; the
   station-outage report itself orders host-side evidence retention first and
   firmware changes last, which this review adopts (§4.4, §11).

3. **The deterministic tone/PRBS oracle already traverses the real `/pcm`
   implementation.** `DevicePcmProxy` is the only `/pcm` in the repository and
   the tone/PRBS providers plug into its provider seam exactly where Grok
   does. No work is needed on the oracle itself. What is _not_ real is
   everything around it: no deployed or deployable worker anywhere serves
   `/pcm`, and the harness's "userspace" is a 342-line local stub. The fastest
   honest route to "a real Iterate userspace app/worker" is to promote
   `DevicePcmProxy` (already written Workers-style) into a real project
   userspace worker serving `/api` + `/pcm` on one origin — roughly a day —
   not to build new transport or proxy code.

4. **Grok mode exists and pins `grok-voice-think-fast-2.0`.** The current
   voice lane drives push-to-talk _remotely_; a physical-held-button
   acceptance mode is a 2–4 h TypeScript change that reuses the existing
   held-uplink continuity checks.

5. Shortest path to the slice, in order: land + flash the −18 dB fix → run
   the brownout discriminator ladder → add the physical-PTT mode and the
   post-run network-validity adjudicator (TS only, no firmware) → stand up
   the real userspace worker with tone/PRBS/Grok modes → one fresh-flash
   proof run → achieved/deferred ledger. Concrete sequence with commands in
   §15.

## 2. Independently verified facts

Re-derived in this review, not quoted from prior docs:

- **Saved PC resolution.** `firmware/targets/m5sticks3/build/iterate-kit-m5sticks3.elf`
  has SHA-256 prefix `b212c11f6…`, exactly matching the booted app's
  `ELF file SHA256: b212c11f6...` line in the 0508 run log.
  `xtensa-esp32s3-elf-addr2line -pfiaC` resolves `0x403758a2` in that ELF to
  `rtc_brownout_isr_handler` at ESP-IDF `components/esp_system/port/brownout.c:72`.
  The landing doc's claim is confirmed against the exact flashed image.
- **What the handler does.** `brownout.c` stalls the other core, sets
  `ESP_RST_BROWNOUT`, logs `Brownout detector was triggered`, and calls
  `esp_rom_software_reset_system()` — which is why the subsequent reset
  reason reads `RTC_SW_SYS_RST` rather than a dedicated brownout code.
- **Threshold.** The build resolves `CONFIG_ESP_BROWNOUT_DET_LVL=7`
  (`.build/m5sticks3/config/sdkconfig.h:594-597`), and ESP-IDF's
  `components/esp_system/port/soc/esp32s3/Kconfig.system:23-24` defines
  level 7 as **2.44 V — the least sensitive threshold offered**. The 3.3 V
  rail collapsed by roughly 0.9 V. There is no detector headroom to tune;
  the load itself must shrink. (Disabling the detector is forbidden and would
  merely convert the reset into memory corruption.)
- **Run 0508 timeline** (`evidence/m5sticks3-playback/direct-lan-tone-60s-taskless-control-serial-diagnostic-20260731-0508/run.log`):
  invoked with `--no-flash` (the image had been flashed 2026-07-30 23:59);
  cold boot at run start; first Wi-Fi auth attempt at 3.9 s failed
  (`auth -> init (0x200)` at 8.3 s), retry at 16.1 s succeeded, IP at 18.4 s,
  control mounted at 18.6 s — **boot→mount ≈ 18.6 s with one SAE retry, and
  IP→mount ≈ 240 ms**. Tone injection began ~21.6 s; the bridge delivered
  exactly 43 paced frames (`workerToDeviceMessages: 43`, run.log:211); the
  ROM brownout banner appears ~0.9 s after paced delivery began — i.e. the
  power amplifier had been switched on for well under a second. Control churn
  was healthy until the reset (16/16 cycles, run.log:201).
- **Serial-monitor coverage.** `grep -l serial_monitor_ready */run.log` over
  the evidence tree shows the 0508 run is the **only** run in the
  outage-affected direct-LAN failure lane with a serial monitor attached
  during playback. The 0451 observation states it outright
  (`direct-lan-tone-60s-taskless-control-dual-ping-physical-20260731-0451/observation.md:35`:
  "No serial monitor ran during playback"). Runs 0400/0414/0421/0451 and the
  schema-5 0134 run could not have retained a ROM brownout banner.
- **Outage-duration signature.** In 0451's own ping evidence the _expected_
  run-start reset/reboot bringup gap was 18.938 s and the unexplained in-run
  station outage was 18.477 s (observation.md:94-103). The 0421 run measured
  18.561 s; the 0414 run 17.2 s. The 0508 log independently measures
  boot→IP at 18.4 s when one auth attempt fails. Reboot bringup and "station
  outage" have the same duration to within ~0.5 s — **because both run the
  same slow join pipeline**, not because the outages were reboots (§4.2).
- **Double-defer reconnect ladder, verified in source.** One
  `WIFI_EVENT_STA_DISCONNECTED` fires both the `prior_wifi_connected` edge
  branch (defer + double, `itx_transport.c:757-769`) and the
  `wifi_retry_later` flag consumer (defer + double again,
  `itx_transport.c:775-784`): the first reconnect attempt is deferred twice
  and the backoff escalates twice per incident. This confirms the central
  mechanism in the station-outage report's duration decomposition.
- **Chronology of the parallel reports.** At this review's start, the docs
  directory contained only the station-outage _prompt_; the finished report
  ([`fable-esp32-station-outage-research-2026-07-31.md`](./fable-esp32-station-outage-research-2026-07-31.md))
  appeared in the worktree mid-review. It analyzes runs 0414/0421/0451 and
  does not mention the 0508 brownout — it was produced without that
  evidence, and the two documents' conclusions are reconciled in §4 rather
  than assumed to agree.
- **M5Unified is the source of both the register table and the missing
  attenuation.** `targets/m5sticks3/managed_components/m5stack__m5unified/src/M5Unified.cpp:520-530`
  contains the identical eight-register ES8311 block, including
  `2, 0x32, 0xBF, // DAC volume (0xBF == ±0 dB)`; the kit's
  `configureCodec()` copies it byte for byte. M5Unified's shipped output path
  interposes a float mixer that scales samples by `master_volume²`
  (default 64/255, `Speaker_Class.hpp:285`, applied at
  `Speaker_Class.cpp:624`) times per-channel `volume²` times a board
  `magnification` that is **1 for StickS3 against a generic default of 16**
  (`M5Unified.cpp:2425` vs `:2366-2367`). The kit's direct path applies none
  of these factors: the mono→stereo stage is a bare duplicate copy
  (`platforms/common/include/iterate/kit/platforms/direct_i2s_stereo_output.hpp:575-576`)
  and no gain/scale/clamp exists anywhere in the PCM path. M5Unified also
  proves `0x32` is the intended gain control: other boards ship `0xCF
(+16 dB)` and `0xEF` variants (`M5Unified.cpp:568,600`).
- **Single-origin dial contract.** The device derives both WebSocket URLs
  from one configured origin: `components/core/src/configuration.c:232-245`
  appends `"/api"` and `"/pcm"` to `os_base_url`. Any "real userspace" must
  therefore serve both routes on one origin.

## 3. The speaker-load brownout: cause, in-flight fix, remaining work

### 3.1 Causal chain

1. `M5StickS3AudioBoardOps::configureCodec()`
   (`firmware/platforms/iterate_m5unified/m5sticks3_direct_audio.cpp`, register
   table at the `configureCodec` body) wrote ES8311 `0x32 = 0xBF` = 0 dB —
   full-scale DAC output into the power amplifier, with the amp enabled via
   the M5PM1 latch (`0x6e` reg `0x11` bit 3).
2. The deterministic tone is 75 % of int16 full scale
   (`scripts/device-e2e.ts:203-229`, `amplitude: 24_576`), duplicated to both
   stereo slots with no attenuation stage anywhere.
3. The backend enables I2S first and switches the PA on as "the final
   action" into four **preloaded full-amplitude descriptors**
   (`platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_direct_i2s_backend.hpp:168-190`)
   — a step-function electrical load, concurrent with Wi-Fi at
   `WIFI_PS_NONE` (`platforms/iterate_esp_idf/itx_transport.c:1122`) and the
   display at brightness 96 (`platforms/iterate_m5unified/m5unified.cpp:78`).
4. The rail crossed 2.44 V; the ROM printed the banner; the chip reset.

The prior acoustic/endurance review had already fingered the PA-switch-on
instant (F12 in
[`fable-acoustic-oracle-and-endurance-review-2026-07-30.md`](./fable-acoustic-oracle-and-endurance-review-2026-07-30.md));
what it could not know then was that the codec was configured materially
louder than the library path it was copied from — the shipped path interposes
mixer attenuation the direct path deleted (§2).

### 3.2 The uncommitted fix is the right smallest response

The worktree diff (uncommitted at review time) is:

- `m5sticks3_direct_audio.cpp`: named constants
  `es8311ZeroDbVolume = 0xBF`, `es8311SafeDacAttenuationHalfDbSteps = 36`,
  `es8311SafeDacVolume = 0x9B` with a `static_assert`, replacing the bare
  `{0x32U, 0xbfU}` table entry — a fixed **−18 dB codec ceiling** with zero
  per-sample cost, explicitly labeled a board power policy.
- `src/device/firmware-architecture.test.ts`: a source-pinning regression
  ("limits speaker power at the codec rather than per PCM frame") that fails
  against HEAD (HEAD still contains `{0x32U, 0xbfU}`), i.e. red-first.

This is correct on all the axes that matter: it attenuates _before_ the PA
(power, not just waveform), costs no cycles/branches/RAM in the realtime
path, does not touch the brownout detector, does not add or grow any buffer,
and it is named and asserted rather than a bare hex literal. Do not gold-plate
it before the slice.

### 3.3 What is still missing (required before the proof)

1. **Build, flash, and physically validate.** The fix exists only as source.
   Because the failure is load/stochastic (a 120 s run at 0 dB passed cleanly
   at 02:22 the same night; the 0508 run died in under a second of PA-on),
   one clean rerun proves little. Prescribe a small fixed ladder: **five
   consecutive 60 s tone runs plus one 120 s run, serial monitor attached,
   all at −18 dB, zero brownout banners and zero station outages required.**
   This doubles as the §4 discriminator.
2. **If −18 dB still browns out**, the next lever is more codec attenuation
   (48 steps = −24 dB, closer to the shipped-path headroom), not code. A PA
   soft-start/ramp is explicitly _not_ recommended now — it would add code to
   the realtime path to solve a problem more attenuation solves for free.
   Only if a measured rail still collapses at conversational loudness does
   ramping deserve a design.
3. **Loudness sanity check during the ladder** (subjective is fine at this
   stage): −18 dB must still be clearly audible next to the Mac. If it is
   too quiet for the demo, raising it is a _physical-power decision_ with a
   rerun, exactly as the in-code comment demands — never a silent constant
   bump.

Non-actions, stated to keep them out of the plan: the brownout detector stays
at level 7 (already the least sensitive); no audio queue, reservoir, or
freshness budget changes in response to a power fault; the mic path
(M5Unified ADC at MAXGAIN, `M5Unified.cpp:976`) is untouched — it never
triggered under load and is not part of this failure.

## 4. The outage family, reconciled with the station-outage research

### 4.1 What every failed run has in common

| Run                                | Speaker active at failure | Serial attached | Station gap      | Both sockets lost together | ~4.1–4.2 s kernel tail |
| ---------------------------------- | ------------------------- | --------------- | ---------------- | -------------------------- | ---------------------- |
| `…schema5…-0134`                   | yes (59 s in)             | no              | not instrumented | yes (same 1 s interval)    | yes                    |
| `…inbox8-physical-0400`            | yes (27.6 s in)           | no              | not instrumented | yes                        | yes (4.8 s to gate)    |
| `…inbox8-ping-0414`                | yes                       | no              | 17.2 s           | yes                        | yes                    |
| `…inbox8-dual-ping-0421`           | yes (12.6 s in)           | no              | 18.561 s         | yes                        | yes                    |
| `…taskless-control-dual-ping-0451` | yes (9.8 s in)            | no              | 18.477 s         | yes                        | yes                    |
| `…serial-diagnostic-0508`          | yes (<1 s of PA-on)       | **yes**         | n/a (run ended)  | yes                        | n/a                    |

The only run that could see a ROM banner saw one, and every failure began
during active playback at the 0 dB codec setting.

### 4.2 Not a reboot — and why the durations matched anyway

This review initially read the duration match (reboot bringup 18.4–18.9 s vs
outage 17.2–18.6 s) as evidence the outages _were_ silent brownout reboots.
The station-outage research falsifies that for the instrumented runs with a
cleaner ordering argument: at every cold boot the device mounts its
capability (~17.2 s uptime) **1.2–1.7 s before** it becomes ping-visible,
so a rebooted device would have remounted at about the moment ICMP returned —
instead 0421/0451 answered ~17 s of post-outage ICMP with zero mounts against
a live accepting server. The durations match because _both_ paths run the
same slow join pipeline: ≤8.5 s in-driver beacon-loss detection plus the
firmware's own double-defer reconnect ladder (verified, §2) plus a full
scan/auth/DHCP-DISCOVER/ARP-check join — the same pipeline that makes every
boot join take ~17 s on this AP. The ~4.15–4.2 s kernel tail is equally
consistent with a dead-but-unreachable station as with a reboot; it does not
discriminate. The non-remount after recovery is that report's **second,
independent defect** (control: three retained-witness candidates —
attempts-failing-invisibly, the permanently-poisonable stack-floor fatal
latch, a lost GOT_IP edge; PCM: its reconnect gate is deliberately
Wi-Fi-blind and can legally sleep 13–27 s past recovery).

### 4.3 The unifying trigger hypothesis this review adds [speculation]

The station-outage report names the _duration_ mechanism but leaves the
_trigger_ open (its lead candidate: AP-side admission gating; second:
TX-buffer starvation/interference). It was written without the brownout
evidence. What is now known and was not then: the speaker at 0 dB sags the
3.3 V rail below 2.44 V — and Wi-Fi TX shares that rail, with power save
explicitly off. A rail held near (but above) the brownout threshold degrades
the radio front-end without any reset: missed beacons → blob probes → reason
200 → the measured ladder. Every outage began mid-playback; no outage has
been retained from an idle device. This is speculation until a run at
−18 dB either removes the outages (strong support) or reproduces one
(refutes it, and the retained disconnect-reason evidence then arbitrates the
report's T1/T2 candidates). Either way the §3.3 ladder answers it with zero
additional runs — which is exactly why it must run before any network-side
change.

### 4.4 What pauses, what proceeds

**Pause until the ladder has run** (plausibly compensating for a power
artifact, and expensive):

- firmware reconnect-policy changes (the double-defer repair, flat
  session-recent retry, BSSID/channel pinning — real improvements, but the
  station-outage report itself sequences them _after_ the reason code is
  named);
- the PCM PING/PONG transport barrier, lwIP mailbox resizing, receive-loop
  redesign (already deferred by the receive-stall reconciliation; re-deferred
  harder here);
- bounded Mac packet capture, AP/router A/Bs, IDF v5.4.3 bump, monitor-mode
  sniffing (station-outage report §7.2 step 4 — after the reason code);
- further hard-abort/close-semantics work beyond what exists (post-slice
  hardening, not a blocker).

**Proceed now** (host-only, near-free, and they serve the §11 evidence
contract regardless of what the trigger turns out to be — station-outage
report D1/D2/D4/D5):

- retain the first + last parsed `getDiagnostics` churn replies — they carry
  `wifiDisconnects` and `lastWifiDisconnectReason` 20×/s and the harness
  currently parses and discards them (`scripts/device-e2e.ts:568-628`);
- log every `/api`/`/pcm` TCP accept/upgrade/failure with a wall clock;
- extend the postmortem grace windows so they outlive the failure being
  observed (outer ≥ 90 s; today's outer 30 s races an inner path that can
  need ~50 s — `control-mount-diagnostics.ts:59-60`);
- keep the serial monitor on every physical run (the non-resetting variant
  already exists behind `ITERATE_KIT_SERIAL_DIAGNOSTICS=1`,
  `src/device/python-serial-monitor.ts:8-15`).

What survives regardless of the trigger, because it is justified
independently: the taskless control transport (−10,160 bytes of image,
+8.9 KiB free internal heap, simpler single-owner model), the exact host
payload ledger, `getDiagnostics()` with the retained error tuple, and the
serial-monitor lane itself.

## 5. Does mocked tone/PRBS traverse the real userspace `/pcm` codepath?

**Yes — through the real proxy; no — the surrounding "userspace" is a stub.**

Verified topology of every retained `direct-lan-tone-*` run:

- `DevicePcmProxy` (`src/voice/device-pcm-proxy.ts:114-257`) is the **only**
  `/pcm` implementation in the repository (repo-wide grep: zero other
  handlers) and every run routes device PCM through it via
  `src/device/local-device-peer-server.ts:79-86`. Rechunking to 640-byte
  frames, the 160 ms bounded downlink queue, device-clocked pacing, startup
  reservoir, EOS marker, close provenance — all real-path code, exercised by
  tone and PRBS exactly as by Grok.
- The deterministic providers connect at the same seam Grok uses:
  `connectProvider(session)` (`device-pcm-proxy.ts:71`), selected in
  `scripts/device-e2e.ts:262-273` — tone/PRBS construct a `WebSocketPair`
  provider half (`src/voice/deterministic-pcm-provider.ts:68-121`) that
  speaks the same provider control contract (`response.created` → binary →
  `response.done`), deliberately chunked at 1,000 bytes to force real
  reassembly (`scripts/device-e2e.ts:207-212`).
- Harness-only stand-ins around the proxy: `LocalFetchWebSocketServer`
  (656 lines, Node `ws`/`http` adapter for `--direct-lan-host`) substitutes
  for the Workers runtime, and `LocalDevicePeer` (342 lines,
  `src/device/local-device-peer.ts`) reimplements the userspace capability
  host (`authenticate` → `projects.get` → `provideCapability`) instead of
  any real project. Nothing in `apps/os` references kit at all (zero grep
  hits), and the deployed `kiterate` worker serves only the flasher SPA —
  no `/pcm`, no server routes (`wrangler.jsonc:14`, `src/routeTree.gen.ts:22-29`,
  `envs.ts` kit entry).

**Minimum missing work for landing item 6 (deterministic mode in the same
userspace path):** none on the oracle itself. The tone/PRBS providers and the
proxy move to the real worker unchanged; the only new code is the worker's
bounded mode selector (§6). The existing direct-LAN lane stays as the
lab/adversity lane — it is not deleted by the slice.

## 6. Real userspace worker / Grok mode: what exists, what's missing, fastest route

### 6.1 Exists today

- **Grok connector, pinned model:** `src/voice/grok-realtime-voice.ts:67`
  (`options.model ?? "grok-voice-think-fast-2.0"`), ephemeral client-secret
  mint (`:45-55`), `wss://api.x.ai/v1/realtime`. Secret comes only from
  `XAI_API_KEY` (`scripts/device-e2e.ts:127,165`; `scripts/voice-e2e.ts:33,45`);
  the README's working invocation sources it from Doppler project `voice`,
  config `dev_jonas` (`apps/kit/README.md:102`).
- **Harness Grok modes:** `--voice` (full PTT turn) and
  `--grok-playback-only` (`src/device/device-e2e-cli-options.ts:135-147`),
  mutually exclusive with tone/PRBS (`:245-252`). The provider is dialed from
  the host Node process, so Grok composes with `--direct-lan-host`.
- **A physically proven mount over public TLS:** the 2026-07-30 proof
  mounted `itx.kit.m5sticks3` through `tunnels.iterate.com`, streamed 222
  held-button mic frames to Grok, and played the response
  ([`physical-device-voice-goal.md`](./physical-device-voice-goal.md)
  §Physical evidence). Device-side TLS to a public host is therefore not a
  risk item for a preview/deployed origin.
- **Flash/provisioning shared core:** `prepareFirmwareFlashPlan`
  (`src/firmware/prepare-flash-plan.ts:33-78`) + config TLV image
  (`src/firmware/config-image.ts:26-40`: SSID, password, `os_base_url`
  origin, `prj_…` project ID, project API key) + CLI flasher
  (`scripts/flash.ts`, env-only secrets). The browser path shares the core
  but currently has no published releases on purpose (`README.md:24-28`), so
  the slice's "normal shared TypeScript path" is the CLI lane — acceptable
  and already production-shaped.

### 6.2 Missing (the real gap for landing items 2 and 4)

1. **A worker.** No worker anywhere serves `/pcm` or the mount surface. The
   device's dial contract is fixed: one origin serving `/api` and `/pcm`
   (`configuration.c:232-245`).
2. **Secret placement.** No project holds the Grok key; the harness reads
   `XAI_API_KEY` from the local environment.
3. **Mode selection in the worker.** Today mode selection is harness CLI
   flags choosing `connectProvider`; the worker needs a bounded equivalent
   (per-session query parameter or subprotocol: `tone | prbs31 | grok`,
   default grok, deterministic modes gated to non-production).
4. (Deferred, §13) the kit path is compiled into firmware
   (`targets/m5sticks3/main/main.cpp:138`), not a provisioning field.

### 6.3 Fastest route (~1 day, TS only)

Deploy one **project userspace worker** (the `worker.ts` shape in
`apps/os/config-repo-template/worker.ts`) for a real project (local dev
first, then a preview slot for the retained proof), serving:

- `/pcm`: `DevicePcmProxy` **verbatim** — it is already written against
  Workers-style APIs (`fetch(request)`, `WebSocketPair`); the Node adapter
  exists only because the harness runs it outside Workers. Provider =
  `connectGrokRealtimeVoice` with the project-secret key, or the
  deterministic tone/PRBS provider when the mode parameter says so.
- `/api`: the same three-verb mount surface the firmware already speaks
  (`components/core/src/itx_mount.c:25-27`: `authenticate`,
  `projects.get`, `provideCapability`). `LocalDevicePeer` is the working
  342-line reference implementation to port; bearer = the project API key
  the config partition already carries.

Then flash with `os_base_url` = that worker's origin and run the existing
harness in observe mode (or a slimmed landing runner) for evidence. This
closes landing items 2, 4, and 6 with one artifact and zero new protocol
design. The full OS-mediated `itx.kit.get(...)` agent story (proof-ladder
step 7 in the goal doc) stays deferred — the landing contract does not
require it.

Two residual risks to check in passing, not to pre-engineer around: Workers
CPU/wall limits on a 60 s+ WebSocket relay session (fine for a slice proof;
measure, don't assume), and preview-host TLS chain against the device's
mbedTLS bundle (tunnel proof made this low-risk).

## 7. Physical push-to-talk (landing item 3)

The current `--voice` lane is **remote** PTT: `mounted.device.pushToTalk.start()`
(`scripts/device-e2e.ts:904`), a `say`-injected phrase while held (`:928`),
held-uplink continuity checks (`:930-948` — "Microphone frames did not reach
Grok while push-to-talk remained held"), then remote stop after
`--remote-hold-ms`. The firmware publishes the _same_ bounded events for the
physical button (`main.cpp:1147-1165` → `SOURCE_PHYSICAL` →
`devices/m5sticks3/m5sticks3.c:176-186`), and the harness already observes
the button after the remote proof unless `--exit-after-remote-proof` is set
(`scripts/device-e2e.ts:117`).

Missing for the landing: an acceptance mode that (a) waits for
`pushToTalk.started` with source `physical` (the wait plumbing exists —
`runtimeProbe.waitForDeviceEvent("pushToTalk.started", "remote")` at `:902`
— it needs the `physical` variant and a human-scale timeout), (b) runs the
existing held-uplink continuity predicates during the hold, and (c) retains
the provider lifecycle/transcription evidence it already logs
(`would_post_to_stream` events). Estimate 2–4 h, TypeScript only, no
firmware change.

## 8. Concrete actions ranked by hours saved before the vertical proof

Estimates use the observed cost of this lane: a physical run is ~20–45 min
all-in (setup, run, observation.md, hashing), and the outage forensics have
been consuming several runs plus a reconciliation document per night.

| #   | Action                                                                                                                                                                                                                                            | Saves (est.)                                                              | Costs             | Why                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Pause firmware reconnect-policy work and deep network forensics** (packet capture, router/IDF A/Bs, PING/PONG barrier, ladder repair, merged-owner refactor) until the §3.3/§4.3 ladder has run — the host-only retention items in §4.4 proceed | 1–3 days                                                                  | 0                 | The speaker at 0 dB is a live candidate trigger for the whole outage family (§4.3); the station-outage report itself sequences firmware changes after the reason code is named  |
| 2   | **Land + flash the −18 dB fix and run the 5×60 s + 1×120 s serial-attached ladder**                                                                                                                                                               | unblocks everything                                                       | ~2–3 h wall clock | The single physical blocker named by the landing doc; doubles as the discriminator                                                                                              |
| 3   | **Reuse `DevicePcmProxy` + `LocalDevicePeer` semantics as the real project worker** instead of designing any new proxy/transport/protocol                                                                                                         | 1–2 days vs. any fresh build                                              | ~1 day            | §6.3; the proxy is already Workers-shaped; the mount surface is already specified by the firmware and stub                                                                      |
| 4   | **Physical-PTT acceptance mode in device-e2e** (reuse existing checks)                                                                                                                                                                            | avoids any firmware/PTT rework (1+ day if approached as firmware)         | 2–4 h             | §7; firmware side already emits everything needed                                                                                                                               |
| 5   | **Network-validity verdict as a post-run TS adjudicator over already-retained artifacts, absorbing the station-outage report's host-only retention items (churn-reply retention, accept/upgrade log, ≥90 s grace); defer firmware RSSI**          | 0.5–1 day of firmware + a schema bump (~10 pinned edits across C+TS, §12) | ~0.5–1 day TS     | §11; every required input already lands in (or is already parsed by) the harness                                                                                                |
| 6   | **Freeze metrics schema 5 / diagnostics schema 2 until the slice lands** (no new fields, no renames)                                                                                                                                              | hours per avoided bump                                                    | 0                 | Schema literals are pinned in ~10 places across two languages (`kit-playback-metrics.ts:82`, `kit-control-diagnostics.ts:39`, `metrics_subscription_test.c:267,339,713,902`, …) |
| 7   | **Stop expanding the endurance trio + acoustic analyzers pre-slice** (`playback-endurance-ladder/…-target/…-mode` ≈ 3,004 test LOC; two analyzers ≈ 1,301 LOC)                                                                                    | review/maintenance hours                                                  | 0                 | The landing defers 10-minute endurance; the slice needs the 60 s tone gate + one Grok turn                                                                                      |
| 8   | **Defer the kit-path TLV** (mount path stays `{"kit","m5sticks3"}` at `main.cpp:138`)                                                                                                                                                             | ~3 h                                                                      | 0                 | Single-device slice; record in the ledger (§13) with the landing-wording caveat                                                                                                 |
| 9   | **Don't start the create-once/direct-RX audio refactor before the proof**                                                                                                                                                                         | 2+ days                                                                   | 0                 | Already the landing's position; §10 re-affirms with the brownout lesson                                                                                                         |

Items that save no pre-proof hours belong in §9's "after" column (deletions,
folds); doing them now would spend proof-critical time to reduce line counts.

## 9. Required before the proof vs. cleanup that can follow

**Required before the proof (everything else is not):**

1. −18 dB fix landed, built, flashed; ladder green (§3.3).
2. Real project worker serving `/api` + `/pcm` with `tone|prbs31|grok` modes;
   Grok key as a project secret (§6.3).
3. Physical-PTT acceptance mode (§7).
4. Post-run network-validity adjudicator + rule that a run without serial
   monitor or ping sidecars can never be `valid` (§11), including the
   host-only retention items it depends on: first/last churn-diagnostics
   retention, `/api`+`/pcm` accept/upgrade logging, ≥90 s postmortem grace
   (§4.4 "proceed now" list).
5. Fresh flash via the normal CLI path (not `--no-flash`) for the proof run
   itself — landing item 1 requires it, and the whole recent lane has been
   running a 07-30 image.

**Cleanup that can follow the proof:**

- Delete dead code: `bounded_playback.hpp` (389) + `bounded_playback_test.cpp`
  (383) and `display_refresh_gate.hpp` (60) + its test (71) — live-path grep
  shows both are referenced only by their own tests. (~900 LOC.)
- Delete the stray mis-cwd evidence tree `apps/kit/apps/kit/evidence/…` and
  the two orphan `iterate-kit-acoustic-{NaZWLD,xQVuWR}` directories (the
  NaZWLD capture is referenced by the evidence doc — move, don't destroy).
- Remove the vacuous assertion at
  `src/device/local-fetch-websocket-server.test.ts:143`
  (`…toBeGreaterThanOrEqual(0)` — its own comment admits it discriminates
  nothing; the payload ledger superseded the `bufferedAmount` theory).
- Fold `scripts/voice-e2e.ts` (351 LOC, host-only, duplicated Grok wiring and
  `withTimeout`) into a `device-e2e --host-only` mode, or freeze it. Its one
  unique value (device-less smoke) is small once the worker exists.
- Consolidate the four-place control-diagnostics decode and the
  dual-language schema literals (§12) when the next schema bump is actually
  needed — not before.
- Slim `LocalFetchWebSocketServer`/`LocalDevicePeer` to the lab lane once the
  real worker is the default target.

## 10. Local maxima

1. **The ~4,700-line descriptor/owner/mailbox playback construction**
   (`realtime_playback.hpp` 1,863; `m5sticks3_direct_audio.cpp` 802;
   `direct_i2s_stereo_output.hpp` 710; `esp_idf_direct_i2s_backend.hpp` 689;
   plus helpers). Both prior reviews already judged it a local maximum and
   the evidence doc records the agreed successor (create-once substrate,
   one blocking high-priority writer). This review adds the sharpest datum
   yet: all that timing rigor coexisted with the actual electrical
   load-bearing byte (`0x32`) being an unnamed, untested, unconfigurable
   copy-paste. The refactor stays post-slice; the lesson (name and test
   hardware policy bytes) applies now.
2. **The four-layer uplink freshness stack** (`pcm_uplink_conductor.c` 586,
   `pcm_uplink_sender.c` 462, `pcm_peer_delivery_guard.c` 629,
   `pcm_lane.c` 696; 3,027 LOC of tests across four fakes asserting the same
   "old speech never becomes new speech" invariant). Post-slice collapse
   candidate into the create-once redesign.
3. **The harness monolith** — `scripts/device-e2e.ts` (1,547 LOC) now owns
   flashing, LAN bridging, mount proofs, tone/PRBS/Grok, churn, acoustic
   capture, endurance, and diagnostics observation. It is the right tool for
   the slice as-is; split roles only after the slice.
4. **Metrics serialization** — `metrics.c` (1,395) plus ~450 lines of
   hand-copied field marshaling in `main.cpp:420-867`, with schema numbers
   asserted as struct fields _and_ JSON literals in tests. Freeze now;
   single-source or generate later.
5. **The parallel userspace** — `LocalDevicePeer` + `LocalFetchWebSocketServer`
   (998 LOC) faithfully mimic a host that doesn't exist yet. §6.3 replaces
   their production role with the real thing and demotes them to the lab
   lane; that is the exit from this local maximum, not more fidelity work on
   the stubs.

## 11. Minimal automatic network-validity evidence contract

Everything required already lands in the artifact directory; the missing
piece is one **post-run adjudicator** (pure TS, ~0.5 day) that reads them and
emits a machine-readable verdict file. No streaming correlation
infrastructure, no new firmware.

Inputs (all existing):

| Evidence                              | Source (exists today)                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact audio interval                  | acoustic capture markers (`acoustic_capture_marker` lines; `provider.request.before`/`response.created`)                                                                                                                                                                                                   |
| Device reset/brownout                 | serial monitor lines; already parsed and classified terminal by `src/device/device-runtime-log.ts` (test at `device-runtime-log.test.ts:705`)                                                                                                                                                              |
| Device/router reachability, RTT, loss | 10 Hz timestamped ping sidecars (`device-ping.log`, `router-ping.log`, standard since the 0414 run)                                                                                                                                                                                                        |
| Link/reconnect events                 | schema-2 `getDiagnostics()` tuple: `wifi_disconnects` delta, `last_wifi_disconnect_reason`, TLS/errno/handshake/close fields (`main.cpp:794-866`) — already crossing the wire 20×/s during churn and currently parsed-then-discarded by the harness (`scripts/device-e2e.ts:568-628`); retain first + last |
| Dial/accept evidence                  | `/api`+`/pcm` TCP accept, upgrade, and upgrade-failure log with wall clock (to add in `local-fetch-websocket-server.ts` — distinguishes "device never dialed" from "dial failed")                                                                                                                          |
| Association RSSI                      | Wi-Fi connect serial line (`rssi: -44` in run.log:154)                                                                                                                                                                                                                                                     |
| DNS/connect + socket progress         | bridge metrics JSON: interarrival, payload ledger, callbacks in flight, close code/reason, per-endpoint (`direct_lan_bridge_metrics` lines)                                                                                                                                                                |
| Host delivery/freshness               | same bridge ledger (payload bytes in flight, oldest callback age)                                                                                                                                                                                                                                          |

Verdict rules (encode the landing's three values plus the power case, with
explicit precedence):

1. `device-invalid (power)` — any brownout banner or unexpected reset line
   inside the run window. Trumps everything; not a network escape hatch and
   not attributable to playback.
2. `network-invalid` — device-ping gap/loss/RTT beyond named bounds during
   the audio interval, or `wifi_disconnects` delta > 0, or router-ping
   simultaneously clean while device-ping fails (station-specific), or
   DNS/connect/close evidence of a path outage.
3. `valid` — all bounds held for the exact audio interval **and** all
   required inputs present. A run without the serial monitor or without ping
   sidecars can never be `valid` — only `indeterminate`. (This single rule
   would have converted the last four days of ambiguity into evidence.)
4. `indeterminate` — anything missing or unalignable.

Continuous device RSSI sampling is **deferred**: it requires a diagnostics
schema bump (~10 pinned edits across two languages, §12) for marginal
pre-slice value; association-time RSSI plus ping RTT/loss plus disconnect
deltas cover the landing's correlation intent for this proof. Record the
deferral in the ledger.

## 12. Tests: delete, retain, add

Inventory context: 103 test files, ~32,400 LOC (≈12,100 TS + ≈16,400 C +
fakes/fixtures). The suite is strong on red-first physical regressions and
heavy on multi-layer duplication.

**Retain (the load-bearing red set — do not touch during the slice):**

- One-late-frame bounded recovery (frame-73 class):
  `firmware/tests/realtime_playback_test.cpp:634` (+ boundary variant
  `:924`).
- ESP-IDF `dma_desc_num − 1` finished-pointer queue at EOS (the 250/249/1
  physical trace): `realtime_playback_test.cpp:1631` (three-entry queue flag
  `:1643`).
- Control inbox burst 4→8: architecture pin
  `src/device/firmware-architecture.test.ts:171-208` + behavioral proof
  `firmware/tests/metrics_subscription_test.c:809`.
- Exact host payload ledger (8 × 640 B, ninth rejected):
  `src/device/local-fetch-websocket-server.test.ts:75-137`.
- 60 s tone → exactly 3,000 frames + EOS proxy contract with pinned digest:
  `src/voice/device-pcm-proxy.test.ts:463-552`.
- Brownout banner → terminal classification:
  `src/device/device-runtime-log.test.ts:705`.
- The C-peer interop suite + known-failures ledger
  (`firmware/vendor/__tests__/c-interop.test.ts`) — the goal's Cap'n Web
  compatibility requirement.

**Add (exactly two, both red-first, both already cheap):**

1. The codec power-ceiling regression — **already written** in the
   uncommitted `firmware-architecture.test.ts` change ("limits speaker power
   at the codec rather than per PCM frame"); red against HEAD by
   construction. Land it with the fix. (A C board-ops register-table
   assertion is a fine later strengthening; not required for the slice.)
2. An adjudicator contract test: given a synthetic artifact set containing a
   serial brownout line, the verdict is `device-invalid`, and given a
   missing serial log the verdict can never be `valid` (§11 rule 3). One
   test file over pure functions; no hardware.

Explicitly **not** adding: another acoustic analyzer, more endurance-matrix
permutations, a PING/PONG barrier test (the protocol change itself is
deferred), or any new fake of ESP-IDF internals.

**Delete / trim (post-proof, from §9):** `bounded_playback_test.cpp` (+ its
389-LOC subject), `display_refresh_gate_test.cpp` (+ subject), the vacuous
`local-fetch-websocket-server.test.ts:143` assertion, and — when the next
schema bump forces edits anyway — collapse the four-place schema-2 decode
coverage (`kit-control-diagnostics.test.ts`, `control-mount-diagnostics.test.ts`,
`stackchan-simulator.e2e.test.ts:431-475`, `metrics_subscription_test.c:809+`)
to one C source of truth plus one TS parser suite. The TS mirror
`playback-recovery-policy.test.ts` duplicates C invariants that cannot fail
independently; keep it only if it keeps catching evidence-flattener bugs,
else fold into the flattener tests.

## 13. Explicit deferrals (parent goal keeps them; the slice does not)

Reported as deferred, not silently dropped — additions to the landing doc's
own list:

- kit-path TLV in the config partition (mount path remains compiled,
  `main.cpp:138`; the goal transcript explicitly wanted it as a flash input —
  note the landing's "its configured `/kit/...` path" is satisfied only under
  the compiled-path reading; call this out in the ledger);
- continuous device RSSI in diagnostics (schema bump, §11);
- OS-mediated `itx.kit.get(...)` agent invocation (goal proof-ladder step 7);
- browser-flasher releases for m5sticks3 (`README.md:24-28` — CLI lane is the
  slice's "normal shared TypeScript path");
- create-once/direct-RX audio substrate A/B; uplink-stack collapse;
  harness split; schema single-sourcing;
- hard-abort close semantics red test (reconciliation item 2) and all
  paused §4.4 network items, pending the discriminator;
- the firmware recovery repairs the station-outage report motivates —
  single-defer ladder fix, GOT_IP reset for the PCM gate (today Wi-Fi-blind),
  fatal-latch softening, schema-v3 diagnostics fields
  (`wifi_connect_attempts`, got-IP/disconnect timestamps, reset reason) —
  post-slice, red-first, sequenced after the trigger is named;
- the merged network-owner / raw-socket+esp-tls A/B (station-outage report
  §6.2 B+C), router reconfiguration A/Bs, and the IDF v5.4.3 bump;
- StackChan/Waveshare/HA-Voice-PE, AEC, ten-minute endurance, OAuth
  hardening (already in the landing doc's deferral list).

## 14. Unsupported guesses, flagged as such

- **This review's first reading — that the pre-0508 outages were silent
  brownout reboots — was falsified mid-review** by the station-outage
  report's mount-precedes-ping ordering argument for 0421/0451 (§4.2); the
  duration match survives as corroboration of the shared join pipeline, not
  of a reboot. The replacement hypothesis this review adds — rail sag under
  0 dB speaker load degrading the radio without a reset (§4.3) — is
  speculation until the −18 dB ladder runs; the station-outage report's own
  T1 (AP admission gating) remains the alternative, and nothing in the
  required-work list depends on which wins.
- **The exact acoustic loudness of M5Unified's shipped path** (and therefore
  "the fix is N dB quieter/louder than stock") is not derived; the mixer's
  final normalization constant was not chased. The verified statement is
  narrower: the shipped path interposes named digital attenuation factors the
  kit path lacked entirely, and the library treats `0x32` as the gain knob.
- **Whether −18 dB has sufficient rail margin** is a physical question the
  ladder answers; the number is an engineering guess with the right shape
  (bounded, named, asserted), not a measured safe operating point.
- **Workers wall-clock/CPU behavior for a 60 s+ PCM relay** in the real
  worker is asserted plausible, unmeasured (§6.3).
- The 0451/0421 non-remount mechanism remains unexplained; the
  station-outage report's three retained-witness candidates (§4.2) are its
  speculation, adopted here as the working frame, with the fixes deferred
  post-slice (§13).
- Subagent-collected file/line citations were spot-checked (Grok model pin,
  mount path, M5Unified codec table and mixer lines, `/api`+`/pcm` URL
  derivation, PTT flow, brownout config) but not exhaustively re-read;
  treat unspot-checked line numbers as accurate to within normal drift.

## 15. Shortest proof sequence

1. **Land the uncommitted fix** (codec ceiling + architecture test +
   sdkconfig comment), rebuild, post-link audit, flash by stable serial
   `70:04:1D:D5:45:88`.
2. **Discriminator ladder** (§3.3/§4.3): five 60 s tone runs + one 120 s run,
   serial monitor + dual ping sidecars on every run, e.g.:

   ```sh
   pnpm --dir apps/kit device:e2e -- \
     --port /dev/cu.usbmodem11201 \
     --build-directory firmware/targets/m5sticks3/build \
     --direct-lan-host <mac-ip> --direct-lan-port 58685 \
     --tone-playback-only --playback-duration-ms 60000 \
     --device-clocked-downlink --device-clocked-startup-frames 7 \
     --control-churn-hz 20 --exit-after-remote-proof
   ```

   Serial monitor on every run (the non-resetting variant exists behind
   `ITERATE_KIT_SERIAL_DIAGNOSTICS=1`). Zero brownout banners and zero
   station outages required. Outcome handling: brownouts **and** outages both
   vanish → the outage family closes as power-triggered and networking work
   resumes only if a new failure shape appears; a brownout banner recurs →
   power/supply investigation (hub port, cable, M5PM1 charge state, further
   attenuation) before any firmware change; an outage recurs **without** a
   banner → §4.3 is refuted, and the run's retained disconnect reason (churn
   retention, §4.4) arbitrates the station-outage report's T1/T2 candidates
   with real footing.

3. **Physical-PTT mode** (§7, 2–4 h) and **adjudicator including the §4.4
   host-only retention items** (§11, ~0.5–1 day) in parallel with the ladder.
4. **Real userspace worker** (§6.3, ~1 day): project worker serving `/api` +
   `/pcm` with `tone|prbs31|grok`; Grok key as project secret (key currently
   lives in Doppler project `voice`, config `dev_jonas`).
5. **Fresh-flash proof run** (landing items 1–6 in one retained bundle):
   full CLI flash with `os_base_url` = the worker origin
   (`ITERATE_KIT_WIFI_*` / project env via `scripts/flash.ts`), then one run
   that performs: deterministic 60 s tone through the worker (`mode=tone`),
   then a physical held-button Grok turn (`mode=grok`,
   `grok-voice-think-fast-2.0`), audible response, adjudicator verdict
   `valid`, all artifacts + hashes retained.
6. **Achieved/deferred ledger** (§13) appended to the landing doc.

Steps 3–4 are pure TypeScript and independent of the ladder outcome; nothing
in this sequence waits on resolving the §4.2 non-remount ambiguity unless the
ladder itself fails without a brownout trace.
