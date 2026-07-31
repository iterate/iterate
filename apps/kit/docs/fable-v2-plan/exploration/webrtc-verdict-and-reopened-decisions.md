# WebRTC verdict and reopened decisions — synthesis (2026-07-31)

Synthesizes the five trawl reports produced against Jonas's unverified
prior-art report (`inputs/jonas-prior-art-report-2026-07-31.md`) and his two
asks: (1) trawl every item against PLAN.md and potentially reopen decisions;
(2) answer whether WebRTC — "as I understand it, UDP on Cloudflare Worker",
possibly using the ESP WebRTC example — is viable and cleaner.

Inputs (all live-verified 2026-07-31, unlike the report under examination):
`exploration/webrtc-esp-side.md` (device half), `webrtc-cloudflare-side.md`
(server half), `report-reconciliation.md` (item-by-item disposition),
`afe-profile-decision.md` (VC-vs-FD), `contention-knobs.md` (Kconfig ground
truth vs v1's actual sdkconfig + linker map).

---

## 1. THE WEBRTC VERDICT (Jonas's question 2)

### 1.1 The direct answer

**"Can a Cloudflare Worker do WebRTC?" — No. Your one-liner is exactly
right, and it was verified live, not assumed.** Workers and Durable Objects
have **no UDP in either direction**; `connect()` is outbound-TCP-only, and
even _inbound_ raw TCP is still "coming soon" (promised 2021, doc last
updated 2026-06-19 —
<https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/>,
<https://developers.cloudflare.com/workers/reference/protocols/>).
Cloudflare Containers can't take non-HTTP TCP/UDP either
(<https://developers.cloudflare.com/containers/platform-details/architecture/>).
So **no Cloudflare compute can be a WebRTC peer** — a DataChannel-only
session (SCTP-over-DTLS-over-UDP) is equally impossible. WebRTC termination
on our worker is dead, permanently, absent a platform change Cloudflare has
not shipped in five years of promising.

**But the landscape moved, and the practical answer is better than "no":**

1. **Cloudflare Realtime (né Calls) now terminates WebRTC _for_ you and
   hands your worker the audio over a plain WebSocket.** The Realtime SFU's
   **WebSocket adapter** (beta; launched 2025-08-29, auto-reconnect added
   2026-05-29) decodes a device's WebRTC/Opus track and **dials out to any
   `wss://` URL we name** — i.e. our existing `/pcm` DO — pushing 48 kHz
   s16le PCM in protobuf frames; ingest mode is the reverse
   (<https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/>,
   <https://blog.cloudflare.com/cloudflare-realtime-voice-ai/>). WebRTC on
   Cloudflare therefore reduces to _"the SFU becomes one more WebSocket
   client of the `/pcm` DO"_ — D8, requirements 8, 9, and 11 all survive
   unchanged. Cost ≈ $0.035/h/direction post-free-tier (free during beta).

2. **The ESP WebRTC example is real, current, and NOT recommended for v2.**
   `espressif/esp-webrtc-solution` is actively maintained (HEAD merge commit
   2026-07-31, esp_peer v1.5.3) with full ICE/TURN/TURNS-over-TLS,
   DTLS-SRTP, NACK/jitter, SCTP. But: its entire transport engine — ICE
   agent, STUN, RTP/RTCP, jitter buffer, SDP, SCTP — ships as a **closed
   per-chip binary blob** (`libpeer_default.a`, ~50 KB .text on S3,
   Espressif-products-only license); it is **device-only testable** (no
   linux port anywhere; the repo's own rig is pytest-embedded on physical
   DUTs), which would move everything our virtual-clock fault-harness suite
   covers into an unobservable binary — a direct regression against
   requirement 2; its OpenAI demo's AEC hangs off ES7210 TDM hardware
   reference + closed esp-sr AFE (maps to StackChan, never the PDM-mic
   M5StickS3) and assumes octal PSRAM + ~155 KB of task stacks vs our 3×8 KB
   (`webrtc-esp-side.md` §2, §6). Its peer-death detection defaults to ~30 s
   (6 s STUN keepalive × 5) vs our 200 ms pong deadline, and RTP's
   retransmit-stale-audio policy is the opposite of our
   freshness-over-throughput design.

3. **The direct-to-provider variant doesn't exist for Grok.** xAI's realtime
   API is **WebSocket-only** (`wss://api.x.ai/v1/realtime`, PCM 8–48 kHz,
   ephemeral client tokens — a flow our code already implements at
   `providers.ts:118`); its "WebRTC Agent" demo is a self-hosted Node/werift
   relay, not an xAI endpoint (<https://docs.x.ai/developers/model-capabilities/audio/voice-agent>).
   **REFUTED** that Grok can be reached like OpenAI Realtime. Every WebRTC
   design still needs a terminator we rent (CF SFU) or run (Fly/LiveKit).

### 1.2 Combined options matrix

(✓✓ strong / ✓ adequate / ~ partial / ✗ fails; full scoring in
`webrtc-cloudflare-side.md`.)

|                                              | **A. device→worker WS (today/plan)**                       | **B. device WebRTC→CF SFU→WS adapter→our DO**                                        | **C. device→xAI direct WS (ephemeral token)** | **D. non-CF gateway (LiveKit/Fly)**              |
| -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------ |
| Works today                                  | ✓✓ deployed, physically proven                             | ✓ SFU live; adapter **beta**; device needs full WebRTC stack (the hard half)         | ✓✓ token flow already written                 | ✓ proven tech, new infra                         |
| Air-link resilience                          | ✓ TCP; stall-then-burst under Wi-Fi loss (observed ≥4.2 s) | ✓✓ UDP loss-tolerance + Opus PLC on the air link                                     | ✓ same TCP as A                               | ✓ good                                           |
| Req 8 (cross-post events)                    | ✓✓                                                         | ✓✓ unchanged — media still transits our DO                                           | ✗ no server media path                        | ~ rebuild everything                             |
| Req 9 / D7 (server AEC, timestamp echo)      | ✓ per plan                                                 | ✓ same, plus 48 kHz PCM both directions at the DO                                    | ✗ dead                                        | ~ possible                                       |
| Req 11 / D8 (idle hangup; PCM keeps flowing) | ✓✓ as designed                                             | ✓✓ unchanged                                                                         | ✗ enforcement moves to firmware + token TTL   | ✓ gateway owns dialing                           |
| Host-testability (req 2)                     | ✓✓ white-box, virtual-clock suite                          | ✗ device half = closed blob, DUT-only                                                | ✓                                             | ✗                                                |
| Complexity                                   | ✓✓ ~10 k lines ours, proven                                | server small; device large (~26 k vendor lines + blob + ICE/DTLS-SRTP/Opus on an S3) | server smaller; fleet policy larger           | ✗✗ new ops domain                                |
| Platform fit                                 | ✓✓                                                         | ✓ all-Cloudflare, beta dependency                                                    | ✓ bypasses session control                    | ✗✗ fights Workers+Doppler doctrine, D8 economics |

### 1.3 Recommendation

**Keep A (device→worker WebSocket) for v2.0. Name B as the zero-regret
future WebRTC lane.** Not a compromise — the scoring is lopsided:

- Nothing WebRTC fixes is a server-side problem; the one genuine benefit
  (loss-tolerant UDP + Opus PLC) lives on the device↔edge air link only.
- B's server half degenerates into "one more WebSocket client of `/pcm`"
  (resampler + protobuf codec + adapter lifecycle calls), so **deferring B
  forecloses nothing** — no v2.0 decision is wasted if we adopt it later.
  The expensive half of B is firmware (ICE/DTLS-SRTP/Opus via a closed blob
  on a DIRAM-constrained S3), and stage 2's reconnect fixes + D7's
  timestamp echo are the cheaper first rungs of the same resilience ladder.
- C destroys requirements 8, 9, and 11's server half to save one anycast
  hop; D buys an always-on second media plane to solve a problem the CF SFU
  already solves in-platform.

**Strongest counterargument (stated honestly):** our own receive-stall
research found a ≥4.2 s Wi-Fi link outage that TCP silently converted into
stall-then-burst — precisely the failure mode RTP/UDP + Opus PLC degrades
through gracefully. Espressif now ships a supported device stack and
Cloudflare now runs the terminator with a PCM tap we can consume natively.
**Promotion trigger:** if rig/field telemetry (stage 2's network-churn
scenarios + nightly endurance) shows multi-second TCP stalls are common in
real deployments, B moves from watchlist to roadmap — and reuses `/pcm`
wholesale when it does.

**Steal now regardless** (no adoption required): the ephemeral-token
signaling pattern (already ours), the ES7210 `channel_mask = 1|2` TDM
reference wiring (`media_sys.c:47-57` — the concrete reference for
StackChan's D3/G13 AEC bring-up), Opus stack-size ground truth (40 KB
enc/dec stacks if Opus ever lands on-device), and the
`esp_peer_default_cfg_t` runtime tuning-config surface as prior art for the
stage-3 per-board profile struct.

---

## 2. REOPENED DECISIONS

### 2.1 Transport: D7 (PCM v2 header) + D8 (session split) vs WebRTC — **KEEP, with one AMEND**

- **Standing decision:** dual WebSockets, raw PCM v1 + optional 16-byte v2
  header (D7); worker keeps the device connection forever, provider dialed
  on demand (D8).
- **Challenge:** the report's Key Finding 1 ("esp-webrtc-solution is the
  modern way to do bidirectional real-time media") plus Jonas's "might be
  cleaner" hunch.
- **Evidence:** §1 above. WebRTC gives us D7's seq+timestamps for free but
  takes away three load-bearing policies: the peer-delivery guard's 40 ms
  barrier / 200 ms replace (RTCP is seconds-scale and blob-internal),
  freshness-over-throughput (jitter buffer + resend = retransmitting stale
  voice), and epoch purge/generation fencing into physical DMA
  (`webrtc-esp-side.md` §6e). Meanwhile B (the only viable WebRTC shape)
  keeps D8 wholly intact.
- **Recommendation: KEEP both.** AMEND D8 with one line: _the
  provider-session half must stay transport-agnostic on its device side —
  "device connection" may someday be a CF-SFU WebSocket-adapter connection._
  Add two watchlist rows to §8 (adapter beta→GA; xAI WebRTC endpoint —
  none today).

**G16 (for Jonas):** Is graceful survival of multi-second Wi-Fi outages
mid-conversation a v2 product requirement, or is office-grade Wi-Fi the
bar? Watchlist-only (recommended, $0 now) vs funding the option-B firmware
spike (device WebRTC stack, closed blob, DUT-only testing) is decided by
that single product question — the server half is ~free either way.

### 2.2 D3 / stage 5: AFE profile (report says VC) — **KEEP; report REFUTED**

- **Standing decision:** standalone `afe_aec` **FD_LOW_COST** + standalone
  WebRTC VAD; ES7210 TDM slot-1 hardware reference; server VAD does
  turn-taking.
- **Challenge:** report §3: "Use the VC (voice communication) AFE profile
  for full-duplex calling."
- **Evidence:** the report predates `AFE_TYPE_FD` (added esp-sr 2.4.3,
  registry-verified 2026-04-28) and thinks only SR and VC exist; the live
  enum has four types (`esp_afe_config.h:34-39`). Espressif's own doc
  recommends `AEC_MODE_FD_LOW_COST` for full-duplex; FD_LOW_COST is the
  only option inside our budgets (19.6 % CPU / 30.9 KB internal vs
  VOIP 27–32 % and VC HIGH_PERF 91.1 KB); the sole tunable
  echo-vs-near-end lever (`aec_nlp_level`) is **documented inert outside FD
  modes** — and the goal doc's <3 dB near-end-damage barge-in gate needs
  that lever. Shipping evidence: esphome-intercom's full-duplex configs use
  FD in both processor shapes; Espressif's own OpenAI demo uses SR (not
  VC); xiaozhi ran FD for 3 months and switched to VC on 2026-07-19 in an
  unexplained bundled commit whose README still says FD_LOW_COST; and
  iterate/stackchan's experiment already passed ERLE ≥12 dB gates with
  standalone FD modes **on the exact CoreS3 + ES7210 hardware**
  (`afe-profile-decision.md` §2, §3).
- **Recommendation: KEEP D3/stage-5 verbatim.** Minor amendments ride
  along: the optional clarifying parenthesis on the 512-sample re-framing
  ("the seam's frame-size report, not this number, is normative"), the
  16-byte output-alignment implementation note, surfacing `aec_nlp_level`
  as a stage-3 per-board profile knob, and adopting the 7-rung fallback
  ladder with measured triggers (`afe-profile-decision.md` §4) as the
  stage-5 bring-up script. No new Jonas question — the evidence is
  one-sided.

### 2.3 D6: "zero net IRAM growth (there is ONE byte free)" — **AMEND; premise REFUTED**

- **Standing decision:** D6 standing rule: zero net IRAM growth; stage 1
  chore "reclaim IRAM headroom (one byte free today)".
- **Challenge:** none from the report (it just says "IRAM is finite") — the
  trawl's own verification overturned our premise.
- **Evidence:** the linker map shows 96,000 B of IRAM code filling the
  16 KB SRAM0 instruction-only block and legally spilling 79,616 B into
  shared D/IRAM (`.dram0.dummy` fill 0x13700). **New `IRAM_ATTR` code links
  fine at 1:1 DIRAM cost.** The real budget is DIRAM: 142,465 B static
  free, ~77.8 KiB runtime heap, against AEC's 31–60 KB internal need
  (`contention-knobs.md` §1.2). The architecture review's "any new
  IRAM_ATTR will not link" is refuted.
- **Recommendation: AMEND** D6's rule to _"every IRAM byte is a DIRAM byte —
  account it in the DIRAM ledger next to the 31–60 KB AEC reservation"_,
  and reframe the stage-1 chore from firefight to ledger. This also
  **unblocks** adopt items that looked IRAM-blocked (§3).

### 2.4 Stage 1 resource chores: CPU and PSRAM clocks — **AMEND (+G17)**

- **Standing decision:** stage 1 = "enable + smoke-test PSRAM", IRAM
  headroom, buffer-placement logging.
- **Challenge:** the report never mentions it, but verification found v1
  runs **CPU at 160 MHz and octal PSRAM at 40 MHz** — both bare IDF
  defaults — while every shipping S3 voice stack (xiaozhi, HA Voice PE,
  8–15 esp-skainet examples) ships 240 MHz + 80 MHz + enlarged caches. The
  esp-sr budgets the plan quotes (~20 % of a core) are measured at 240 MHz;
  at 160 MHz they are ~1.5×.
- **Recommendation: AMEND stage 1** to include `SPIRAM_SPEED_80M` (with the
  already-scheduled PSRAM smoke) and the 240 MHz flip gated on a
  before/after rig pass (tone proof + endurance rung at 240).

**G17 (for Jonas):** the Stick has a brownout history under audio load
(rail-sag hypothesis; the −18 dB mixer fix). 240 MHz raises draw. OK to
flip it in stage 1 behind the rig gate (tone + endurance + brownout-history
check green before it sticks), reverting is one line — or hold at 160 MHz
until the brownout fix is committed and re-proven?

### 2.5 esp-gmf / esp-adf framework stance — **KEEP**

- **Standing:** refuse the element/pipeline framework class (fused
  callbacks, one task per clock domain).
- **Challenge:** report D§1-T3b "prefer GMF for new work"; GMF hit **v1.0
  in July 2026** (live-verified).
- **Recommendation: KEEP** the refusal; the reasoning (fixed pipeline,
  host-testable, Espressif's own latency-critical examples bypass their
  framework) is unchanged by the release. Named re-evaluation trigger
  stands: runtime-recombinable media graphs or `esp_audio_codec`'s codec
  matrix ever needed → re-evaluate GMF v1.x before hand-rolling.

### 2.6 Opus on device — **KEEP (rides with 2.1)**

"Not now" stands: raw PCM is within Wi-Fi budget, physically proven, keeps
evidence simple. If option B is ever promoted, Opus arrives with it
(the SFU speaks Opus on the WebRTC leg) and this note closes. Their
measured stack costs (40 KB enc/dec) are recorded as budget inputs.

### 2.7 P4+C6 board class — **KEEP (no preclusion, no v2 action)**

Checked: nothing in the hardware-plugability design blocks a future P4+C6
board (zero platform includes in portable components; ESP-Hosted presents
the standard `esp_wifi` API via `esp_wifi_remote`). Escalation triggers
recorded (sustained AFE+encode >60–70 % of a core, or dropouts surviving
the §3 fixes) — both far from our measured ~22 % full-AFE / 19.6 %
standalone budget.

---

## 3. ADOPT LIST (verified NEW-ADOPT items)

All symbols verified against esp-idf **v5.5.3** clone; "v1 today" read from
the resolved `targets/m5sticks3/sdkconfig` (read-only — these are v2 plan
items, not edits; codex owns the file). The report's `CONFIG_ESP32_WIFI_*`
spellings are v4-era; v5.x names below are the real ones
(`esp_wifi/sdkconfig.rename`).

| #   | Item                                                                                                                                                                                                                                                                                                                              | Exact verified symbols / API                                                                                                                                                                                   | v1 today                         | Lands in                                                                                                                                | Blocked?                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Pin lwIP tcpip task to core 0 (the ONE genuinely missing piece of the report's load-isolation bundle)                                                                                                                                                                                                                             | `CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y` (`lwip/Kconfig:893`)                                                                                                                                                  | NO_AFFINITY — floats onto core 1 | **Stage 2** (verify with capture-starvation rig scenario)                                                                               | no                                                      |
| 2   | Wi-Fi jitter A/B experiments — static RX count, AMPDU on/off, BA window (adopt only what jitter data justifies)                                                                                                                                                                                                                   | `CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM` (10), `CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM` (32), `CONFIG_ESP_WIFI_AMPDU_TX_ENABLED`/`_RX_ENABLED`, `CONFIG_ESP_WIFI_RX_BA_WIN` (6→3 is the xiaozhi-proven half-step) | IDF defaults                     | **Stage 2** rig / nightly endurance                                                                                                     | no                                                      |
| 2b  | Surgical AMPDU alternative first: tag `/pcm` socket `IP_TOS` precedence 6 → **AC_VO never aggregates** (official QoS table, `wifi.rst:2887-2907`)                                                                                                                                                                                 | `setsockopt(IP_TOS)` — runtime, no Kconfig                                                                                                                                                                     | untagged                         | **Stage 4** (with PCM v2 work)                                                                                                          | no                                                      |
| 3   | PSRAM clock 40→80 MHz (v1 runs octal PSRAM at half every vendor audio config's speed; never 120 M)                                                                                                                                                                                                                                | `CONFIG_SPIRAM_SPEED_80M=y` (`Kconfig.spiram:105`)                                                                                                                                                             | `SPIRAM_SPEED_40M`               | **Stage 1** PSRAM chore                                                                                                                 | no                                                      |
| 3b  | CPU 160→240 MHz (all reference stacks; esp-sr budgets assume it)                                                                                                                                                                                                                                                                  | `CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240`                                                                                                                                                                          | 160 MHz                          | **Stage 1**, rig-gated                                                                                                                  | **G17** — brownout-history gate                         |
| 4   | Flash-write discipline: **no NVS/OTA/flash-FS writes during audio sessions.** Verified STRONGER than the report: any SPI1 flash op suspends ALL other tasks, busy-parks the other core, disables non-IRAM ISRs (`spi_flash_concurrency.rst:28-52`). SD-over-SDMMC exempt by bus — SD logging during calls is safe by construction | rule (no symbol); v1 already conforms (`WIFI_STORAGE_RAM`, `itx_transport.c:1113`)                                                                                                                             | implicit only                    | **D-level invariant + Stage 4** (rig asserts no flash-write events inside capture sessions; future OTA schedules into D8's idle window) | no                                                      |
| 4b  | XIP-from-PSRAM as one bounded experiment (reconciles the report's "avoid" with HA Voice PE shipping both on): measure IRAM freed vs tone/PRBS regression; default stays OFF at every stage                                                                                                                                        | `CONFIG_SPIRAM_XIP_FROM_PSRAM` (selects `SPIRAM_FETCH_INSTRUCTIONS`+`SPIRAM_RODATA`); fallback noted: `CONFIG_SPI_FLASH_AUTO_SUSPEND` (flash-chip-specific, leave off)                                         | off                              | **Stage 1** experiment; recorded stage-5 escape valve if the DIRAM ledger can't close                                                   | dep: item 3 first (80 MHz)                              |
| 5   | Per-task CPU% + per-stage cycle counts through the metrics schema (counters already compiled in; the instrument that later decides go-P4 with data)                                                                                                                                                                               | `uxTaskGetSystemState` (`FREERTOS_GENERATE_RUN_TIME_STATS=y` already on), `esp_cpu_get_cycle_count()` (`esp_cpu.h:181`) around `process()`                                                                     | counters on, unexported          | **Stage 3** metric fields; cycle counts → **Stage 5** AEC acceptance                                                                    | no                                                      |
| 6   | Task-WDT rule: no busy-waits on the audio task; WDT trip becomes an event record type. Keep 5 s + both idle-task watches — the core-1 idle watch is the built-in capture-starvation canary (report's WDT concern OVERSTATED: 10–32 ms frames vs 5 s)                                                                              | `CONFIG_ESP_TASK_WDT_EN` (already y, 5 s, both cores)                                                                                                                                                          | enabled                          | **Stage 2** rule + **Stage 4** event type                                                                                               | no                                                      |
| 7   | PM-lock tripwire: PM is OFF (DFS impossible; `esp_pm_lock_create` returns `ESP_ERR_NOT_SUPPORTED`, `pm_locks.c:52`) — record the invariant that any future `CONFIG_PM_ENABLE` commit must add call-scoped locks in the same commit                                                                                                | `ESP_PM_APB_FREQ_MAX`, `ESP_PM_NO_LIGHT_SLEEP` (`esp_pm.h:47-57`)                                                                                                                                              | PM off                           | **Stage 3** device profile (`requires_pm_locks` + architecture test: PM off OR locks held)                                              | no                                                      |
| 8   | Wi-Fi IRAM opts as **reclaim lever, not enable target** (report's advice inverted: both already default-on; disabling frees ~27 KB DIRAM — xiaozhi ships both =n to fund audio)                                                                                                                                                   | `CONFIG_ESP_WIFI_IRAM_OPT` / `CONFIG_ESP_WIFI_RX_IRAM_OPT` (`esp_wifi/Kconfig:274,292`)                                                                                                                        | both **y**                       | **Stage 1** audit note; re-decide at **Stage 5** DIRAM ledger                                                                           | deferred by design — only if AEC's 31–60 KB can't close |
| 9   | Cache geometry benchmark (all three reference stacks run icache 32 KB): icache 32 KB costs the 16 KB pure-IRAM block → +16 KB effective DIRAM; dcache 64 KB probably unaffordable                                                                                                                                                 | `CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB`, `CONFIG_ESP32S3_DATA_CACHE_LINE_64B`                                                                                                                                  | 16 KB / 32 KB / 32-B lines       | **Stage 2** benchmark; **Stage 5** decision                                                                                             | dep: DIRAM ledger after AEC reservation                 |
| 10  | Rig-only tools: `perfmon` (Xtensa cache/stall counters — proves/disproves AMPDU-vs-cache hypotheses) + SystemView (transport needs checking — Stick console occupies USB-Serial-JTAG)                                                                                                                                             | `CONFIG_APPTRACE_SV_ENABLE`                                                                                                                                                                                    | off                              | rig build flavors, never shipped                                                                                                        | no                                                      |

Note on "BLOCKED by the IRAM crisis": **the crisis premise itself was
refuted** (§2.3) — nothing on this list is link-blocked. The real gating
resource is the DIRAM ledger, and items 8/9 are deliberately sequenced
behind it.

---

## 4. REPORT SCORECARD

Of the report's ~40 distinct claims/recommendations
(`report-reconciliation.md` §5):

| Bucket                                 | Count | Representative items                                                                                                                                                                                             |
| -------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALREADY** (independently in plan/v1) | 17    | hardware TDM reference; core split; ISR-notify handoff (`m5sticks3_direct_audio.cpp:304`); `esp_driver_i2s`; internal-SRAM buffers; alignment-first AEC debugging; bounded inter-stage buffering (ours stricter) |
| **SUPERSEDED** by our live evidence    | 7     | Voice PE AEC "contested" → verified post-XMOS; AFE chunk sizes; CPU/RAM tables; 0–10 ms alignment contract; "verify AEC CPU%" → we hold v2.4.6 tables                                                            |
| **NEW-ADOPT** (verified, §3)           | 7     | lwIP affinity; flash-stall rule (stronger than stated); PSRAM clock; Wi-Fi jitter experiments; WDT/PM/measurement plumbing                                                                                       |
| **REOPEN** (all resolved this pass)    | 5     | WebRTC (→ §1: keep PCM); VC-vs-FD (→ §2.2: report refuted); P4+C6 / gmf / Opus (→ keep, triggers recorded)                                                                                                       |
| **IGNORE**                             | 5     | Willow, SIP tier, DevCon/blog pointers, forum-issue pointers, Korvo prototyping                                                                                                                                  |

Notable per-claim verdicts:

| Claim                                                | Verdict                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| "Use the VC profile for full-duplex"                 | **REFUTED/OUTDATED** — predates AFE_TYPE_FD (2.4.3, 2026-04-28)                                      |
| All `CONFIG_ESP32_WIFI_*` symbol names               | **STALE** (v4-era) — exactly as its own caveat warned                                                |
| "Enable Wi-Fi IRAM opts"                             | **VACUOUS** — already default-on; live question is whether to _disable_                              |
| "Prefer static Wi-Fi RX buffers over dynamic"        | **MISREAD** — no such RX choice exists; both layers always coexist                                   |
| "esp_pm_lock during calls"                           | **MOOT** — PM off; the call would error                                                              |
| Flash-stall warning                                  | **CONFIRMED, STRONGER** — suspends all tasks + busy-parks the other core                             |
| esp-webrtc-solution as modern stack                  | **CONFIRMED** existence/activity; **missed** that the core is a closed blob and device-only-testable |
| Hardware-reference-is-make-or-break; ES7210 topology | **CONFIRMED** — and already ours                                                                     |
| Task-WDT risk from AFE frames                        | **OVERSTATED** (10–32 ms vs 5 s)                                                                     |

**Weight verdict for Jonas:** the report is a competent directional survey
that changed **zero decisions at the architecture level** — every headline
recommendation was either already in the plan (17), superseded by our
live data (7), or refuted (VC profile, static-RX, pm_lock, IRAM enable).
Its genuine contribution is 7 config-level items totaling tens of lines,
of which the flash-stall rule and lwIP affinity are the two that matter.
Its self-declared "verify before committing" caveat was accurate in both
directions: the repo paths and mechanisms were right, and the version-
sensitive specifics (Kconfig names, profile lists) were stale exactly where
it warned they might be. Trust it as a checklist generator, not as a
decision source.

---

## 5. PLAN EDIT LIST (for the main agent to apply to PLAN.md)

| #   | Section                   | Old stance                                                                                                                                  | New stance                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | D6 (standing rules)       | "zero net IRAM growth (there is ONE byte free); every addition writes down its internal-RAM cost next to the 31–60 KB the AEC future needs" | "every IRAM byte is a DIRAM byte — every addition is a **DIRAM-ledger** entry next to the 31–60 KB AEC reservation (real budget: 142,465 B static free / ~77.8 KiB runtime heap; the '1 byte IRAM free' figure is the always-full pure block, not a link ceiling)"                                                                                                                                                                                            |
| E2  | Stage 1 (resource chores) | "reclaim IRAM headroom (one byte free today), enable + smoke-test PSRAM, add boot-time logging…"                                            | "open the DIRAM ledger (see E1); enable + smoke-test PSRAM **at `SPIRAM_SPEED_80M`**; flip CPU to 240 MHz gated on tone+endurance+brownout rig pass (G17); one bounded `SPIRAM_XIP_FROM_PSRAM` experiment (measure IRAM freed vs tone/PRBS regression; default stays off); record Wi-Fi IRAM opts (`ESP_WIFI_IRAM_OPT`/`_RX_IRAM_OPT`, both on today) as the ~27 KB emergency DIRAM-reclaim lever for stage 5; boot-time buffer-placement logging as written" |
| E3  | D8                        | (no transport note)                                                                                                                         | append: "The provider-session half stays transport-agnostic on its device side — 'device connection' may someday be a Cloudflare Realtime SFU WebSocket-adapter connection (see webrtc-verdict §1); nothing else in D8 changes."                                                                                                                                                                                                                              |
| E4  | Stage 2                   | reconnect fixes, capture move, tick-poll removal                                                                                            | add: "`CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y` (today the tcpip task floats onto core 1); Wi-Fi jitter A/B experiments on the rig (static RX count, AMPDU on/off, `RX_BA_WIN` 6→3) — adopt only what jitter data justifies; task-WDT rule: no busy-waits on the audio task (the core-1 idle watch is the capture-starvation canary); cache-geometry benchmark (icache 32 KB) for the stage-5 decision"                                                        |
| E5  | Stage 3 (profiles)        | profile struct as listed                                                                                                                    | add fields/notes: "`aec_nlp_level` as a per-board tuning knob (the FD-only bring-up lever); `requires_pm_locks` tripwire + architecture test (PM off OR call-scoped `ESP_PM_APB_FREQ_MAX`+`ESP_PM_NO_LIGHT_SLEEP` locks held); per-task CPU% via `uxTaskGetSystemState` as generated metric fields"                                                                                                                                                           |
| E6  | Stage 4                   | worker + events + SD as written                                                                                                             | add: "call-time invariant (D-level): **no NVS/OTA/flash-FS writes during audio sessions** (SPI1 flash ops suspend all tasks and busy-park the other core; SD-over-SDMMC exempt by bus — SD logging during calls is safe by construction); rig asserts no flash-write events inside capture sessions; `/pcm` socket tagged `IP_TOS` precedence 6 → AC_VO (never aggregates); WDT-trip event type"                                                              |
| E7  | Stage 5 (StackChan AEC)   | "standalone FD_LOW_COST AEC + WebRTC VAD (not the full AFE)"                                                                                | keep; append: "512-sample re-framing note: the seam's frame-size self-report is normative, not the number (VOIP modes would say 256); `afe_aec_process` output buffers 16-byte aligned; bring-up follows the 7-rung fallback ladder with measured triggers (`exploration/afe-profile-decision.md` §4); per-stage cycle counts feed the AEC acceptance numbers; re-decide Wi-Fi IRAM opts + cache geometry against the DIRAM ledger here"                      |
| E8  | §8 watchlist              | rows 1–13 as written                                                                                                                        | add rows: "Cloudflare Realtime WebSocket adapter beta → GA (pricing + API stability) — the future WebRTC lane's server half"; "xAI WebRTC endpoint (none today; WebSocket-only, verified 2026-07-31)"; "TCP stall telemetry from stage-2 network-churn scenarios + nightly rig — the promotion trigger for option B (webrtc-verdict §1.3)"                                                                                                                    |
| E9  | §7 decision register      | G1–G15                                                                                                                                      | add: "**G16** WebRTC posture — watchlist-only (assumed) vs funded option-B spike; decided by: is graceful survival of multi-second Wi-Fi outages mid-conversation a v2 product requirement? · **G17** 240 MHz CPU flip in stage 1 behind the brownout rig gate (assumed yes) vs hold at 160 MHz until the rail-sag fix is committed and re-proven"                                                                                                            |
| E10 | Status header             | "provisional v0.2 … 15 open questions (G1–G15)"                                                                                             | bump to v0.3; register now G1–G17; note the prior-art report trawl is complete (this doc + the four trawl reports), report scorecard in `exploration/webrtc-verdict-and-reopened-decisions.md` §4                                                                                                                                                                                                                                                             |
