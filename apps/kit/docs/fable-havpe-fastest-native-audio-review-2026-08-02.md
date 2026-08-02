# Fable review: fastest clean Home Assistant Voice PE vertical slice — 2026-08-02

Read-only review. Sources, at exact revisions: iterate `c-capabilities` @
`88d0e6eb1`; `~/src/github.com/esphome/home-assistant-voice-pe` @ `7f6c0b726`
(2026-02-19, "Fix announcements without presound/build with Esphome 2026.2");
`~/src/github.com/esphome/esphome` @ `31f4b4d00` (dev); `~/esp/esp-idf` @
v5.4.2 (the kit's pinned line, `targets/stackchan/main/idf_component.yml:2-3`).
Only this file was created; no source, device, or deployment was touched.
Claims are labelled **C** (confirmed by reading first-party code/evidence),
**M** (retained physical measurement), **H** (hypothesis/inference). One
citation caveat carried throughout: the HAVPE production build floor is
ESPHome 2026.2.0 (`home-assistant-voice-pe/.github/workflows/build.yml:24`),
while non-`voice_kit` ESPHome component citations below come from the local
`dev` checkout; `aic3204` was cross-checked byte-equivalent against the
historical in-repo copy (`git show b3f07f0~1`), the others may drift by a few
lines.

## Executive verdict

Build the first HAVPE slice **native ESP-IDF**, as a fourth kit target that
swaps exactly one platform component: a `havpe_audio_owner` that reproduces
the eight-function CoreS3 owner contract
(`platforms/iterate_core_s3_audio/include/iterate/kit/platforms/core_s3_audio_owner.h:145-221`)
over two slave-role I2S channels, a ported ~30-write AIC3204 init, and a
~120-line XMOS control client (reset, version gate, pipeline-stage
write+read-back — **no DFU**). Everything else — pcm_lane, clocked playback,
capture turn, generation fence, playback interruption, both WebSocket
transports, the capability profile machinery, the userspace `/pcm` worker,
and the manifest-writing proof harness — is reused unchanged (**C**; the
whole downlink/uplink policy layer is already sample-rate- and
device-agnostic, `components/core/include/iterate/kit/pcm_clock_playback.h:76-101`,
`pcm_capture_turn.h:76-99`). The device is *simpler* than StackChan, not
harder: the XMOS does the AEC in hardware, deleting the ESP-SR dependency,
the ISR tap, the capture reserve, and both DSP task deadlines. The one
genuinely new physical risk — ESP32-S3 as I2S **slave** on both buses with
STD-mode `bclk_div` hard-pinned to 8 — is exactly the configuration the
stock firmware has shipped on this hardware for a year (**C**), so it is a
verify-at-stage-A item, not a research item. The prior review's abstraction
ruling stands and is re-confirmed here: no shared DSP framework; the HAVPE
seam survives *because* the DSP stays device-specific
(`docs/fable-stackchan-fastest-next-proof-2026-08-02.md` §8).

## 0. Hardware contract: verified, with two corrections

All verified first-hand in `home-assistant-voice-pe/home-assistant-voice.yaml`
(**C**):

| Claimed | Verdict | Cite |
| --- | --- | --- |
| Internal I2C SDA GPIO5 / SCL GPIO6 | ✓ (400 kHz, one bus) | `:112-116` |
| XMOS reset GPIO4, I2C 0x42 | ✓ (0x42 is the schema default, not in yaml) | `:1654`; `voice_kit/__init__.py:131` |
| Mic I2S 16 kHz s32 stereo, WS 14 / BCLK 13 / DIN 15, ESP32 secondary | ✓ | `:1495-1512` |
| Playback I2S 48 kHz s32 stereo, WS 7 / BCLK 8 / DOUT 10, ESP32 secondary | ✓ slot width 32; **stock transmits 16-bit data left-justified in the 32-bit slots** | `:1514-1527`; `esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp:640,660` |
| AIC3204 at 0x18 | ✓ (schema default) | `:1701-1704`; `aic3204/audio_dac.py:23` |
| Speaker amp enable GPIO47 | ✓ (`ALWAYS_OFF` at reset; turned on once ~1 s after boot, never off) | `:263-269`, `:42-48` |
| XMOS ch0 = full AEC→IC→NS→AGC | ✓ **but it is a configuration the host writes at boot**, not a hardware fixture: ch0 defaults to the AGC-stage tap, ch1 to the NS-stage tap | `voice_kit/__init__.py:86-91`; `voice_kit.h:49-55`; `voice_kit.cpp:113-131` |

Additional load-bearing facts the contract didn't state (**C**):

- **No MCLK reaches the ESP32** on either bus; the AIC3204's 24.576 MHz MCLK
  comes from the XMOS directly (`aic3204.cpp:25-27`), and the codec is a
  *third* I2S slave on an XMOS-mastered link we never see. The audio path is
  ESP32 →(slave TX)→ XMOS →(master)→ AIC3204; the AEC reference is taken by
  the XMOS from that stream internally (**H** for the internal tap — no doc
  in the repo states it, but nothing else can supply it).
- **Hardware mute slider on GPIO3** (`:495-498`); the mics go silent at the
  hardware level and GPIO3 only *senses* it. The reset polarity is
  active-HIGH (1 ms high pulse then low, `voice_kit.cpp:19-22` — inferred
  from code, no schematic; **H** for polarity, **C** for the sequence).
- Stock waits **3,000 ms after reset release** before the first XMOS I2C
  transaction (`voice_kit.cpp:23-24`), and `can_proceed()` blocks boot until
  the version is read (`voice_kit.h:126-128`).
- Board: `esp32-s3-devkitc-1`, 16 MB flash, **octal** PSRAM @ 80 MHz
  (`:58-81`, `:118-121`) — the one sdkconfig delta from StackChan's quad
  PSRAM (`targets/stackchan/sdkconfig.defaults:9`).

## 1. Native ESP-IDF owner vs ESPHome external component

**Recommendation: native ESP-IDF. This is not close.**

What an ESPHome wrap would actually cost (**C**):

- The current HAVPE repo contains exactly **one** first-party component
  (`voice_kit`); the audio path is five chained upstream components
  (`speaker_source` media player → 2× `resampler` → `mixer` → `i2s_audio`
  speaker), pinned to **five external git refs of ESPHome PRs**, four of
  which don't even resolve in the local checkout
  (`home-assistant-voice.yaml:1660-1692`). The kit would inherit that pin
  lattice plus ESPHome's Wi-Fi/OTA/API runtime beside its own transports.
- The ESPHome audio components violate every kit invariant the proofs are
  built on: heap-allocated pipelines, unpinned tasks at priorities 1/10/19/23
  (`i2s_audio_speaker.cpp:26-27`, `mixer_speaker.cpp:16`,
  `resampler_speaker.cpp:18`, `i2s_audio_microphone.cpp:24-25`), a mic that
  **discards partial reads on timeout** (`i2s_audio_microphone.cpp:442-450`),
  **never registers `on_recv_q_ovf`** (so RX overflow is invisible), and no
  counter surface at all. The bounded-accounting manifest gates
  (`scripts/prove-production-stackchan-grok.ts:938-1115`) cannot be
  satisfied through that stack without rewriting it — at which point nothing
  was reused.
- What ESPHome would have contributed is two I2C bring-up sequences and pin
  facts. Those are ~240 lines of readable C++ that this review has already
  extracted verbatim (§4, §5). Time saved by wrapping: negative.

What native costs: one new platform component (~900 lines including metrics,
§9), one trimmed device profile, one target. The StackChan target is already
pure composition (`targets/stackchan/main/main.c:44-59`), so the fourth
target is a rhyme, not a port. Risk concentrates in codec/XMOS init and
slave-I2S behavior — both covered by the ladder's tone stage before any
network code runs (§7).

## 2. Smallest correct I2S owner when both buses are XMOS-clocked

Two independent **slave** channels on the two controllers (S3 has two,
`soc/esp32s3/include/soc/soc_caps.h:228`), one simplex channel each. Do
**not** allocate TX+RX in one `i2s_new_channel` call: that sets
`full_duplex`, which forcibly **shares BCLK/WS** between directions
(`esp-idf/components/esp_driver_i2s/i2s_std.c:114-125`,
`i2s_common.c:1008-1010`) — impossible here since the buses have different
clocks. Slave role makes BCLK/WS inputs (`driver/i2s_std.h:275-276`); MCLK
stays `I2S_GPIO_UNUSED` (checked and skipped, `i2s_common.c:906-910`).

Critical slave-mode fact, verified in driver source (**C**): the configured
`sample_rate_hz` and slot geometry are **still used** — the driver derives
its internal oversampling MCLK as `rate × total_slot × slot_bits × 8`
(`i2s_std.c:46-50`; the "fix bclk_div to 2" comment is stale, the code sets
8). A mismatch with the master's real clocks is **silent data corruption,
with no error path anywhere in the driver** (absence verified across
`i2s_std.c`/`i2s_common.c`/`hal/i2s_hal.c:104-197`). So the configs below
must state the XMOS truth exactly.

**RX (mic), I2S controller A:**

```c
chan: { .role = I2S_ROLE_SLAVE, .dma_desc_num = 5, .dma_frame_num = 320,
        .auto_clear = false }
clk:  I2S_STD_CLK_DEFAULT_CONFIG(16000)           /* internal MCLK 8.192 MHz */
slot: data_bit_width = 32, slot_bit_width = 32, STEREO, SLOT_BOTH,
      Philips (bit_shift = true), no inverts
gpio: mclk UNUSED, bclk GPIO13, ws GPIO14, din GPIO15, dout UNUSED
```

One descriptor = 320 frames × 8 B = 2,560 B = one exact 20 ms wire frame per
channel (≤ 4,092 B cap, `i2s_common.c:69-75`). Effective queue depth is
`desc_num − 1 = 4` (`i2s_common.c:334`) → 80 ms RX tolerance, above
CoreS3's 64 ms reserve and stock's 48 ms. The capture task does a blocking
`i2s_channel_read` of exactly 2,560 B (timeout ~200 ms; note the timeout
applies per DMA buffer inside the read loop, and partial data on timeout is
valid — `i2s_common.c:1331-1371` — never discard it the way stock does).
Register `on_recv_q_ovf` (IRAM, counter-only): overflow evicts the **oldest**
buffer silently (`i2s_common.c:602-609`) and is otherwise invisible.
`i2s_channel_enable` resets the RX queue (`i2s_common.c:1177-1181`), so
enabling only after the XMOS version gate passes gives a fresh first frame —
no CoreS3-style startup drain needed.

**TX (speaker), I2S controller B:**

```c
chan: { .role = I2S_ROLE_SLAVE, .dma_desc_num = 6, .dma_frame_num = 480,
        .auto_clear = true }
clk:  I2S_STD_CLK_DEFAULT_CONFIG(48000)           /* internal MCLK 24.576 MHz */
slot: data_bit_width = 16, slot_bit_width = 32, STEREO, SLOT_BOTH,
      Philips, no inverts                          /* 16-bit LJ in 32-bit slots */
gpio: mclk UNUSED, bclk GPIO8, ws GPIO7, dout GPIO10, din UNUSED
```

16-bit data in 32-bit slots is exactly what stock ships
(`i2s_audio_speaker.cpp:640,660`) — proven against this XMOS/codec — and
keeps a descriptor at 480 frames × 4 B = 1,920 B (10 ms), queue depth 5 →
50 ms. `auto_clear = true` makes underrun emit **zeros**; without it the DMA
ring **replays stale audio** (`i2s_common.c:650-655`, `i2s_common.h:70-72`).
Preload one silence chunk before enable (`i2s_channel_preload_data`,
`i2s_common.c:1228-1283`, check `bytes_loaded`), then never disable the
channel for the life of the session (stock's `timeout: never`, yaml `:1525`,
exists for the same reason — slave buses don't re-negotiate; and the XMOS
AEC reference is this stream, so stopping it degrades AEC, **H**).

**Known residual risk, with mitigation:** IDF documents slave-TX data lag at
high rates — STD mode pins `bclk_div = 8` with no knob
(`i2s_std.c:47`; `docs/en/api-reference/peripherals/i2s.rst:766`), and IDF's
own 48 kHz slave test needed 12 via TDM mode
(`test_apps/i2s_multi_dev/main/test_i2s_multi_dev.c:193-196`). Stock HAVPE
ships STD slave at 48 kHz and works (**C**), so start there; if the stage-A
tone FFT shows corruption, the bounded fallback is
`i2s_channel_init_tdm_mode` with two slots and `bclk_div = 16` — same wire
format, one config struct swapped.

**Tasks:** two, both pinned core 1, static stacks (4,096 B), mirroring
CoreS3's numbers (`core_s3_audio_owner.c:27-31`): `havpe-play` at priority
23 — service generation fence → playback interruption → direct reset (the
one-reset-per-edge arbitration copied from
`core_s3_audio_owner.c:793-824`), render 160 mono samples via
`pcm_clock_playback`, convert (§3), one blocking 1,920 B write (~10 ms
pace); `havpe-cap` at priority 22 — blocking 2,560 B read (~20 ms pace),
extract ch0 → one 320-sample frame, `pcm_capture_turn_poll` + `submit`,
notify uplink. Two tasks, not CoreS3's one, because these are two
*independent* external clock domains; serializing two blocking waits with
unrelated phases in one loop would add up-to-20 ms playback service jitter
for no benefit. No AEC task, no ISR tap, no capture reserve — the blocking
read replaces all three (deletions, §6). Fence/interruption stay owned by
the playback task; `request_uplink_active` keeps the SPSC
command-queue-plus-consumer-poll shape via `pcm_capture_turn`
(`pcm_capture_turn.h:129-152`).

## 3. 16 kHz mono PCM16 → 48 kHz stereo: is 3:1 repetition acceptable?

Numbers first (my arithmetic over the standard upsampler identities, **C**):
3× zero-order hold (repeat each sample three times) is upsample-by-3 plus a
[1,1,1] boxcar; its images of a baseband tone f₀ appear at 16 kHz ∓ f₀
attenuated only by sin(3πf/48k)/(3·sin(πf/48k)):

- 1 kHz content → image at 15 kHz at **−22 dB**;
- 3 kHz content → image at 13 kHz at **−12 dB**.

−12 dB spurs at 13 kHz from real speech energy are audible as metallic
brightness on a codec whose DAC reconstruction filter cannot remove in-band
images. ZOH is fine for a *tone* stage (generate the tone at 48 kHz
directly) but is the wrong default for speech.

**Cheapest correct conversion: linear interpolation** (first-order hold) —
the ZOH numbers squared: ≈ −44 dB at 15 kHz for 1 kHz content, ≈ −24 dB at
13 kHz for 3 kHz content, below the small speaker's response and speech
masking. Cost: for each input pair (a,b), emit `a, (2a+b)/3, (a+2b)/3` —
two multiply-adds per output sample, ~0.3 M int ops/s, no state beyond one
retained sample. That is not meaningfully more code than repetition (≈10
lines), so ship linear from the first spoken proof and skip the ZOH interim
entirely. A polyphase FIR (what stock's `resampler` wraps,
`esphome/components/audio/audio_resampler.cpp:46-71`) is the escalation
path, not the start.

**Measurable quality gate**, using tooling that already exists: play the
stage-A 1 kHz reference through the full path, capture on the Mac microphone
(`src/device/macos-pcm16-capture.ts`, wired at
`prove-production-stackchan-grok.ts:566-605`), FFT the capture, and require
every non-harmonic spur in 10–20 kHz to sit **≥ 30 dB below the
fundamental**; for speech, the unchanged STT oracle
(`scripts/transcribe-pcm16.ts`) must match exactly. If linear ever fails
that spur gate, escalate to a 3-phase × 8-tap polyphase; do not tune
further on a hunch.

Bit placement: PCM16 samples pass through **unscaled** into the 16-bit
left-justified TX slots (§2), and loudness is owned by the AIC3204 volume
register (§4) — no sample arithmetic on the downlink, mirroring the
no-digital-gain ruling that survived measurement on StackChan
(`docs/fable-stackchan-fastest-next-proof-2026-08-02.md` §1). Uplink: read
the 32-bit slot, take the top 16 bits (`>>16`) — the exact stock conversion
(`esphome/components/audio/audio.h:181-183`), gain 1, no knobs; the XMOS
AGC on ch0 owns level.

## 4. AIC3204: indispensable init, the 2.5 s soft-start, safe volume

Port the stock sequence verbatim — it is short, ordered, and proven; all
cites `esphome/components/aic3204/aic3204.cpp` (**C**). Indispensable
set, in order:

**Page 0 — clocks/interface** (`:19-46`): select page 0 (0x00=0x00); SW
reset (0x01=0x01); NDAC=2 powered (0x0B=0x82); MDAC=2 powered (0x0C=0x82);
DOSR=128 (0x0E=0x80); codec IF = I2S/32-bit (0x1B=0x30); SCLK/MFP3 audio
data in (0x38=0x02); 0x1F=0x01, 0x20=0x01; processing block PRB_P1
(0x3C=0x01). **No PLL registers — ever.** CODEC_CLKIN defaults to the MCLK
pin and the XMOS supplies 24.576 MHz = NDAC·MDAC·DOSR·48 kHz exactly
(`:25-27`). If the XMOS is dead, the codec has no clock: XMOS gate first.

**Page 1 — analog** (`:49-92`): page 1; LDO enable (0x02=0x09); disable
crude AVdd (0x01=0x08); master analog on (0x02=0x01); common mode 0.75 V
(0x0A=0x40); DAC PTM_P3/4 (0x03=0x00, 0x04=0x00); **REF fast charge 40 ms
(0x7B=0x01)**; HP soft-step config (0x14=0x25); route DACs to HP and LO
(0x0C..0x0F each =0x08); HP gain −2 dB unmuted (0x10=0x3E, 0x11=0x3E); LO
0 dB unmuted (0x12=0x00, 0x13=0x00); power up all four drivers (0x09=0x3C).

**The 2.5 s is code-side and asynchronous** (`:94-106`): stock arms a
non-blocking 2.5 s timeout and only then, on page 0, powers the DACs
(0x3F=0xD4), writes volume (0x41/0x42), and unmutes (0x40). Replicate as a
deadline on the cooperative owner, never a task delay: the owner starts I2S
silence immediately; audio is simply inaudible until the codec finishes
stepping. Stage A must not classify silence inside the first ~2.5 s + 40 ms
as failure (trap §8.5). Amp enable (GPIO47) in stock goes high ~1 s after
boot, *before* unmute (`home-assistant-voice.yaml:42-48`) — mirror stock's
ordering rather than inventing pop management.

**High but safe volume:** stock maps UI volume to the DAC digital volume
byte `−127 + volume×175` clamped [−127, +48] (`:153-167`), with UI bounds
0.4–0.85 (`home-assistant-voice.yaml:1618-1620`) ⇒ shipped range ≈ −28.5 dB
to **+10.5 dB** (0.5 dB/LSB is TI-datasheet knowledge, not in-repo).
Positive digital gain clips full-scale PCM16, and the kit sends unscaled
provider audio (§3). Set **0x41=0x42=0x00 (0 dB)** for the proof — at the
top of stock's *unclipped* range, physically loud through the same −2 dB
HP / 0 dB LO analog stages — and revisit only on acoustic-oracle RMS
evidence, the same discipline as StackChan's volume-100 curve
(`core_s3_audio_owner.c:48-57`).

## 5. XMOS without DFU: reset, version gate, and proving the channel

**Protocol** (all **C**, `voice_kit.h:16-28`, `voice_kit.cpp`): I2C 0x42,
device-control framing `{resid, cmd, len, payload…}`; reads write
`{resid, cmd|0x80, len}` then read `len` bytes whose byte 0 is a return code
(`CTRL_DONE=0`). Two resources matter: DFU servicer 240 (only for
`GETVERSION=88`) and configuration servicer 241.

**Indispensable, in order:**

1. Reset: GPIO4 high 1 ms → low, then a **3 s boot allowance** before the
   first transaction (`voice_kit.cpp:15-24`). Implement as a poll with
   deadline (e.g. GETVERSION every 250 ms, ≤ 5 s), counter on timeout.
2. Version gate: read `{240, 88|0x80, 4}` → `[rc, major, minor, patch]`
   (`voice_kit.cpp:305-328`). Require **exactly 1.3.1** (the version the
   stock DFU image pins, `home-assistant-voice.yaml:1655-1658`) and fail
   the audio owner loudly on anything else. **No DFU port.** The escape
   hatch costs zero code: flash stock HAVPE firmware once — it auto-DFUs
   the XMOS **upgrade** slot to 1.3.1 (factory slot never written,
   `DFU_INT_ALTERNATE_UPGRADE`, `voice_kit.cpp:341-343`, `voice_kit.h:64-67`)
   — then flash the kit target. Do not port the stock reboot helper as-is;
   it has an out-of-bounds read (3-byte array written with length 4,
   `voice_kit.cpp:330-334`).
3. Pipeline stages: write `{241, 0x30, 1, 4}` (ch0 = AGC tap ⇒ full
   AEC→IC→NS→AGC) and `{241, 0x40, 1, stage}` for ch1
   (`voice_kit.cpp:113-131`), then **read both back** with
   `{241, cmd|0x80, 2}` (`read_pipeline_stage`, `voice_kit.cpp:91-111` —
   present upstream but *unused by stock*; using it is our config-proof).
   Mismatch ⇒ capture_failed, loud.

**Proving ch0 is the processed channel, not raw/NS-only:** the stage write
is a claim; the proof is differential and physical, and the hardware gives
us a second channel to make it cheap:

- **Config-level:** read-back equals written value (above) — proves the
  XMOS accepted the tap selection, not that audio is clean.
- **Signal-level (stage B, no network):** ch1 is independently
  configurable. Set ch1 = `NONE` (stage 0) for bring-up. What `NONE` emits
  is **not documented in this checkout** (`voice_kit.h:42` points at the
  XMOS firmware repo; flagged unconfirmed) — so measure it: during far-end
  tone playback in a quiet room, if ch1(NONE) carries ≈ room-loud energy
  while ch0 is suppressed, `NONE` is raw-enough and becomes the permanent
  near-end reference; the far-end gate is then
  `ch0_mean_abs / ch1_mean_abs` under playback — same shape as the
  StackChan 8.49 dB gate (**M**,
  `docs/stackchan-vertical-slice-landing-2026-08-02.md:69-84`). If `NONE`
  turns out processed or silent, fall back to ch1 = `NS` (stock's tap) and
  prove AEC differently: ch0 energy during loud far-end-only must stay
  within a bound of the silent-room baseline *while the Mac oracle measures
  the room loud* (suppression against an acoustic, not electric,
  reference), plus a 60 s echo-census: zero provider `speech_started`
  during playback (`pcm-proxy.ts:1002-1015` events are already journaled
  per device, `provider-event-stream.ts:5-15`).
- **Behavior-level (stage D):** the interruption leg only works if the far
  end can barge in over playback — a passing interruption manifest is
  itself AEC evidence (**M** precedent: the StackChan proof).
- Bonus diagnostic, free: `read_vnr()` (`voice_kit.cpp:73-89`, resid 241
  cmd 0x00) returns the XMOS's own voice-activity estimate — a one-line
  mic-liveness probe for stage B, also unused by stock.

## 6. Reuse vs device-specific; deletions that avoid the 976-line copy

**Reused unchanged (zero edits):** `pcm_lane`, `spsc_ring`,
`pcm_clock_playback` (already chunk-size-agnostic and silence-classifying,
`pcm_clock_playback.h:76-101`), `pcm_capture_turn` (SUPPRESS_END_MARKER
mode, `core_s3_audio_owner.c:1027-1036` shows the wiring),
`pcm_generation_fence`, `pcm_playback_interruption`, `audio_intent_reconciler`,
`retry_gate`, both esp-idf transports (`pcm_transport.c`, `itx_transport.c`,
`websocket_connection.c`) including the mode header
(`pcm_transport.c:296-334`), `itx_connection`/`peer`/capnweb, capabilities
(`conversation`, `metrics`, `device_event_stream`), `configuration` +
`ITERKIT1` partition flashing (`configuration.c:31`,
`src/firmware/config-image.ts:14-26` — note it already carries a separate
`pcmBaseUrl`, tag 6), and the entire host harness + userspace worker with
`X-Iterate-Kit-Audio-Mode: full-duplex-aec` (`routes.ts:4-6,118-121`,
`worker.ts:319`).

**Extract now — two moves, no new nouns** (both are transport-owned schema
mapping that today sits duplicated in the target):

1. The control/PCM transport → `control_diagnostics` fill,
   `targets/stackchan/main/main.c:404-509` (~105 lines), and the transport →
   `sample->audio.uplink/downlink/buffers` fill, `main.c:289-349` (~50
   lines): move into `platforms/iterate_esp_idf` as one pure function over
   the two already-public metric structs. It maps esp-idf transport metrics
   into the shared sample schema — platform code describing platform data.
2. `reconcile_pcm_conversation`, `main.c:736-843` (~107 lines): it touches
   only the transport, `conversation_active`, and two flags — a
   transport-lifecycle helper that belongs beside
   `iterate_kit_esp_idf_pcm_transport_poll`.

StackChan's main.c shrinks by the same ~260 lines in the same change, and
the HAVPE main lands at roughly 550–600 lines of genuinely target-specific
composition: ring storage + policy constants, device init, owner options,
owner-specific metrics mapping (`audio.capture`, aec/uplink view), mount
path `{"kit","havpe"}`, `device_id = "havpe"` (grammar already shared,
`src/userspace/config-worker/device-id.ts:1-11`).

**Stays device-specific (deliberately not shared):** the whole
`havpe_audio_owner` including conversion, codec init, XMOS client, and its
metrics struct. The temptation to abstract "audio owner" into a vtable is
explicitly refused — re-affirming
`fable-stackchan-fastest-next-proof-2026-08-02.md` §8: the seam is the
eight public functions and the lane, and it survives because each DSP stays
concrete. The owner *contract* is copied as a rhyme (same names,
`havpe_` prefix), which `main.c` composes exactly as StackChan does at
`main.c:619-628,695-704,881-894`.

**Deletions/simplifications relative to StackChan (the point of this
device):**

- **No ESP-SR** (`espressif__esp-sr` dep gone from
  `idf_component.yml`), no `aec_capture_bridge`, no
  `core_s3_capture_reserve`, no ISR tap, no AEC task, no 512-sample
  reframing — the blocking 20 ms read *is* the frame clock. CPU headroom:
  StackChan's 452‰ (**M**, landing doc `:92`) carried software AEC; HAVPE's
  DSP cost is the ×3 interpolation, ~1% of one core (**H**, trivially
  bounded).
- **No esp_codec_dev, no BSP override component** — there is no AIC3204
  driver in esp_codec_dev anyway; ~30 raw register writes through
  `i2c_master` beat an adapter layer.
- **No `iterate_stackchan_hardware`-style stub layer**: `devices/havpe` is
  `devices/stackchan/stackchan.c` minus screen/servos/camera modules
  (conversation + metrics + event stream + LEDs-later), and minus the
  unreachable duplicate PTT-reject arm (`stackchan.c:84-86`) that the prior
  review already flagged.
- **No new metrics schema.** If ch1(NONE) proves raw, publish the existing
  AEC view with near:=ch1, reference:=rendered playback window,
  clean:=ch0, reusing `aec_signal_window` verbatim (it is pure,
  `components/core/src/aec_signal_window.c`) and documenting that the
  reference is a digital render, not CoreS3's measured analogue divider
  (`targets/stackchan/main/main.c:334-340,350-355` states the house rule:
  honest absence over fabricated schema). If ch1 can't serve, set
  `enable_aec_view = false` and let the acoustic oracle carry suppression
  evidence.

## 7. Staged physical bring-up ladder

Every stage has hard counters and a stop rule; nothing advances on vibes.
Boot-mode note: the center button is GPIO0 (`home-assistant-voice.yaml:273-277`)
— hold it while connecting USB for download mode; console is
USB-Serial-JTAG as on StackChan (`sdkconfig.defaults:33`).

- **Stage 0 — host red tests** (§11). No hardware.
- **Stage A — codec tone, no network, no mic.** Build flag
  (`HAVPE_BRINGUP_TONE`) swaps the transport for a local generator feeding
  the lane 20 ms 1 kHz frames. Sequence proven by counters logged 1/s:
  `xmos_version_ok` (=1.3.1), `pipeline_stage_readback_ok`, aic3204 write
  errors =0, amp_enabled, `tx_writes`, `tx_write_timeouts`=0. Oracle: Mac
  mic hears the tone ≥ 2.5 s after boot; FFT spur gate from §3.
  Attribution when silent: version fail ⇒ XMOS (reset polarity/boot);
  i2c NACK ⇒ wiring/address; writes blocking/timeout ⇒ no BCLK (XMOS not
  clocking); clean counters + silence ⇒ amp GPIO47 / codec unmute /
  soft-start window; harsh spectrum ⇒ bit alignment or slave-TX lag
  (§2 fallback).
- **Stage B — microphone + AEC discrimination, no network.** Same build
  logs per-second ch0/ch1 window stats (stride-8 `aec_signal_window`).
  Checks in order: mute slider off **and** GPIO3 sensed (else all-zero
  mics, trap §8.3); speak ⇒ ch0 energy moves, VNR moves; silence ⇒ floor;
  tone playback in quiet room ⇒ the §5 channel proof (decides the ch1
  policy). Stop rule: ch0 ≈ ch1 ≈ room-loud during playback ⇒ stage
  config not applied — do not proceed to network with raw echo.
- **Stage C — deterministic network, production-shaped.** Provision the
  `iterate_kit` partition (`scripts/flash.ts`), install the userspace
  worker, set project KV `kit-pcm-mode = tone` — the deterministic
  provider at the same seam (`worker.ts:561-573`,
  `providers.ts:226-293`). Full transport gates with zero provider
  variance: frame conservation, freshness/restart counters zero, depth-zero
  termination, interval-aligned network verdict `valid`
  (`src/device/physical-network-validity.ts:133-466`). This is where
  Wi-Fi/TLS/backlog issues surface attributed to network, not audio.
- **Stage D — production Grok.** `kit-pcm-mode = grok`, real
  `grok-voice-think-fast-2.0` (`providers.ts:359-360`), server VAD
  `{threshold 0.1, prefix 400, silence 1000}` (`providers.ts:441-457`),
  silent start, one spoken turn with exact STT oracle, near-end acoustic
  interruption with the race-independent completion gate, memory/CPU
  sample, network `valid` — the StackChan gate set
  (`prove-production-stackchan-grok.ts:842-1115`) with a HAVPE assessment
  variant replacing `stackchan-aec-assessment.ts` thresholds per §5, and a
  `havpe` dispatch branch in the orchestrator
  (`prove-production-grok-from-device.ts:178-181`). Manifest written only
  on full pass, same append-only discipline.

## 8. Trap census (bricking, silence, clocking, overflow, backlog, proof)

1. **XMOS held in reset / not booted** ⇒ no BCLK on either bus ⇒ slave
   reads/writes block forever and I2C times out. Reset is active-high
   1 ms pulse; allow 3 s boot before first I2C (`voice_kit.cpp:15-24`).
   Gate I2S enable on the version read. Counters:
   `xmos_boot_timeouts`, `i2c_failures`.
2. **Version-gate policy, not DFU** (§5). A mid-transfer DFU abort is the
   only real XMOS-brick vector in the stock design; we never open it, and
   stock's own writes only touch the upgrade slot
   (`voice_kit.cpp:341-343`). ESP32-side "bricking" is recoverable by
   published factory image + GPIO0 download mode; stock has **no** factory
   app partition to preserve (generated OTA pair,
   `esphome/components/esp32/__init__.py:1863-1872`), so flashing the kit
   target destroys nothing unrecoverable.
3. **Hardware mute slider (GPIO3)** silences the mics at hardware level
   (`home-assistant-voice.yaml:495-498`); read and export it, else stage B
   misattributes a dead mic. Also: center button GPIO0 is a strap pin —
   input only.
4. **Amp enable GPIO47 defaults OFF** (`:263-269`): perfect digital chain,
   zero sound. Export `amp_enabled`.
5. **2.5 s analog soft-start + 40 ms REF charge** (`aic3204.cpp:68,94-106`):
   silence in the first seconds is *expected*; stage A's listen window
   starts after it. Misattributing this window historically wastes runs.
6. **Bit alignment**: Philips `bit_shift` on both ends; TX 16-in-32
   left-justified; RX take top 16 of 32. A `left_align`/`ws_pol`/width
   mismatch produces quiet garbage or harsh noise, and the driver will
   never error (§2 silent-corruption finding). The stage-A FFT and stage-B
   energy floors are the detectors.
7. **STD slave-TX `bclk_div = 8` data lag** at 48 kHz (`i2s_std.c:47`,
   `i2s.rst:766`): stock-proven, but if stage A shows malposition the
   fallback is TDM-mode 2-slot with `bclk_div ≥ 12` — do not debug past
   one day without switching.
8. **RX overflow is silent and drops oldest** (`i2s_common.c:602-609`);
   effective queue depth is `desc_num − 1` (`i2s_common.c:334`). Register
   `on_recv_q_ovf` (IRAM-safe — `CONFIG_I2S_ISR_IRAM_SAFE=y` stays, as in
   `sdkconfig.defaults:47`), count, and treat as a capture discontinuity;
   uplink freshness policy (640 ms,
   `main.c:109-111`) already bounds staleness.
9. **TX underrun without `auto_clear` replays stale audio**
   (`i2s_common.c:650-655`) — set it, and still render continuous silence
   so it never triggers in steady state; count `tx_write_timeouts`.
10. **Never stop/reconfigure the TX channel mid-session**: slave buses
    can't renegotiate (stock pins `timeout: never`, yaml `:1525`) and the
    XMOS AEC reference rides this stream (**H**) — a stopped stream is an
    AEC outage that looks like "echo came back".
11. **Partial-read discard bug pattern** (stock,
    `i2s_audio_microphone.cpp:442-450`): on timeout, partial DMA data is
    valid (`i2s_common.c:1364-1366`) — account it, don't drop it.
12. **Backlog/reconnect**: nothing new — reuse the uplink conductor's
    freshness/escalation ladder and the downlink generation barrier wired
    exactly as `main.c:695-704`; the 5.5 KiB control-lane stall lesson
    (commit `88d0e6eb1`) does not apply to the 640 B-frame `/pcm` lane but
    its sndbuf sizing lesson is already embedded in the shared transport.
13. **Proof traps**: session-cumulative counters need differencing (the
    harness already does); a network-`invalid` interval voids DSP
    conclusions (`physical-network-run.ts:519-526` — verdict dominance);
    ch0/ch1 both processed means a naive channel-compare can "prove" AEC
    where none of the compared signals is raw (§5 decides this before any
    gate is trusted).
14. **sdkconfig deltas that bite silently**: octal (not quad) PSRAM;
    include from day one the items StackChan deferred — armed task
    watchdog with panic and `SPIRAM_MALLOC_RESERVE_INTERNAL=98304`
    (reconciliation list, landing doc `:143-147`) — a wedged HAVPE has the
    same "no higher layer to reboot it" property
    (`core_s3_audio_owner.c:964-972` precedent).

## 9. Minimal file/module plan

```
firmware/platforms/iterate_havpe_audio/
  include/iterate/kit/platforms/havpe_audio_owner.h   # 8-fn contract, rhymes with core_s3
  havpe_audio_owner.c        # 2 tasks, 2 slave I2S channels, metrics (~450)
  havpe_codec.c              # AIC3204 table-driven init + volume (§4) (~150)
  havpe_xmos.c               # reset, GETVERSION gate, stage write+readback, VNR (~150)
  havpe_pcm_convert.c/.h     # 16k→48k linear interp + slot pack; 32→16 unpack (~80, pure C)
  CMakeLists.txt             # REQUIRES core esp_driver_i2s driver(i2c) esp_timer freertos heap
firmware/devices/havpe/
  havpe.c + include/…        # stackchan.c minus screen/servo/camera modules (~250)
firmware/targets/havpe/
  main/main.c                # composition (~550-600 after the §6 extraction)
  main/havpe_realtime_policy.h   # downlink age 400 ms (same rationale as stackchan_realtime_policy.h)
  sdkconfig.defaults         # stackchan's + SPIRAM_MODE_OCT + WDT/TLS-reserve from day one
  partitions.csv             # copy of stackchan's (factory + iterate_kit label)
firmware/platforms/iterate_esp_idf/
  transport_metrics_fill.c (or into pcm_transport.c/itx_transport.c)  # §6 extraction
firmware/tests/
  havpe_pcm_convert_test.c, havpe_xmos_test.c, havpe_codec_test.c,
  havpe_owner_playback_test.c        # host, per CMake pattern CMakeLists.txt:277-289
apps/kit/scripts + src/device/
  prove-production-havpe-grok.ts (StackChan prover parameterized),
  havpe-uplink-assessment.ts (replaces stackchan-aec-assessment thresholds),
  orchestrator branch at prove-production-grok-from-device.ts:178-181
```

New firmware code ≈ 1,100 lines + tests; net repo delta smaller because
StackChan's main.c sheds ~260.

**Note on pre-existing work in this worktree** (discovered at review time,
untracked and uncommitted; not created or modified by this review): a
skeleton already exists under the names
`platforms/iterate_voice_pe_audio/` (`voice_pe_hardware_config.c/.h` — the
AIC3204 register script split around the 2.5 s settle, plus the XMOS stage
enum — and `voice_pe_pcm_format.c/.h`), `devices/voice_satellite/`, and
three host tests wired into `firmware/CMakeLists.txt` (+76 lines). Read
this plan's `iterate_havpe_audio`/`havpe` names as mapping onto those
(`voice_pe`/`voice_satellite`) — the shapes agree. Two substantive
divergences to resolve against this review: (a) `voice_pe_pcm_format.h`
implements the playback expansion as **3:1 zero-order hold into full
32-bit words** — §3's spur numbers (−12 dB images at 13 kHz for 3 kHz
speech content) argue for linear interpolation at near-zero extra cost,
and stock's proven 16-bit-data-in-32-bit-slots halves TX DMA (§2); ZOH is
acceptable only if the §3 acoustic spur gate is actually run and passes.
(b) Its header states ch1 = `NONE` "is the original microphone tap,
before AEC" **as fact**; nothing in the HAVPE checkout documents `NONE`'s
semantics (`voice_kit.h:42` defers to the non-local XMOS firmware repo),
so that claim must be demoted to the stage-B measurement of §5 before any
AEC evidence is built on it.

## 10. Non-goals / explicit refusals

No ESPHome external component; no XMOS DFU port; no face/avatar; no LED
ring, rotary, headphone-jack, BLE/improv, or media-player features; no
generic DSP framework or owner vtable; no esp_codec_dev/BSP adapters; no
new metrics schema or manifest schema; no polyphase resampler unless the
spur gate fails; no second transport or queueing model (standing rule,
landing doc `:153-156`); no digital uplink/downlink gain knobs; no PTT mode
on HAVPE (server-VAD full-duplex only, matching the device's continuous-AEC
nature and the proven StackChan policy).

## 11. First five red tests

1. `havpe_pcm_convert_test` — linear ×3 upsample: exact output count
   (3n), seam continuity across consecutive 160-sample chunks (retained
   sample), DC and full-scale ramps preserved unclipped, stereo slot pack
   L==R; 32→16 unpack takes exactly the top 16 bits (sign-correct on
   negative full-scale).
2. `havpe_xmos_test` (fake I2C fn-ptr) — reset pulse order and idle-low;
   no transaction before the boot allowance; GETVERSION parse; wrong
   version ⇒ owner refuses start with a distinct status and counter, and
   **no** DFU/reboot command bytes are ever emitted; stage writes
   `{241,0x30,1,4}`/`{241,0x40,1,x}` followed by mandatory read-back;
   read-back mismatch ⇒ capture_failed latch.
3. `havpe_codec_test` (fake I2C) — the §4 register table byte-for-byte in
   order; DAC power/volume/unmute forbidden before the 2.5 s deadline
   tick; volume byte clamp [−127,48] and the 0 dB default; any write
   failure ⇒ playback_failed latch, no retry storm.
4. `havpe_owner_playback_test` (fake I2S write) — renders through the real
   `pcm_clock_playback` + convert: content/silence sample conservation ×3
   across lane-fed, lane-empty, and stale-discard cases; generation fence
   and interruption serviced at most one reset per 10 ms edge (the
   `core_s3_audio_owner.c:793-824` arbitration reproduced); post-purge
   render is silence, never pre-purge suffix.
5. `havpe_owner_capture_test` (fake I2S read) — 2,560 B chunks become
   exactly one 320-sample ch0 frame each via `pcm_capture_turn`
   (SUPPRESS_END_MARKER); rx-overflow callback increments the
   discontinuity counter without corrupting frame framing; partial read on
   timeout is accounted, not dropped; inactive publication discards
   explicitly (`inactive_frames_discarded` advances, nothing queues).

## 12. Ranked bounded execution checklist

1. **Extraction refactor** (§6, ~1 h): move the two main.c blocks into
   `iterate_esp_idf`, re-link StackChan, existing host tests + StackChan
   build green. Gate: zero behavior diff (same counters exported).
2. **Red tests 1–5 + `iterate_havpe_audio` skeleton to green** (~2-3 h,
   host only). Gate: full host suite green.
3. **`devices/havpe` + `targets/havpe`** (~1 h): sdkconfig (octal PSRAM,
   WDT panic, TLS reserve), partitions, build + ELF/link OK; record
   binary size against StackChan's 1,148,256 B baseline (landing doc
   `:97-99`).
4. **Stage A tone on hardware** (~1-2 h incl. one flash cycle; keep the
   stock-restore image on disk first). Gates in §7. Hard stop rule: if
   silence persists past the codec/amp/XMOS counters all-green, switch to
   the TDM `bclk_div` fallback before any other theory.
5. **Stage B mic + channel proof** (~1 h): decides ch1 policy (NONE vs
   NS) and locks the HAVPE suppression gate definition.
6. **Stage C tone-mode network proof** (~1 h): provision partition,
   install userspace, KV `tone`, transport + network-validity gates green.
7. **Stage D production Grok manifest** (1-2 runs): silent start → spoken
   turn → interruption → memory/CPU → network `valid`; retain manifest +
   provider-events + acoustic artifacts, StackChan-style.
8. **Only then**: endurance ladder, LED ring, dial, and any DSP tuning —
   outside this slice by definition.

Total: a focused day of implementation plus a hardware session — bounded
because every unknown (slave-TX lag, `NONE` semantics, XMOS factory
version) has a measured decision point and a pre-named fallback instead of
an open research branch.
