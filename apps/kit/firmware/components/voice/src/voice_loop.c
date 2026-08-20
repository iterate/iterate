/*
 * The Iterate voice device, once, for every board that is one.
 *
 * The whole product is here: a UI (start call / hang up), a live capability at
 * kit.<board> so an agent can drive the screen and the call, and the voice pipe
 * itself. What a board physically IS arrives through
 * `struct iterate_kit_board_ops`; voice/loop.h says why that surface is the
 * size it is, and what four copies of this file cost before it existed.
 *
 * ONE Cap'n Web WebSocket to /api carries everything, exactly like the
 * TypeScript voicelab client: authenticate -> projects.get -> streams.get,
 * then 50 Hz one-way appends of ephemeral events.iterate.com/voice-agent/mic-frame events (real
 * microphone), and a live openConnection callback delivering
 * events.iterate.com/voice-agent/spk-frame events (decoded to the speaker) plus grok-events
 * (speech_started = barge-in flush, response.done = end of answer).
 *
 * Nothing runs off-device: pressing "start call" calls the project's OWN
 * userspace worker (itx.worker.startCall) over that same socket, and the
 * worker holds the Grok session detached. No laptop bridge, no second
 * connection.
 *
 * Turn taking is a per-board FACT, not a per-board program. A board with no
 * echo cancellation holds a control while speaking and sends nothing from the
 * microphone unless it is down — the whole echo story there, since the speaker
 * is never live into an open microphone and pressing to talk cancels an answer
 * in flight instead of talking over it. A board that cancels its own speaker
 * leaves the microphone open and lets the far end segment turns. Both are
 * below, chosen by `facts->turns`.
 *
 * Observability is the `health()` capability, PULLED — opening the USB
 * console resets some of these boards, so it is the instrument of record.
 * Nothing is pushed on a timer; see the note where append_stats used to be.
 *
 * DELIBERATE DEPARTURE from the dual-WebSocket decision in
 * docs/fable-v2-plan/DECISIONS.md — this is the single-socket measurement that
 * decision asked for.
 */
#include <inttypes.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "capnweb/capnweb.h"
#include "iterate/kit/audio_codec.h"
#include "iterate/kit/conversation_launch.h"
#include "iterate/kit/retry_gate.h"
#include "iterate/kit/platforms/esp_idf_reset_reason.h"
#include "iterate/kit/capabilities/system_update.h"
#include "iterate/kit/platforms/esp_idf_restart_note.h"
#include "iterate/kit/platforms/esp_idf_system_update.h"
#include "iterate/kit/capabilities/conversation.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/capabilities/push_to_talk.h"
#include "iterate/kit/capabilities/speaker.h"
#include "iterate/kit/aec_capture_bridge.h"
#include "iterate/kit/audio_processor.h"

/*
 * UTC as YYYY-MM-DD-HHMMSS, or false when the clock has not arrived.
 *
 * Declared up here because two very distant places need the same string: the
 * name of a new conversation, and `health()`. One function so that what the
 * metrics report is literally what a new path would be called, rather than two
 * formats that agree until one of them is edited.
 */
static bool clock_slug(char *out, size_t capacity);

/*
 * Throw away whatever speaker audio is queued, in the one safe order. Declared
 * here because the abandon sites are spread across the receive path and the app
 * loop; defined once, beside the runtime it acts on.
 */
static uint32_t abandon_speaker_audio(void);
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voicelab_stream.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_playback_clock.h"

static const char tag[] = "iterate-voicelab";

enum {
  /*
   * Occupancy is inbound-call-rate x round-trip: every delivery batch is a
   * push holding a slot until the server's release arrives. At ~12 batches/s
   * and 160 ms RTT that is already 2, and a concurrent recording pull adds
   * one per chunk. Exhausting this aborts the SESSION, so it is sized for
   * the burst, not the average.
   */
  PENDING_CALL_CAPACITY = ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY,
  EXPORT_CAPACITY = ITERATE_KIT_VOICE_EXPORT_CAPACITY,
  IMPORT_CAPACITY = ITERATE_KIT_VOICE_IMPORT_CAPACITY,
  /*
   * Replies to pulled calls and inbound delivery batches both parse inside
   * this budget, one token per JSON key, value, object and array —
   * exhaustion ABORTS THE SESSION. A capped batch of 4 speaker frames is
   * ~72, but a single Grok response.done carries a nested event object that
   * alone runs to several hundred. 256 was sized for a 2-event batch and was
   * never re-checked when the cap doubled; 1024 costs 12 KiB of otherwise
   * idle PSRAM-eligible RAM and takes this off the table.
   */
  TOKEN_CAPACITY = ITERATE_KIT_VOICE_TOKEN_CAPACITY,
  OUTPUT_CAPACITY = ITERATE_KIT_VOICE_OUTPUT_CAPACITY,
  /*
   * An inbox slot takes one whole delivery batch, so this is the ceiling on
   * how much audio one batch may carry — and batch SIZE is what decides
   * whether the speaker keeps up.
   *
   * Delivery is one batch at a time: the platform hands over a batch and the
   * next one waits on this device's reply. Measured at 5.7 batches a second
   * (~175 ms a round trip), so a 4-event cap was 80 ms of audio per 175 ms —
   * 0.46x realtime. The device played 94 of the 200 frames in one answer and
   * concealed 122. That is the choppiness, and no amount of buffering fixes
   * a lane that delivers at half speed.
   *
   * 16 KiB holds a 12-event batch (240 ms of audio) with room for the
   * envelope, which is 1.37x realtime at the same round trip.
   */
  CONTROL_INBOX_SLOT_CAPACITY =
      ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY,
  CONTROL_OUTBOX_SLOT_CAPACITY =
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY,
  /*
   * The inbox rides PSRAM (512 KiB), and overflowing it is SESSION-FATAL, so
   * it is sized for the worst legitimate burst rather than the average: a
   * paced answer clumps at TCP granularity, and pulling a recording off the
   * card adds a call per chunk on top. Measured high-water was 46 of 64
   * during ordinary use — close enough to the edge that the session died
   * under a recording pull concurrent with a call. 128 leaves real headroom.
   */
  CONTROL_INBOX_SLOTS = ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS,
  /*
   * The uplink sends 6 frames per 120 ms, which is exactly the capture rate —
   * so it has no margin, and any iteration blocked on outbox headroom puts
   * it permanently behind (measured: holds over 2 s ended with the queue
   * still full at the flush deadline). The outbox lives in PSRAM now, so
   * depth is cheap; 16 slots lets the sender catch up instead of losing the
   * tail of long utterances.
   */
  /*
   * 64, not 16. Pushing into a FULL outbox returns CAPNWEB_E_TRANSPORT, and
   * this peer terminalizes on that — the session ends, the turn is lost, and
   * the screen sits on "listening". Measured: every push-to-talk turn died
   * this way (appCapnweb=-4 at the moment the microphone opened).
   *
   * The microphone is bursty — three seconds of speech, then nothing — so the
   * fix is room to absorb a burst rather than a faster drain. 64 slots is
   * ~5 s of uplink at 8 KiB each, in PSRAM, which this board has to spare.
   */
  CONTROL_OUTBOX_SLOTS = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS,
  /*
   * How much of that the microphone may never touch. Replies to inbound
   * calls are NOT gated on headroom — the session generates them whenever the
   * platform delivers something — so the mic must leave them room or it
   * starves the very lane that keeps the session alive.
   */
  MIC_OUTBOX_RESERVE = ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE,
  FRAME_MS = ITERATE_KIT_VOICE_FRAME_MS,
  FRAME_SAMPLES = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  /*
   * `SPEAKER_FRAME_MS` and `DMA_RING_CREDIT_MS` were here, and on all four
   * boards, and read by nobody on any of them — 20 everywhere, and 40/60/90/120
   * respectively. A constant no code reads is a claim no measurement checks, so
   * they are deleted rather than promoted to per-board facts. The ring depth
   * that DOES matter survives as `facts->speaker_dry_wait_ms`, which is derived
   * from it and is read on every dry wait.
   */
  FRAME_BYTES = ITERATE_KIT_VOICE_FRAME_BYTES,
  MIC_QUEUE_DEPTH = ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH,
  MIC_FRAMES_PER_APPEND = ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND,
  /*
   * The speaker buffer holds JITTER, never an answer. A 1 MiB (32 s) buffer
   * was the single worst defect here: the bridge paced above realtime, so
   * every answer accumulated until the buffer filled, and then
   * xStreamBufferSend committed the HEAD of a frame and discarded the tail —
   * a click at an arbitrary waveform phase every 20 ms, heard as static that
   * got worse the longer the answer ran. 1 s is ample for network jitter now
   * that the bridge paces at ~1.05x, and whole frames are dropped rather
   * than split.
   */
  /*
   * 900ms, in INTERNAL RAM. Two constraints meet here: it must exceed the
   * bridge's 600ms opening burst plus jitter (at 750ms it did not, and 36
   * frames were dropped on arrival), and it must not rob the TLS handshake
   * (at 40000 the connection could not be established at all). 900ms clears
   * the burst with room and leaves the network stack its working set. (PSRAM is unreachable while the cache is off, and
   * a flash write would otherwise stall the audio ring as well as the tasks).
   * Deep buffers were the wrong lever: they cannot fix a recovery path that
   * under-fills the DMA, and they raise the ceiling that playout lag ratchets
   * toward. Concealment plus drop-debt bounds the lag instead.
   *
   * (Was four seconds, in PSRAM.) One second could not hold the bridge's 600ms
   * opening burst plus network jitter, so the buffer both OVERFLOWED (22
   * frames dropped) and later ran dry (minimum margin 0ms) in the same
   * answer — the classic too-small-for-the-burst signature.
   *
   * Unbounded growth is not a risk any more: the bridge paces at realtime
   * after its burst, so occupancy is bounded by burst + jitter rather than
   * by the length of the answer. (A 32s buffer WAS wrong, but only because
   * pacing was then 2x realtime and accumulated for the whole answer.)
   */
  /*
   * 1500 ms, not 900. The cushion a listener actually hears is the bridge's
   * opening lead PLUS this device's prefill, and they stack: 390 ms of
   * prefill against a 900 ms ring left only ~500 ms for the lead, so the
   * lead was cut to 250 ms to stop the ring overflowing — and then the ring
   * sat at a measured 384 ms maximum margin with MORE frames concealed than
   * played. Choppy in one direction was traded for choppy in the other.
   *
   * The ring is the cheap side of that trade: 19 KiB more internal RAM buys
   * a 600 ms lead with 500 ms of headroom still spare.
   */
  SPEAKER_BUFFER_BYTES = ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES,
  /* Whole-frame queueing makes replacement atomic at frame boundaries. */
  SPEAKER_QUEUE_DEPTH = SPEAKER_BUFFER_BYTES / FRAME_BYTES,
  /*
   * Playback will not start, or resume after starving, until this much audio
   * is queued. Without it the first frame starts the speaker with zero margin
   * and the DMA's 90 ms is the only tolerance the whole path has.
   */
  /*
   * 300ms before playback starts. The bridge bursts 600ms at the opening of
   * every response, so this is reached as fast as the wire allows and costs
   * almost nothing in latency — while doubling the cushion that a network
   * hiccup has to exhaust before anything is audible.
   */
  /*
   * Net of the DMA ring: the first 2880 bytes of any prefill go into the
   * hardware, not into jitter cushion, so the old "300ms" was really 210.
   * 300ms of true cushion plus one ring.
   */
  SPEAKER_PREFILL_BYTES = ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES,
  /*
   * Recovering from a starve does NOT re-buy the full opening prefill. It
   * used to, so a single late frame cost 160 ms of inserted silence —
   * measured at 45 starves per 3099 frames, roughly 7 s of stutter per
   * minute of speech. Mid-answer the bridge is already streaming, so a much
   * smaller cushion is enough to carry on.
   */
  /*
   * Beyond this much silence the answer is simply over: settle back to
   * priming rather than concealing an empty stream indefinitely.
   */
  SPEAKER_CONCEAL_LIMIT_MS = ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS,
  /*
   * How long the speaker must stay dry before the amplifier is powered down.
   * Long enough that a network hiccup mid-answer never power-cycles it.
   */
  SPEAKER_IDLE_POWERDOWN_MS = ITERATE_KIT_VOICE_SPEAKER_IDLE_POWERDOWN_MS,
  /* Longest a released turn waits for the uplink before committing anyway. */
  TURN_FLUSH_TIMEOUT_MS = ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS,
  /* Longest a single spoken turn may run before it is closed regardless. */
  TURN_MAX_MS = ITERATE_KIT_VOICE_TURN_MAX_MS,
  /* Control scan cadence; on one board each scan costs an I2C transaction. */
  CONTROL_POLL_MS = ITERATE_KIT_VOICE_CONTROL_POLL_MS,
  /* How long the transport may stay FAILED before the device reboots itself. */
  UNHEALTHY_RESTART_MS = ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS,
  /*
   * With a call wanted there is a live answer coming, so this long without ANY
   * batch on the delivery lane means the lane itself is gone. The remedy is a
   * recycle — one round trip that keeps the call — rather than giving up on it
   * and throwing away a live Grok session.
   *
   * This is now the ONLY application-level liveness deadline the device has.
   * It is also the only one that ever had honest evidence behind it: it fires
   * on silence when traffic is EXPECTED, which is the single condition under
   * which silence means anything at all.
   */
  DOWNLINK_SILENCE_MS = ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS,
  /*
   * The press's own liveness question, and the only one on this device that is
   * asked by an EVENT rather than by a clock. Ten seconds of nothing after a
   * press was the worst failure left here; three is what the arithmetic below
   * costs. See ITERATE_KIT_VOICE_PRESS_PROBE_MS for why the evidence is a PONG.
   */
  PRESS_PROBE_MS = ITERATE_KIT_VOICE_PRESS_PROBE_MS,
  PRESS_PROBE_ATTEMPTS = ITERATE_KIT_VOICE_PRESS_PROBE_ATTEMPTS,
  /*
   * Last resort. The transport can be READY, the socket open, and nothing
   * whatsoever moving: a half-open TCP connection looks perfectly healthy
   * from this end. If no probe has completed for this long, no amount of
   * in-process recovery has worked and the chip restarts.
   */
  NO_LIVENESS_RESTART_MS = ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS,
};

/* PSRAM-resident: 256 KiB would crowd internal RAM out of TLS headroom. */
EXT_RAM_BSS_ATTR static uint8_t
    inbox_storage_psram[CONTROL_INBOX_SLOTS][CONTROL_INBOX_SLOT_CAPACITY];
/*
 * PSRAM too. 8 x 8 KiB of internal .bss is memory the TLS handshake and the
 * SPI drivers need — with it in internal RAM, mbedtls_ssl_setup failed with
 * MBEDTLS_ERR_SSL_ALLOC_FAILED and the device could not connect at all. The
 * outbox is never a DMA target: lwIP copies on send.
 */
EXT_RAM_BSS_ATTR static uint8_t
    outbox_storage_psram[CONTROL_OUTBOX_SLOTS][CONTROL_OUTBOX_SLOT_CAPACITY];

/*
 * The stream this device mounts, as a runtime value seeded from the board's
 * `facts->stream_path`.
 *
 * A fresh path per conversation, and mutable. The old shared one accumulated
 * durable events until its Durable Object took ~1s per append — measured
 * against a fresh stream's 72ms — and since every handshake step is one append,
 * the device took 20s to come up and calls felt glacial.
 *
 * Mutable because a compile-time constant is exactly why "start a fresh
 * conversation" could not be expressed: one device, one stream, forever, and
 * every reboot resumed a context that might be days old. The path IS the
 * conversation's identity, so choosing it is choosing whether to continue or
 * begin — no other mechanism is needed.
 *
 * Its per-board DEFAULT, its /agents/voice/ prefix, and the client path beside
 * it are all constants and live in `struct iterate_kit_board_facts`; the notes
 * on why each is what it is went with them.
 */
static char stream_path[96];

/*
 * The turn policy this loop is CURRENTLY running, seeded from the board's
 * `facts->turns`.
 *
 * Runtime for the same reason the path above is: one board's dial re-selects
 * its conversation among streams whose far ends take turns differently, and
 * the posture has to follow the path — a push-to-talk board on a server-VAD
 * stream is a mic that only opens under a button the provider never asks for,
 * and the reverse commits turns the server's VAD owns. Only the two per-pass
 * reads below honour this; the push-to-talk MODULE stays decided by the
 * compile-time fact, because the capability surface is described to the peer
 * once at mount and cannot follow a dial that turns afterwards.
 */
static enum iterate_kit_voice_turns turn_policy;

/*
 * pdMS_TO_TICKS() truncates, so any wait shorter than one tick becomes zero —
 * and vTaskDelay(0) yields without blocking, which turns a short sleep into a
 * busy spin that can starve the idle task and trip the watchdog. Always wait
 * at least one tick.
 */
#define DELAY_MS(ms) \
  vTaskDelay(pdMS_TO_TICKS(ms) > 0U ? pdMS_TO_TICKS(ms) : 1U)

struct mic_frame {
  int16_t samples[FRAME_SAMPLES];
};

/*
 * A generation is the answer epoch. The consumer can hold a frame while the
 * producer replaces the answer; tagging the copied frame makes that race an
 * exact comparison instead of a byte-count guess over a concurrently-read
 * stream buffer.
 */
struct speaker_frame {
  uint32_t generation;
  int16_t samples[FRAME_SAMPLES];
};

_Static_assert(
    SPEAKER_BUFFER_BYTES % FRAME_BYTES == 0U,
    "speaker capacity must contain whole PCM frames");

/*
 * THE TRANSPORT IS INTERNAL RAM, AND THAT IS WHY IT IS NOT IN `runtime`.
 *
 * It carries the network task's STATIC stack and task control block, and a
 * FreeRTOS stack cannot live in PSRAM: the cache is off during a flash
 * operation and the scheduler would be running a task whose stack has
 * vanished. Everything else the loop holds tolerates PSRAM perfectly well —
 * see the note on `runtime` — so one symbol pays for internal placement
 * instead of sixty-six kilobytes doing it.
 */
static struct iterate_kit_esp_idf_itx_transport transport;

/*
 * EVERYTHING ELSE THE LOOP HOLDS, IN PSRAM — sixty-six kilobytes of it.
 *
 * Three of the four boards kept this internal and the fourth did not, and the
 * fourth is the one that dropped its socket mid-sentence with "esp-aes: Failed
 * to allocate memory" while `heapFree` read 5,800,196. Internal RAM is the
 * only kind TLS, Wi-Fi and DMA can use, and this struct needs none of those
 * properties: it is counters, Cap'n Web's three fixed tables, a JSON token
 * arena, a stats buffer and two queue HANDLES.
 *
 * Safe because nothing here is touched from an ISR — the audio ISRs belong to
 * the board drivers and never see it — and because atomics on this target
 * compile to interrupt-masked library calls (`-mdisable-hardware-atomics`),
 * not to instructions PSRAM cannot answer. A task reading PSRAM during a flash
 * write is exactly as safe as a task EXECUTING from flash, which every task
 * here already does.
 *
 * The transport is the one member that could not come, and it is hoisted
 * above rather than made an exception inside: a static task stack must be
 * internal, and burying that requirement in the middle of a struct is how it
 * gets forgotten.
 */
EXT_RAM_BSS_ATTR static struct {
  /*
   * WHAT THIS BOARD IS. Held rather than passed, because the voicelab
   * callbacks and both audio tasks are reached through function pointers the
   * platform calls with contexts of their own choosing.
   */
  const struct iterate_kit_board_ops *board;
  const struct iterate_kit_board_facts *facts;
  void *board_context;
  /*
   * WHAT THE PERSON IS TOLD, as one value, pushed once per pass.
   *
   * Assembled here and published by `present`. Eight setters used to write
   * this from 48 places; see voice/loop.h for the state that cost.
   */
  struct iterate_kit_voice_view view;
  /*
   * INTENT, which is now the loop's rather than a panel driver's.
   *
   * `view.wants_call` and `view.talk_held` are the two flags a physical
   * control and an RPC both land on, so remote and local control cannot
   * disagree about what the device is doing. `remote_talk` is the RPC half of
   * the second one, kept apart so releasing the button does not cancel a hold
   * an agent is still asking for, and vice versa.
   */
  bool remote_talk;
  /** What the board's controls last said. Edges are consumed once, on the pass
   * that resolves them; `talk_held` is a level and is read every pass. */
  struct iterate_kit_voice_intent intent;
  struct iterate_kit_audio_codec codec;
  struct iterate_kit_audio_processor processor;
  /*
   * The one owner of the capture cadence conversion. Touched only by the
   * capture task, which is why it holds no atomics and why the counters it
   * publishes are mirrored out through ones that do.
   */
  struct iterate_kit_aec_capture_bridge capture_bridge;
  /** Synthesised for a board with no `capture_meta`; see the capture step. */
  uint32_t capture_sequence;
  struct iterate_kit_configuration configuration;
  struct iterate_kit_itx_connection connection;
  struct capnweb_pending_call pending_calls[PENDING_CALL_CAPACITY];
  struct capnweb_export exports[EXPORT_CAPACITY];
  struct capnweb_import imports[IMPORT_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  struct iterate_kit_spsc_ring control_inbox;
  struct iterate_kit_spsc_ring control_outbox;
  size_t inbox_lengths[CONTROL_INBOX_SLOTS];
  size_t outbox_lengths[CONTROL_OUTBOX_SLOTS];
  struct iterate_kit_peer peer;
  /*
   * REMOTE HANDS. This board is the one that gets left on a shelf running a
   * soak, and it was also the only one of the four with NO capabilities at
   * all: it mounted at kit.waveshare and answered nothing, so the only way to
   * ask it anything was its console, which reboots it. Same three as the
   * others now — talk, conversation, health — reaching the same two intent
   * flags the physical buttons set.
   */
  struct iterate_kit_device_event device_event_storage
      [ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY];
  struct iterate_kit_device_event_queue device_events;
  struct iterate_kit_push_to_talk push_to_talk;
  struct iterate_kit_conversation_control conversation_control;
  struct iterate_kit_voicelab voicelab;
  /* The last refusal from start_call, and how many there have been. */
  enum capnweb_status last_start_status;
  /* The launch seam's own answer, so a branch is named not inferred. */
  int last_launch_step;
  uint32_t launch_polls;
  /*
   * What the seam SAW, captured in the same poll as its answer.
   *
   * Reading these separately through health() reads them at different
   * instants, so a latch that is true when health asks and false when the
   * loop asks looks like an impossibility: every input green and the answer
   * still NOTHING. Captured together, the paradox resolves itself.
   */
  bool saw_wants_call;
  bool saw_link_ready;
  uint32_t wants_call_polls;
  uint32_t start_call_failures;
  /*
   * WHICH ANSWER THE SPEAKER IS PLAYING, counted locally because nothing on
   * the wire numbers them any more.
   *
   * The sender paces the audio and marks the first chunk of each answer with
   * `drop`, which arrives here as SPEECH_STARTED — so "a new answer began" is
   * an EDGE the device observes rather than a number it compares. The count
   * exists for one reason: the viseme ledger scopes a mouth track to an
   * answer, so notes about the audio have to say which answer they are about.
   */
  uint32_t answers_started;
  /**
   * Answers that displaced audio the listener had not heard yet.
   *
   * The subset of `answers_started` that costs something: a flush with an
   * empty queue is the ordinary gap between turns, a flush with audio still
   * in it is a barge-in or a supersede. Measured from the bytes the abandon
   * actually threw away, which is the only honest witness now that the
   * classifier's answer bookkeeping is gone.
   */
  uint32_t answers_superseded_midplay;
  /* Drops obeyed, and the board's own uptime at the last one. See the
   * SPEECH_STARTED arm: this is how a late instruction is told apart from
   * a slow ring, which the ephemeral lane's coalescing otherwise hides. */
  uint32_t speaker_drops;
  uint32_t last_drop_uptime_ms;
  uint32_t voicelab_generation;
  uint32_t frame_sequence;
  /*
   * Generous on purpose: a stats line that outgrows this is silently NOT
   * sent (snprintf truncates and the append is skipped), so the instrument
   * would go dark exactly when someone added the counter that explains a
   * bug. The overflow is logged for the same reason.
   */
  /*
   * 2816, and it grows whenever fields are added. It was 1536; nine added
   * fields overflowed it and the device went dark, because every downstream
   * reader then sees "no stats", which looks like a broken speaker rather than
   * a full buffer. The guard names the field it stopped at, which is how that
   * was found in one read.
   *
   * The last +256 is the four press-probe fields. 81 fields at their longest
   * rendering is ~2.3 KiB before the board appends its own dozen, so the
   * headroom here is thinner than the number looks. This lives in PSRAM with
   * the rest of `runtime`, so the margin is nearly free and the failure it
   * prevents is a board that answers nothing when asked how it is.
   */
  char stats_buffer[2816];
  uint32_t stats_sequence;
  enum iterate_kit_esp_idf_itx_transport_state last_transport_state;
  enum iterate_kit_voicelab_state last_voicelab_state;
  /* Cross-task audio plumbing. */
  QueueHandle_t mic_queue;
  QueueHandle_t speaker_queue;
  atomic_uint speaker_generation;
  atomic_uint_fast64_t speaker_last_write_ms;
  /*
   * The playback step's two persistent locals. They were locals of a `for(;;)`
   * that never returned; a step returns every pass, so they live here with the
   * rest of the speaker's state. Written only by the playback task.
   */
  struct iterate_kit_voice_playback_clock playout_clock;
  uint64_t last_write_ms;
  uint32_t mic_frames_captured;
  uint32_t mic_frames_dropped;
  uint32_t mic_process_failures;
  /** Captured with no turn open: room noise, never sent, never queued. */
  uint32_t mic_frames_idle;
  /*
   * THE LOUDEST SAMPLE IN THE NEWEST FRAME, and the loudest ever seen.
   *
   * Written by the CAPTURE task, read by the app task, so they are atomics
   * rather than plain words — `view.microphone_peak` stays app-task-owned and
   * is refreshed from here once per pass, which keeps the view a value one
   * task assembles instead of a struct two tasks write.
   *
   * `mic_peak_max` exists because a deaf board and a quiet room are otherwise
   * indistinguishable: `micCaptured` climbs identically for both.
   */
  atomic_uint mic_peak;
  atomic_uint mic_peak_max;
  /*
   * THE BRIDGE'S OWN CENSUS, MIRRORED BY THE TASK THAT OWNS IT.
   *
   * `metrics()` is a const reader now, so the app task could call it — but the
   * bridge holds no atomics and a multi-word counter read from another task
   * can still tear. Mirroring here is the same shape the uplink selector uses.
   */
  atomic_uint aec_bridge_failures;
  atomic_uint aec_bridge_reset_failures;
  atomic_uint aec_sequence_discontinuities;
  atomic_uint aec_clock_regressions;
  atomic_uint aec_egress_copy_failures;
  uint32_t speaker_frames_played;
  /* Written by both the app producer and playback consumer. */
  atomic_uint speaker_overflow_drops;
  /*
   * Audio removed by the barge-in discard.
   *
   * This was the ONLY path that could delete queued speech without
   * incrementing anything, and that is exactly what it did: 758 frames
   * arrived, 150 played, the ring empty, and every other counter zero. A
   * silent drop path turns a five-minute measurement into an afternoon of
   * theories - two of which were wrong - so it counts now.
   */
  /* Queue-reset accounting is app-owned; in-flight rejection is playback-owned. */
  atomic_uint speaker_discarded_frames;
  /*
   * The two ways the reader can decline to play WITHOUT touching any other
   * counter, and therefore the only remaining blind spots in this loop.
   *
   * `speaker_waits_priming` is ready() saying no: the ring is below the
   * prefill mark. `speaker_waits_dry` is the ring being empty and the clock
   * choosing WAIT over CONCEAL. A stall in either is invisible today - the
   * failing runs show frames arriving with played AND conceal both frozen,
   * which is exactly what these two look like from outside.
   */
  uint32_t speaker_waits_priming;
  uint32_t speaker_waits_dry;
  /*
   * A starve is only a DEFECT if the stream had more to say. The buffer
   * legitimately empties at the end of every answer, and counting that as an
   * underrun made the metric read one per answer no matter how healthy the
   * pipe was — which is exactly the sort of false positive that hides a real
   * one. A starve is promoted to an underrun only when audio resumes soon
   * after it, meaning the answer was still in progress.
   */
  uint32_t speaker_underruns;
  uint32_t speaker_conceal_frames;
  uint32_t speaker_catchup_frames;
  uint32_t speaker_write_failures;
  uint32_t speaker_margin_max_ms;
  atomic_uint_fast64_t starve_at_ms;
  /*
   * Proving "no underruns" needs more than a count of holes: every write
   * records how much audio was still queued behind it, so the minimum over a
   * call says how close the pipe ever came to running dry. A run with a
   * healthy floor is evidence; a zero count alone proves nothing.
   */
  uint32_t speaker_margin_min_ms;
  uint32_t speaker_writes;
  uint32_t speaker_bad_frames;
  /* Connections replaced because nothing was being delivered on them. */
  uint32_t downlink_recycles;
  /* How many of those in a row have not yet produced a batch. */
  uint32_t downlink_recycles_running;
  /*
   * THE PRESS PROBE: is this socket still connected to anything?
   *
   * Armed when a call is placed and disarmed by the PONG. `sent_ms` is zero
   * when nothing is outstanding, which is every moment of an idle board's life
   * — see ITERATE_KIT_VOICE_PRESS_PROBE_MS for why an idle probe would be the
   * wrong thing entirely.
   */
  uint64_t press_probe_sent_ms;
  uint32_t press_probe_pongs_before;
  /* The PONG count as of this pass, sampled by the liveness block so the
   * launch below can take a baseline without a second metrics snapshot. */
  uint32_t pongs_seen;
  uint8_t press_probe_attempt;
  /* Probes sent, probes that no PONG answered, and the last measured round
   * trip. The last one is the instrument that turns the 1500 ms budget into a
   * number somebody can check. */
  uint32_t press_probes;
  uint32_t press_probe_misses;
  uint32_t press_probe_ms;
  uint32_t press_probe_restarts;
  /* Diagnostics for a frozen device: see the pulse in the app loop. */
  uint32_t loop_count;
  uint64_t last_pulse_ms;
  bool talking;
  /*
   * Speech spoken INTO THE DIAL is captured, not thrown away. From the
   * press that wants a call until the call is active, capture queues into
   * mic_queue (5.12 s deep) and the drain holds it back; the accepted call
   * then carries it. Without this, everything said between the wake press
   * and CALL_ACCEPTED — two to four seconds warm, twenty cold — was
   * discarded at the capture gate, and a person who pressed and spoke got
   * an answer to nothing. The host CLI never showed it only because its
   * dial is warm in about a second.
   */
  /** The unwritten button audit, latest wins; see the resolution site. */
  const char *pending_button_audit;
  bool dial_buffering;
  /* A push-to-talk dial buffered speech; the OPENING turn must not reset
   * the queue that holds it. SURVIVES a release during the dial — the
   * accepted call drains and commits it as the first turn. Consumed at
   * turn start, cleared with the call. */
  bool dial_speech_queued;
  /*
   * A call that vanished WITHOUT its obituary holds the relaunch ladder
   * until this deadline, because the obituary may simply not have arrived
   * yet: the far end's hang-up settles the device's call RPC ~100 ms before
   * its conversation-ended event can be delivered, and relaunching in that
   * gap births a zombie call the late obituary then kills — measured
   * 2026-08-19 14:22:42: relaunch 87 ms after the end, the zombie shot down
   * mid-wake ("call ended" twice in a row), its conversation orphaned until
   * the 60 s idle timeout. A genuine connection recycle still relaunches,
   * just this much later.
   */
  uint64_t obituary_grace_until_ms;
  /* Release pressed, but the capture queue is not yet on the wire. */
  bool flushing_turn;
  atomic_bool speaker_reprime;
  /**
   * When the current answer's playout began, and how much of it has played.
   *
   * Together these ARE the audio timeline: frame N of an answer should reach
   * the speaker 20N ms after the first one did. The difference between that
   * and the wall clock is how far behind realtime this device is, and it is
   * the only honest measure of "behind" — queue depth is not, because a whole
   * answer legitimately arrives at once and a deep queue then means the
   * sender was fast, not that playback is late.
   *
   * Needs no clock agreement with the server: both terms are local, and the
   * answer's own first frame is the origin.
   */
  atomic_uint_fast64_t answer_started_ms;
  atomic_uint answer_emitted_ms;
  /** When an RPC was last answered: the mount's own liveness, not the socket's. */
  uint32_t speaker_lag_max_ms;
  atomic_bool speaker_answer_done;
  /*
   * The SENDER said this answer is complete, latched until the speaker actually
   * drains it. `speaker_answer_done` is consumed by the playback clock the
   * moment it is seen, long before the buffer empties, so it cannot answer
   * "has this answer finished being heard?" — and that question is the whole
   * difference between an answer that ended and an answer that was cut off.
   */
  atomic_bool answer_declared_done;
  uint32_t turn_marker_failures;
  uint32_t flush_frames_left;
  uint64_t flush_deadline_ms;
  uint64_t turn_started_ms;
} runtime;

/*
 * THE BOARD, OR NOTHING.
 *
 * Every op below `start` and `present` is optional — a NULL pointer is a board
 * saying it has no such hardware. Funnelling the checks through four one-line
 * thunks keeps that fact in one place instead of at each of the ~110 call sites
 * the four device files used to spread it over.
 */
static void board_phase(enum iterate_kit_voice_phase phase) {
  if (runtime.board->phase != NULL) {
    runtime.board->phase(runtime.board_context, phase);
  }
}

static void board_answer(const struct iterate_kit_voice_answer_note *note) {
  if (runtime.board->observe_answer != NULL) {
    runtime.board->observe_answer(runtime.board_context, note);
  }
}

/*
 * MOVE THE HALF-DUPLEX FENCE, or do nothing on a board that has none.
 *
 * On the one board that is half duplex the ES8311's ADC and DAC share
 * MCLK/BCLK/WS, so capture requires DELETING the playback channel: the
 * microphone physically cannot run while the speaker does. Asynchronous —
 * `playout_fenced_out` is how the playback step learns the fence has settled.
 *
 * The SEQUENCING is the loop's and stays below, because it is policy and not a
 * driver: the pins are taken only after the turn marker is on the wire AND the
 * speaker queue has been emptied, and they are given back at the RELEASE edge
 * rather than at the commit, so the answer can play the moment it arrives.
 */
static void board_fence(bool microphone_owns_pins) {
  if (runtime.board->capture_fence != NULL) {
    runtime.board->capture_fence(runtime.board_context, microphone_owns_pins);
  }
}

static void board_playout(const int16_t *pcm, size_t samples) {
  if (runtime.board->observe_playout != NULL) {
    runtime.board->observe_playout(runtime.board_context, pcm, samples);
  }
}

/*
 * Show the current view. Unconditional, once per app-loop pass: the board
 * decides whether anything changed, under the one lock it already holds, which
 * is cheaper than the nine lock round trips the setters cost.
 */
static void present(void) {
  runtime.board->present(runtime.board_context, &runtime.view);
}

static uint32_t speaker_queued_bytes(void) {
  if (runtime.speaker_queue == NULL) return 0U;
  return (uint32_t)uxQueueMessagesWaiting(runtime.speaker_queue) * FRAME_BYTES;
}

/*
 * The two strings that describe this device to whoever holds the capability
 * are `facts->instructions` and `facts->peer_description`. They are per-board
 * prose — one board says "the upper button is push-to-talk", another says
 * "speak whenever you like" — and voice/loop.h records which of the two a
 * model actually reads, which is not the one you would guess.
 */

static void on_session_ended(void *context) {
  (void)context;
  runtime.voicelab.state = ITERATE_KIT_VOICELAB_FAILED;
  runtime.voicelab.failure = ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED;
  runtime.voicelab.has_session_capability = false;
  runtime.voicelab.has_project_capability = false;
  runtime.voicelab.has_stream_capability = false;
  runtime.voicelab.has_connection_capability = false;
  runtime.voicelab.has_previous_connection_capability = false;
  runtime.voicelab.has_callback_capability = false;
  runtime.voicelab_generation = 0U;
}

static uint64_t now_ms(void *context) {
  (void)context;
  return (uint64_t)(esp_timer_get_time() / 1000);
}

static bool publish_turn_marker(enum iterate_kit_voicelab_turn turn) {
  const enum capnweb_status status =
      iterate_kit_voicelab_mark_turn(&runtime.voicelab, turn);
  if (status == CAPNWEB_OK) return true;

  ++runtime.turn_marker_failures;
  ESP_LOGE(
      tag,
      "turn %s publication failed: capnweb=%d; replacing transport",
      turn == ITERATE_KIT_VOICELAB_TURN_START ? "start" : "commit",
      (int)status);
  /*
   * The bridge cannot infer a missing edge. Invalidate the producer gate now,
   * then remount on a fresh session rather than sending audio whose turn state
   * is ambiguous or pretending a commit succeeded.
   */
  runtime.voicelab_generation = 0U;
  iterate_kit_esp_idf_itx_transport_request_restart(&transport);
  runtime.view.status = ("reconnecting");
  return false;
}

/* --- speaker path (voicelab callbacks run on the app task) ---------------- */

/*
 * ONE FRAME OF THE ANSWER, ALREADY PACED BY THE SENDER.
 *
 * There is no policy left here, and that is the change: the device used to
 * decide per frame whether to append, replace or ignore it, from a call /
 * answer / frame identity on the wire. The sender now releases the answer at
 * playback rate in chunks, marks the first chunk of a replacing answer with
 * `drop` — which arrives as SPEECH_STARTED, ahead of the audio it invalidates
 * — and marks the last with `last`. So a frame that reaches this function is
 * a frame to play, in order, full stop.
 */
static void admit_speaker_frame(const uint8_t *pcm, size_t pcm_length) {
  static struct speaker_frame frame;
  if (uxQueueSpacesAvailable(runtime.speaker_queue) == 0U) {
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
    return;
  }
  /*
   * Power the amplifier the moment audio ARRIVES, not when the first sample
   * is written. A class-D amp needs tens of milliseconds to settle, and
   * raising it two milliseconds before the first write meant the opening of
   * every answer played into an amp that was not up yet — heard as the first
   * half-word being clipped or missing. Enabling it here spends the playout
   * prefill (160 ms) as settle time, which costs nothing.
   */
  board_phase(ITERATE_KIT_VOICE_PHASE_ARRIVED);
  atomic_store_explicit(
      &runtime.speaker_answer_done, false, memory_order_release);
  /*
   * SPEAKING FOLLOWS THE AUDIO, not a transcript.
   *
   * This used to be set from `on_transcript`, which meant the face and the
   * lights announced the answer when its TEXT arrived. Text and audio are
   * separate event streams and routinely arrive out of order, so the screen
   * could say "speaking" before a sample had played, or stay on the previous
   * state through the first words. Clients no longer receive transcripts at
   * all; a frame admitted to the speaker queue is the honest signal, and the setter
   * is idempotent so paying for it per frame costs one compare.
   */
  runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_SPEAKING;
  /*
   * Audio arriving within a second of a starve means the answer was still
   * going: the pipe genuinely ran dry mid-speech, and that is audible.
   */
  {
    const uint64_t starved_at = atomic_exchange_explicit(
        &runtime.starve_at_ms, 0U, memory_order_acq_rel);
    const uint64_t now = now_ms(NULL);
    if (starved_at != 0U &&
        iterate_kit_voice_elapsed_ms(now, starved_at) < 1000U) {
      ++runtime.speaker_underruns;
    }
  }
  frame.generation = atomic_load_explicit(
      &runtime.speaker_generation, memory_order_acquire);
  memcpy(frame.samples, pcm, sizeof(frame.samples));
  if (xQueueSend(runtime.speaker_queue, &frame, 0) != pdTRUE) {
    /* Only this task writes, but retain an exact signal if that invariant drifts. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
    return;
  }
  /* Counted only for frames actually admitted: the viseme ledger must see
   * exactly the samples the analyzer will eventually be fed. */
  {
    const struct iterate_kit_voice_answer_note note = {
      .kind = ITERATE_KIT_VOICE_ANSWER_ADMITTED,
      .answer = runtime.answers_started,
      .sample_count = pcm_length / 2U,
    };
    board_answer(&note);
  }
}

/*
 * THE SPEAKER QUEUE IS FRAME-SHAPED, AND THE WIRE IS NOT. So the phase is
 * absorbed HERE, in the one place that knows how the queue is built, rather
 * than being made the sender's problem.
 *
 * A FreeRTOS queue holds fixed-size items, so audio has to reach it in whole
 * frames; a partial write would splice the head of one frame onto the next at
 * an arbitrary phase. That much is real. What was NOT real is the rule this
 * replaces — refusing any chunk that was not exactly one frame — which pushed
 * the alignment all the way back up the wire to a provider whose deltas are
 * audio of no particular length, and cost a carried remainder in the sender, a
 * silence-padded tail on every answer, and 118 dropped chunks in three turns
 * when it slipped. Consecutive samples written consecutively are the same
 * waveform however they were cut, so all that was ever needed is a few hundred
 * bytes of memory to hold a part-frame until the audio that continues it lands.
 *
 * CLEARED WITH THE QUEUE, by abandon_speaker_audio(): a remainder left over
 * from an abandoned answer would otherwise be spliced onto the front of the
 * next one, which is the click this is supposed to prevent, arriving once per
 * barge-in.
 */
static uint8_t speaker_partial[FRAME_BYTES];
static size_t speaker_partial_length;

static void on_speaker_pcm(
    void *context,
    const uint8_t *pcm,
    size_t pcm_length) {
  size_t taken = 0U;
  (void)context;
  /* An ODD length is still refused: it would shift the 16-bit sample grid
   * permanently rather than merely cutting the waveform somewhere unexpected. */
  if (pcm == NULL || (pcm_length & 1U) != 0U) {
    ++runtime.speaker_bad_frames;
    return;
  }
  while (taken < pcm_length) {
    const size_t want = (size_t)FRAME_BYTES - speaker_partial_length;
    const size_t have = pcm_length - taken;
    const size_t copy = have < want ? have : want;
    memcpy(speaker_partial + speaker_partial_length, pcm + taken, copy);
    speaker_partial_length += copy;
    taken += copy;
    if (speaker_partial_length < (size_t)FRAME_BYTES) break;
    speaker_partial_length = 0U;
    admit_speaker_frame(speaker_partial, (size_t)FRAME_BYTES);
  }
}

/*
 * ONE FUNNEL FOR THROWING QUEUED SPEAKER AUDIO AWAY.
 *
 * Five sites used to do this by hand — barge-in, a superseded answer, a call
 * accepted, the bridge hanging up, a new turn's flush — in three different
 * orders. Two disarmed the starvation watch AFTER taking the audio away, two
 * never disarmed at all, and one was right. On 2026-08-04 the wrong ordering
 * cost the acceptance run at 5/10: the bridge had raced 13,020ms ahead, the
 * hang-up arrived with the ring that deep, and `spkStarveEvents` — the
 * never-tier gate — recorded a starvation the device had caused on purpose.
 *
 * Keep these five effects together. The ordering is the correctness proof:
 * disarm -> note flush -> invalidate -> discard -> reprime. In particular,
 * invalidating before disarming creates a window in which an intentional cut
 * is counted as listener-visible starvation. ESP-IDF 5.4.2's
 * FreeRTOS-Kernel-SMP/queue.c:xQueueGenericReset holds the queue lock and leaves
 * blocked receivers waiting when an existing queue is reset. A frame copied
 * before that lock was taken is rejected by generation.
 */
static uint32_t abandon_speaker_audio(void) {
  board_phase(ITERATE_KIT_VOICE_PHASE_FLUSHED);
  const uint32_t bytes = speaker_queued_bytes();
  (void)atomic_fetch_add_explicit(
      &runtime.speaker_generation, 1U, memory_order_acq_rel);
  (void)xQueueReset(runtime.speaker_queue);
  (void)atomic_fetch_add_explicit(
      &runtime.speaker_discarded_frames,
      bytes / FRAME_BYTES,
      memory_order_relaxed);
  atomic_store_explicit(
      &runtime.speaker_reprime, true, memory_order_release);
  /*
   * AND THE ANSWER'S CLOCK GOES WITH ITS AUDIO.
   *
   * The playout timeline is per-ANSWER — frame N belongs 20N ms after the
   * first one played — so a flush, which by definition leaves no answer in
   * flight, must leave no timeline either. Zero rather than `now`: the origin
   * is then taken from the next frame that actually plays, which is correct
   * however long the gap turns out to be.
   *
   * IN THE FUNNEL RATHER THAN AT THE FLUSH SITES, for the reason the funnel
   * exists. It was written at ONE of the four — the new-answer branch — and
   * the other three were left resetting nothing: a new CALL emptied the ring
   * and kept the last call's clock, so the first audio of the new one was
   * measured against an answer minutes old and the catch-up rule deleted it.
   * Measured on the StackChan after this file's other fix: 34 frames skipped
   * with `spkLagMaxMs` at 117,083.
   */
  atomic_store_explicit(&runtime.answer_started_ms, 0U, memory_order_release);
  atomic_store_explicit(&runtime.answer_emitted_ms, 0U, memory_order_release);
  /* And the part-frame waiting for audio that is never coming: spliced onto
   * the front of the next answer, it is a click once per barge-in. */
  speaker_partial_length = 0U;
  /*
   * The face was animating this audio and must forget what nobody will hear,
   * and the mouth track scheduled against it dies with it. One note for both,
   * because they have to be serialized against the ADMITTED notes above — all
   * abandon sites run on the app task, which is what the viseme ledger
   * requires.
   */
  {
    const struct iterate_kit_voice_answer_note note = {
      .kind = ITERATE_KIT_VOICE_ANSWER_ABANDONED,
    };
    board_answer(&note);
  }
  return bytes;
}

static void on_control(
    void *context, enum iterate_kit_voicelab_control control) {
  (void)context;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    /*
     * A NEW ANSWER STARTS HERE, AND SO DOES ITS TIMELINE.
     *
     * `drop` rides the first chunk of the replacing answer and is raised
     * BEFORE that chunk's audio is handed over, so everything below happens
     * while the queue still holds only the answer being displaced. The old
     * per-frame REPLACE branch did the same three things; it just discovered
     * the transition by comparing numbers a frame carried.
     *
     * THIS USED TO BE GATED ON THE LOCAL MICROPHONE, AND THAT COST TWO BOARDS
     * FOUR FIFTHS OF EVERY ANSWER AFTER THE FIRST.
     *
     * The gate — `iterate_kit_barge_in_admit`, 300 PCM16 within 600 ms — was
     * written for a `speech_started` that arrived on the provider's OWN event
     * lane, where it really was a VAD firing on echo the canceller missed and
     * really did stop an answer mid-word (barge_in.h has those measurements).
     * That lane is gone. `drop` is raised by the SENDER, from
     * `response.created`, and reaches this device on the first chunk of the
     * audio it invalidates — so it does not mean "somebody interrupted", it
     * means "the answer you are holding has been superseded".
     *
     * Corroborating it against the microphone therefore asks the wrong
     * question and gets the wrong answer on every ordinary turn: an answer's
     * first chunk lands one to two seconds after the person stopped talking,
     * which is past the window, so the whole branch was refused — including
     * the timeline reset below, so the NEXT answer was measured against the
     * PREVIOUS answer's clock and the lag catch-up rule deleted it as
     * hopelessly late. Measured on the StackChan: 3616 frames received, 1026
     * played, 2590 skipped, `spkLagMaxMs` 643,208.
     *
     * AND THE GATE COULD NOT HAVE SAVED THE OLD ANSWER ANYWAY. `speakerReplace`
     * empties the sender's pending bytes before it arms `drop`, so by the time
     * this arrives the audio it is about has already been destroyed at the
     * source. Refusing the flush keeps a dead answer's tail in the ring in
     * front of the live one — worse on both counts.
     */
    /*
     * WE ARE ABOUT TO ABANDON AUDIO, SO SAY SO NOW.
     *
     * The starvation watch is disarmed inside the funnel rather than in the
     * speaker task's reprime branch, because the flush happens on THIS task
     * while the speaker task is blocked in its 60ms receive with the watch
     * still armed. The ring plays out the last 90ms of the abandoned answer and
     * then goes dry waiting for the replacement's first frame — and that gap
     * was landing in the DMA ledger deficit at send index 164: deep into
     * feeding, nowhere near an opening, and only ever when an answer was
     * displaced.
     *
     * The gap is real and the listener hears it. It is also entirely ours and
     * entirely intended, which is the whole difference from starvation.
     *
     * The funnel also restarts the answer's clock, which is the other half of
     * "a new answer starts here".
     */
    if (abandon_speaker_audio() > 0U) ++runtime.answers_superseded_midplay;
    ++runtime.answers_started;
    /*
     * WHEN THIS DEVICE WAS TOLD, ON ITS OWN CLOCK.
     *
     * Everything the harness can see is an arrival time on an ephemeral lane
     * that coalesces by seconds, so "the board kept talking for nine seconds"
     * cannot currently be split into the two halves that have opposite fixes:
     * the instruction arriving late, or the instruction arriving on time and
     * the ring taking that long to empty. This stamp is the split. It is read
     * over RPC (`health()`), which is not that lane, and compared against the
     * board's own uptime in the same payload.
     */
    ++runtime.speaker_drops;
    runtime.last_drop_uptime_ms = (uint32_t)(esp_timer_get_time() / 1000);
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_LISTENING;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    /*
     * The answer is finished, so a dry buffer from here is not a deficit —
     * it is simply the end. Telling playback that keeps concealment meaning
     * "audio failed to arrive in time", which is the only reading worth
     * having: without it every answer contributed a settle window's worth of
     * concealed frames and the metric could never reach zero.
     */
    atomic_store_explicit(
        &runtime.speaker_answer_done, true, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_declared_done, true, memory_order_release);
    /*
     * IT MUST NOT THROW THE QUEUE AWAY, however tempting "the answer is over,
     * clear up for the next one" looks. This edge now rides the answer's last
     * chunk and is raised after that chunk's audio is handed over, so there
     * are still up to a few hundred milliseconds of it queued here — the end
     * of the sentence. Discarding it clips every answer.
     *
     * It used to be a `response.done` on a separate text lane, where it
     * routinely overtook the audio entirely: measured at 258 frames received
     * and none played, with a transcript proving the model had spoken.
     */
    /* The answer is complete: back to waiting for the next turn. */
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
    runtime.view.status = runtime.facts->talk_hint;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    /*
     * A NEW CALL IS A NEW SENDER, AND THE ONLY THING THAT CARRIED ACROSS ONE
     * WAS THE AUDIO ITSELF.
     *
     * A reset of the frame classifier used to be the important part of this
     * branch: answer and frame numbers restarted with every call, so a second
     * call on the same mount opened numerically BEHIND the last one and every
     * frame of it was refused as a duplicate — measured at 539 of 583 frames,
     * 10.78s of an answer nobody heard. There is no numbering to be behind any
     * more. What remains is emptying the queue, so the previous conversation
     * does not play into the opening of this one.
     */
    (void)abandon_speaker_audio();
    atomic_store_explicit(
        &runtime.speaker_answer_done, false, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_declared_done, false, memory_order_release);
    ESP_LOGI(tag, "new call accepted: speaker queue emptied for a fresh sender");
    runtime.view.call_active = (true);
    /* The viseme lane owns the mouth for the duration of the call. */
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
    runtime.view.status = runtime.facts->talk_hint;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    /*
     * Drop whatever is still queued. The ring holds thirty seconds, so a call
     * that ends mid-answer otherwise plays the dead conversation out after
     * the screen has already said it is over.
     *
     * AND STOP MEASURING FIRST. Abandoning queued audio is the device's own
     * decision, so the starvation detector must be disarmed before the source
     * goes away — otherwise the audio-empty deadline it is holding passes with
     * nothing more written, and a deliberate abandon is recorded as a real
     * starve event. Every other discard site pairs these three lines; this one
     * did not, and it survived by luck: the local hang-up path usually drains
     * first. Measured on 2026-08-04, session 5 turn 7 of the acceptance run —
     * the bridge had raced 13,020ms of audio ahead of realtime, so CALL_ENDED
     * arrived with the ring still deep, and `spkStarveEvents` moved by 1.
     */
    (void)abandon_speaker_audio();
    /*
     * AND THE SESSION ENDS WITH IT. The intent used to survive this event on
     * the reasoning that only a person changes intent, so any bridge-side end
     * was a call to reopen — and the launch ladder obliged on the next pass.
     * That doctrine turned every ANNOUNCED end into a resurrection: measured
     * 2026-08-19, the model's hang_up tool ended a call at 12:53:25 and its
     * successor was up within the same second, which makes hanging up
     * impossible on a board whose microphone rides the call, and turns the
     * bridge's own 60 s idle timeout into a metronome. A conversation the far
     * end declares over IS over: the latch clears, the microphone gate closes
     * behind it (SERVER_VAD talk rides call_active; push-to-talk requires the
     * latch), and the next call takes a new wake press. A call lost WITHOUT
     * this event — the liveness forget, a connection recycle — still
     * relaunches, because there the person still wants the session they
     * opened; this arm is only ever the far end saying goodbye.
     */
    runtime.view.wants_call = (false);
    runtime.view.call_active = (false);
    /* The dial buffer dies with the call it was dialling. */
    runtime.dial_speech_queued = false;
    /* Envelope mouth returns for whatever local life the face has next. */
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
    runtime.view.status = ("call ended");
  }
}

/*
 * THE MOUTH, FROM THE PROCESSOR'S OWN REDUCED STATE.
 *
 * Runs on the app task, which is where the voicelab completions land, so it is
 * serialized against ADMITTED and ABANDONED exactly as the viseme ledger
 * requires. The dedupe by `at` lives in the stream, so anything reaching here
 * is a shape the mouth actually moved to.
 */
static void on_face(
    void *context,
    uint32_t answer,
    uint32_t offset_samples,
    uint8_t viseme,
    uint8_t confidence) {
  const struct iterate_kit_voice_answer_note note = {
    .kind = ITERATE_KIT_VOICE_ANSWER_VISEME,
    .answer = answer,
    .offset_samples = offset_samples,
    .viseme = viseme,
    .confidence = confidence,
  };
  (void)context;
  board_answer(&note);
}

static bool playback_apply_reprime(
    struct iterate_kit_voice_playback_clock *playout_clock) {
  if (!atomic_exchange_explicit(
          &runtime.speaker_reprime, false, memory_order_acq_rel)) {
    return false;
  }
  atomic_store_explicit(
      &runtime.speaker_answer_done, false, memory_order_release);
  atomic_store_explicit(
      &runtime.answer_declared_done, false, memory_order_release);
  /*
   * abandon_speaker_audio() already disarmed and accounted for the hardware
   * flush before publishing speaker_reprime. This task owns only the portable
   * playout clock, so it resets that clock exactly once for the new epoch.
   */
  iterate_kit_voice_playback_clock_reprime(playout_clock);
  return true;
}

/*
 * ONE PASS OF THE SPEAKER, so that it is a function rather than a `for(;;)`.
 *
 * A step can be called, and therefore tested, and therefore driven by a host
 * that has one thread where a board has three. Nothing else about it changed:
 * every `continue` in the body below became a `return`, and the two locals
 * that had to survive an iteration — the playout clock and the last write —
 * moved into the runtime beside the state they already describe.
 */
void iterate_kit_voice_loop_playback_step(void) {
  static struct speaker_frame frame;
  /*
   * The writer NEVER stops. That is the whole design.
   *
   * It used to stop on an empty read and wait to re-buy a cushion — and the
   * cushion it waited for (40 ms) was SMALLER THAN THE DMA RING IT HAD JUST
   * LET RUN DRY (90 ms). So every recovery under-filled the hardware and
   * immediately starved again: one network hiccup produced a train of holes,
   * which is why the rate never went to zero however large the buffers grew.
   *
   * The answer to that was to write silence on an empty read, and it was the
   * wrong one: silence occupies playout time and cannot be taken back, so
   * every frame of it puts the rest of the answer permanently further behind.
   * The right answer, and the one three reference implementations use, is to
   * wait long enough that a late frame is absorbed by the hardware cushion
   * rather than concealed — see the read and the dry branch below.
   */
  size_t received;

  /*
   * FENCED OUT. While the microphone owns the shared pins — or the fence is
   * moving in either direction — this step must not pull frames it can only
   * fail to write. Frames stay queued; the fence drops within milliseconds of
   * the turn committing, long before an answer.
   */
  if (runtime.board->playout_fenced_out != NULL &&
      runtime.board->playout_fenced_out(runtime.board_context)) {
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    DELAY_MS(5);
    return;
  }

  (void)playback_apply_reprime(&runtime.playout_clock);
  if (atomic_exchange_explicit(
          &runtime.speaker_answer_done, false, memory_order_acq_rel)) {
    iterate_kit_voice_playback_clock_answer_done(&runtime.playout_clock);
  }
  if (!iterate_kit_voice_playback_clock_ready(
          &runtime.playout_clock, speaker_queued_bytes())) {
    /*
     * NOT FEEDING, SO NOT WATCHING.
     *
     * The watch means "we are handing the DAC audio right now". This branch
     * decides not to, while the clock builds its prefill — and leaving the
     * watch armed across it made the DAC's correct silence read as
     * starvation at every boundary that re-primes: a cold first turn, a turn
     * after idle, the refill after a barge-in, and teardown. That was the
     * whole of the systematic DMA ledger deficits, and it is one missing disarm
     * rather than four separate causes.
     */
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    ++runtime.speaker_waits_priming;
    /* Idle, not starving: nothing is playing, so write nothing. */
    if (runtime.last_write_ms != 0U &&
        iterate_kit_voice_elapsed_ms(now_ms(NULL), runtime.last_write_ms) > SPEAKER_IDLE_POWERDOWN_MS) {
      board_phase(ITERATE_KIT_VOICE_PHASE_QUIET);
    }
    DELAY_MS(5);
    return;
  }

  /*
   * WAIT AS LONG AS THE HARDWARE CUSHION ALLOWS.
   *
   * This was 20 ms — one frame — against a 90 ms I2S DMA ring, which made
   * this the least patient playout loop of any comparable firmware by a
   * factor of two to infinity (ESPHome waits half its DMA depth; esp-adf
   * waits 225 ms against 58.5 ms; xiaozhi-esp32 blocks indefinitely).
   *
   * The impatience was invisible because of where it is measured. By the
   * time this call is reached, the preceding esp_codec_dev_write has
   * returned — and it returns only once i2s_channel_write has copied into
   * the DMA descriptors, back-pressured by the driver's free-buffer queue.
   * So at the instant this loop declares itself "dry", roughly 60 ms of
   * real audio is still queued and the DAC is in no danger at all. Waiting
   * is free; splicing silence is not, because silence written into the ring
   * occupies playout time and can never be taken back.
   *
   * Two thirds of the cushion, so a late frame is absorbed rather than
   * concealed, while the remaining third still bounds how long this task
   * can sit before the ring genuinely empties.
   */
  /*
   * ARMED ACROSS THE WAIT UNLESS THE ANSWER IS OVER.
   *
   * The window that matters is between one frame and the next: the ring holds
   * 90ms, this receive blocks for up to 60ms, and if the source fails to
   * deliver inside that the DAC really does run dry and the listener really
   * does hear it. So the watch stays ARMED across the wait — disarming here
   * unconditionally (which I tried) makes every inter-feed gap invisible and
   * buys a clean run by blinding the detector.
   *
   * The one case where a dry ring is legitimate is an answer that is OVER:
   * the sender said `response.done` and the tail is draining. That is exactly
   * `answer_declared_done`, latched until the drain completes, so it is the
   * only condition that disarms.
   *
   * Arming happens at the write. Between a write and the next one the watch is
   * on; past a declared end it is off; during priming, a reprime flush or a
   * fully skipped frame it is off because we are deliberately not feeding.
   */
  if (atomic_load_explicit(
          &runtime.answer_declared_done, memory_order_acquire)) {
    board_phase(ITERATE_KIT_VOICE_PHASE_DRAINING);
  }
  received = xQueueReceive(
                 runtime.speaker_queue,
                 &frame,
                 pdMS_TO_TICKS(runtime.facts->speaker_dry_wait_ms)) ==
                     pdTRUE
      ? FRAME_BYTES
      : 0U;

  /*
   * A REPRIME REQUESTED WHILE WE WERE BLOCKED STILL COUNTS.
   *
   * The receive above waits up to 60 ms, and a new answer's first frame
   * routinely arrives inside that window — REPLACE sets speaker_reprime and
   * pushes the frame, and this loop then wakes holding it. Checking the
   * flag only at the top of the loop played that frame with priming already
   * cancelled, so ~20 ms of the first phoneme escaped, the reprime was
   * honoured on the NEXT iteration, and the rest of the answer waited out a
   * full prefill behind it. That is the clipped first word.
   */
  if (received > 0U && playback_apply_reprime(&runtime.playout_clock)) {
    /*
     * A replacement can wake the blocked receive with its first frame. Put
     * that whole tagged frame back at the head so opening prefill includes
     * it. If another replacement raced this one, its generation is already
     * stale and it must not be reintroduced after the newer queue reset.
     */
    if (frame.generation == atomic_load_explicit(
                                &runtime.speaker_generation,
                                memory_order_acquire)) {
      if (xQueueSendToFront(runtime.speaker_queue, &frame, 0) != pdTRUE) {
        (void)atomic_fetch_add_explicit(
            &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
      }
    } else {
      (void)atomic_fetch_add_explicit(
          &runtime.speaker_discarded_frames, 1U, memory_order_relaxed);
    }
    return;
  }

  if (received == 0U) {
    /*
     * DRY. WRITE NOTHING AND COME BACK.
     *
     * This used to splice a frame of silence into the DMA ring, on the
     * theory that a ring kept topped up cannot starve the DAC. That has it
     * backwards. Silence written into the ring is indistinguishable from
     * audio: it occupies playout time, can never be taken back, and so
     * PERMANENTLY puts the rest of the answer 20 ms further behind. Do it
     * 149 times in one answer — measured — and the listener hears three
     * seconds of chopping, while every frame that ever arrived is still
     * faithfully played, just late and in pieces.
     *
     * Not writing costs nothing, because the ring is not empty when this
     * branch is reached: the preceding write returned only once the driver
     * had copied into the DMA descriptors, so tens of milliseconds of real
     * audio are still queued and the DAC is in no danger. And an actually
     * empty ring already clocks out clean zeros — auto_clear is set — so
     * concealment was never buying the silence it claimed to provide.
     *
     * This is what xiaozhi-esp32, ESPHome's speaker and esp-adf all do:
     * when the source is dry, stop calling write. None of them conceals.
     */
    /* Nothing to play: the zeros the DAC now sends are correct. */
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    /*
     * "The answer has finished being HEARD" was reported to the classifier
     * here, gated on the sender having declared it complete — the classifier
     * needed it to tell a new answer following a finished one from a new
     * answer cutting a live one off. That distinction is now measured where
     * the audio is actually thrown away: an abandon with bytes still queued
     * is a supersede, an abandon with an empty queue is the gap between
     * turns. `answer_declared_done` still disarms the starvation watch above,
     * which is the other thing it was ever for.
     */
    ++runtime.speaker_waits_dry;
    if (iterate_kit_voice_playback_clock_empty(
            &runtime.playout_clock, now_ms(NULL)) ==
        ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) {
      /* Kept as telemetry: how often the source could not keep up. It no
       * longer costs the listener anything. */
      ++runtime.speaker_conceal_frames;
      atomic_store_explicit(
          &runtime.starve_at_ms, now_ms(NULL), memory_order_release);
    } else {
      /*
       * SETTLED BACK TO PRIMING, WHICH IS THIS DEVICE'S OWN PROOF THAT NO
       * ANSWER IS IN FLIGHT — and therefore that nothing is late.
       *
       * WAIT is returned by exactly one branch of the clock: the answer was
       * declared over, or nothing has been written for longer than the conceal
       * limit. Either way the ring is empty and playback is AT THE LIVE EDGE,
       * so whatever lag the last answer ended on is unrecoverable by
       * definition — the catch-up rule already refuses to skip into an empty
       * ring for that exact reason. Carrying the number forward does not
       * measure anything; it only waits to be charged against the next answer.
       *
       * This is the reset that needs no cooperation from the sender. `drop`
       * covers the answer that replaces a LIVE one; this covers every ordinary
       * turn, including the ones where `drop` arrives a few chunks late —
       * measured on the StackChan, where 800 ms of a new answer was delivered
       * ahead of the clear that was supposed to precede it.
       */
      atomic_store_explicit(
          &runtime.answer_started_ms, 0U, memory_order_release);
      atomic_store_explicit(
          &runtime.answer_emitted_ms, 0U, memory_order_release);
    }
    return;
  }

  if (frame.generation != atomic_load_explicit(
                              &runtime.speaker_generation,
                              memory_order_acquire)) {
    /* A replacement raced this frame after it left the synchronized queue. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_discarded_frames, 1U, memory_order_relaxed);
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    return;
  }

  /*
   * Flooded: skip this frame to catch up.
   *
   * The bridge paces off its own wall clock and the device consumes off
   * the I2S clock; the two are independent, so a small rate difference
   * accumulates without bound. Left alone the buffer fills and frames are
   * discarded ON ARRIVAL — which punches a hole in the middle of speech.
   * Dropping one 20ms frame here instead, only when there is most of a
   * second of backlog, is the same total loss placed where it is least
   * audible, and it bounds playout latency as a side effect.
   *
   * This is the symmetric counterpart to concealment: conceal when
   * starved, skip when flooded, and count both honestly.
   */
  {
    const enum iterate_kit_voice_playback_action action =
        iterate_kit_voice_playback_clock_frame(
            &runtime.playout_clock,
            speaker_queued_bytes(),
            iterate_kit_voice_playout_lag_ms(
                atomic_load_explicit(
                    &runtime.answer_started_ms, memory_order_acquire),
                atomic_load_explicit(
                    &runtime.answer_emitted_ms, memory_order_acquire),
                now_ms(NULL)),
            now_ms(NULL));
    if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP) {
      /*
       * A SKIPPED FRAME STILL SPENT ITS PLACE IN THE TIMELINE.
       *
       * Skipping recovers lag only if the timeline advances as the frame is
       * discarded. Leave the counter alone and the computed lag never
       * falls, so the loop keeps deciding it is late and skips again — it
       * drains the whole backlog and the listener hears half the answer
       * missing. Measured exactly that: 78 of 162 frames skipped.
       *
       * Advancing here is what makes "skip until level" terminate at the
       * point it is level, which is the entire safety of the mechanism.
       */
      ++runtime.speaker_catchup_frames;
      (void)atomic_fetch_add_explicit(
          &runtime.answer_emitted_ms,
          (uint32_t)(received / (FRAME_BYTES / FRAME_MS)),
          memory_order_acq_rel);
      return;
    }
  }

  const uint64_t write_started_ms = now_ms(NULL);
  board_phase(ITERATE_KIT_VOICE_PHASE_FEEDING);
  /*
   * Admission is nonblocking. The hardware-owner task reserves the DMA
   * ledger immediately before its blocking write; this task waits at most
   * five frame periods for bounded queue headroom and keeps running the
   * stream protocol independently of the codec driver's pacing.
   */
  enum iterate_kit_status write_status;
  const uint64_t write_deadline_ms = now_ms(NULL) + 100U;
  do {
    if (atomic_load_explicit(
            &runtime.speaker_reprime, memory_order_acquire) ||
        frame.generation != atomic_load_explicit(
                                &runtime.speaker_generation,
                                memory_order_acquire)) {
      /* A replacement answer arrived while this stale frame waited. */
      write_status = ITERATE_KIT_UNAVAILABLE;
      break;
    }
    write_status = iterate_kit_audio_codec_write(
        &runtime.codec, frame.samples, received / 2U);
    if (write_status == ITERATE_KIT_BACKPRESSURE) {
      DELAY_MS(1);
    }
  } while (write_status == ITERATE_KIT_BACKPRESSURE &&
           now_ms(NULL) < write_deadline_ms);

  if (write_status == ITERATE_KIT_OK) {
    ++runtime.speaker_frames_played;
    /*
     * The mouth, from audio the DAC has accepted rather than audio that
     * arrived. This is the only place on the device where those two are the
     * same thing, which is why the tap is here and not on the receive path:
     * see waveshare_avatar.h for what the delay line does with it.
     */
    board_playout(frame.samples, received / 2U);
    /*
     * HOW FAR BEHIND REALTIME THIS ANSWER HAS FALLEN.
     *
     * Frame N of an answer belongs 20N ms after the first one played. The
     * gap between that and the wall clock is lag, and it only grows when
     * playback stalls — never from the sender running ahead, which is why
     * this is measured against the audio timeline rather than queue depth.
     *
     * Recorded rather than acted on. Paying it back means deleting speech,
     * and this device has already shipped one mechanism that did exactly
     * that; the number has to exist before anyone can argue about whether
     * being late is worse than being clipped.
     */
    {
      /*
       * STAMPED BEFORE THE WRITE, NOT AFTER.
       *
       * codec admission may wait for bounded queue headroom. Stamping after
       * that wait folds hardware pacing into the measurement,
       * so a perfectly punctual loop reports itself progressively later and
       * the catch-up rule then deletes speech to fix a delay that only
       * existed in the metric. Measured that way: 1089 ms of "lag" while
       * the ring held 1620 ms of audio, which is the signature of a
       * consumer that is keeping up.
       */
      const uint64_t played_at = write_started_ms;
      uint64_t answer_started = atomic_load_explicit(
          &runtime.answer_started_ms, memory_order_acquire);
      if (answer_started == 0U) {
        atomic_store_explicit(
            &runtime.answer_started_ms, played_at, memory_order_release);
        atomic_store_explicit(
            &runtime.answer_emitted_ms, 0U, memory_order_release);
        answer_started = played_at;
      }
      {
        const uint32_t lag = iterate_kit_voice_playout_lag_ms(
            answer_started,
            atomic_load_explicit(
                &runtime.answer_emitted_ms, memory_order_acquire),
            played_at);
        if (lag > runtime.speaker_lag_max_ms) {
          runtime.speaker_lag_max_ms = lag;
        }
      }
      /* Milliseconds actually emitted, so a short read advances the
       * timeline by what it played and not by a whole frame. */
      (void)atomic_fetch_add_explicit(
          &runtime.answer_emitted_ms,
          (uint32_t)(received / (FRAME_BYTES / FRAME_MS)),
          memory_order_acq_rel);
    }
  } else if (write_status == ITERATE_KIT_UNAVAILABLE &&
             atomic_load_explicit(
                 &runtime.speaker_reprime, memory_order_acquire)) {
    /* Intentional replacement, not a codec failure. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_discarded_frames,
        (uint32_t)(received / (FRAME_SAMPLES * sizeof(int16_t))),
        memory_order_relaxed);
  } else {
    /* The bounded hardware path did not admit this frame. */
    ++runtime.speaker_write_failures;
  }

  {
    const uint32_t margin_ms = speaker_queued_bytes() / 32U;
    ++runtime.speaker_writes;
    if (runtime.speaker_writes == 1U ||
        margin_ms < runtime.speaker_margin_min_ms) {
      runtime.speaker_margin_min_ms = margin_ms;
    }
    if (margin_ms > runtime.speaker_margin_max_ms) {
      runtime.speaker_margin_max_ms = margin_ms;
    }
  }
  runtime.last_write_ms = now_ms(NULL);
  atomic_store_explicit(
    &runtime.speaker_last_write_ms, runtime.last_write_ms,
    memory_order_release);
}

/* --- microphone path ------------------------------------------------------ */

/*
 * ONE CAPTURE PATH, THROUGH THE BRIDGE, ON EVERY BOARD.
 *
 * Three of the four boards read a whole 20 ms wire frame, hand it to a
 * passthrough and queue it. The fourth reads 8 ms DMA chunks, runs esp-sr's
 * VOIP engine over 16 ms frames and owes the wire 20 ms — three cadences that
 * no amount of whole-frame FIFO can reconcile without a beat pattern. The
 * bridge is that reconciliation, and it is already board-generic: separate
 * `processing_frame_samples` and `egress_frame_samples`, one owner, no task,
 * lock, allocation or hidden capacity.
 *
 * At 320 in / 320 processed / 320 out it degenerates to an exact pass-through
 * — four memcpys and the same `iterate_kit_audio_processor_process` call the
 * direct path made — with ONE real semantic change, which is the reason this
 * is a commit of its own:
 *
 *   A FAILED PROCESS NOW EMITS 320 SAMPLES OF SILENCE INSTEAD OF DROPPING THE
 *   FRAME. The direct path returned early and sent nothing, so the wire
 *   timeline skipped 20 ms; the bridge fails closed by writing a complete
 *   silent frame, which keeps the timeline deterministic and can never
 *   substitute raw microphone. Unreachable under a passthrough processor,
 *   which cannot fail once its near and output planes are non-NULL — so on
 *   three boards this is a contract change with no reachable behaviour behind
 *   it, and on the fourth it is what its own AEC already did.
 *
 * A fixed-size frame is the less surprising contract: every consumer
 * downstream of here assumes 20 ms, and a silently missing frame is the kind
 * of hole that gets diagnosed as a network fault.
 */
static enum iterate_kit_status bridge_process(
    void *context,
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *playout_samples,
    int16_t *clean_samples,
    size_t sample_count) {
  const struct iterate_kit_audio_processor_frame frame = {
    .near = near_samples,
    .reference = reference_samples,
    .playout_activity = playout_samples,
    .output = clean_samples,
    .sample_count = sample_count,
  };
  (void)context;
  return iterate_kit_audio_processor_process(&runtime.processor, &frame);
}

static enum iterate_kit_status bridge_reset_processor(void *context) {
  (void)context;
  return iterate_kit_audio_processor_reset(&runtime.processor);
}

/*
 * ONE COMPLETE WIRE FRAME, and everything that is true once per wire frame.
 *
 * The peak and the barge-in observation live here rather than beside the
 * codec read because THIS is the 20 ms frame: on the board whose DSP works in
 * 16 ms there is no other place where a wire frame exists, and on the three
 * where the two coincide it is the identical buffer the direct path measured.
 */
static enum iterate_kit_status bridge_copy_egress(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us) {
  (void)context;
  (void)sample_rate_hz;
  (void)captured_through_at_us;
  if (sample_count != FRAME_SAMPLES) {
    ++runtime.mic_process_failures;
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  ++runtime.mic_frames_captured;
  /*
   * HOW LOUD THE ROOM IS, ONCE PER FRAME.
   *
   * Measured on the PROCESSED plane and BEFORE the `talking` gate, which is
   * what the board this came from did: the peak has to keep moving while the
   * device is idle, because that is when a person is checking whether it hears
   * them at all, and it has to be the CANCELLED plane so that `micPeak` reports
   * what the far end will be sent rather than what the room shouted at a
   * canceller.
   */
  {
    int32_t peak = 0;
    for (size_t index = 0U; index < FRAME_SAMPLES; ++index) {
      const int32_t sample = samples[index];
      const int32_t magnitude = sample < 0 ? -sample : sample;
      if (magnitude > peak) peak = magnitude;
    }
    atomic_store_explicit(
        &runtime.mic_peak, (unsigned int)peak, memory_order_relaxed);
    if ((unsigned int)peak >
        atomic_load_explicit(&runtime.mic_peak_max, memory_order_relaxed)) {
      atomic_store_explicit(
          &runtime.mic_peak_max, (unsigned int)peak, memory_order_relaxed);
    }
  }
  /*
   * NOBODY IS LISTENING, SO DO NOT QUEUE.
   *
   * Capture runs continuously — the codec is full duplex and stopping it
   * between turns costs a settle on every press, and an adaptive canceller
   * must keep seeing far-end-only audio — but frames only LEAVE the queue
   * while a turn is open. Queueing regardless filled it within a second of
   * boot and then churned it forever: 7941 of 8804 frames "dropped" in one
   * session, none of which was speech anybody said.
   *
   * The number mattered more than the wasted work. A drop counter at 90% is
   * indistinguishable from a device losing the customer's words, so the one
   * measurement that would show a real uplink fault was buried in room noise
   * nobody wanted.
   */
  if (!runtime.talking && !runtime.dial_buffering) {
    ++runtime.mic_frames_idle;
    return ITERATE_KIT_OK;
  }
  /*
   * Sent straight from the bridge's egress frame: `struct mic_frame` is
   * exactly FRAME_SAMPLES of PCM16 and xQueueSend copies, so a staging frame
   * here would be one memcpy and 640 bytes of .bss to say the same thing.
   */
  if (xQueueSend(runtime.mic_queue, samples, 0) != pdTRUE) {
    /*
     * FULL, and which end to sacrifice depends on what the queue is doing.
     *
     * DIALLING: keep the OLDEST. The queue is the dial buffer, nothing
     * leaves it until the call is accepted, and the start of what somebody
     * said is what makes the rest of it intelligible — the same rule the
     * far end applies to its own held-frame cap. Latest-wins here was
     * measured on a real press: a 7.5 s cold dial against 5.12 s of queue
     * evicted the person's whole opening sentence and delivered the room
     * noise that followed it (/agents/voice/stackchan, conversation-accepted
     * handshakeTookMs 7489, 2026-08-20).
     *
     * IN A CALL: freshest wins — discard the OLDEST frame, keep this one.
     * Stale speech after a network hiccup is worse than a gap, and it is
     * the only way a backlog can never delay what the customer says next.
     */
    if (runtime.dial_buffering) {
      ++runtime.mic_frames_dropped;
      return ITERATE_KIT_OK;
    }
    struct mic_frame discarded;
    (void)xQueueReceive(runtime.mic_queue, &discarded, 0);
    (void)xQueueSend(runtime.mic_queue, samples, 0);
    ++runtime.mic_frames_dropped;
  }
  return ITERATE_KIT_OK;
}

/** One pass of the microphone. See the note on the playback step. */
void iterate_kit_voice_loop_capture_step(void) {
  /*
   * The codec's own grain, whatever it is. Sized for the largest a board
   * declares; `facts->capture_chunk_samples` is how many of it are asked for.
   */
  static int16_t near_chunk[FRAME_SAMPLES];
  static int16_t reference_chunk[FRAME_SAMPLES];
  static int16_t activity_chunk[FRAME_SAMPLES];
  struct iterate_kit_voice_capture_meta meta;
  size_t sample_count = 0U;
  const size_t chunk_samples = runtime.facts->capture_chunk_samples;
  /*
   * A reference plane exactly when the codec advertises one — the seam's own
   * rule. Where there is none the plane stays the zeroed static it started
   * as, which is the honest reading: this board reports no loudspeaker
   * feedback, rather than a fabricated one.
   */
  const enum iterate_kit_status read_status = iterate_kit_audio_codec_read(
      &runtime.codec,
      near_chunk,
      runtime.codec.properties->has_reference_channel ? reference_chunk : NULL,
      chunk_samples,
      &sample_count);
  if (read_status == ITERATE_KIT_UNAVAILABLE) {
    DELAY_MS(1);
    return;
  }
  if (read_status != ITERATE_KIT_OK || sample_count != chunk_samples) {
    ++runtime.mic_process_failures;
    DELAY_MS(1);
    return;
  }
  memset(&meta, 0, sizeof(meta));
  if (runtime.board->capture_meta != NULL) {
    runtime.board->capture_meta(runtime.board_context, &meta);
  } else {
    /*
     * A board that cannot say gets a synthesised timeline, which is exactly
     * what the three boards with no bridge did implicitly. Monotonic by
     * construction, so the bridge's discontinuity and regression detectors
     * cannot fire on them — and if they ever did it would be a real defect.
     */
    meta.sequence = ++runtime.capture_sequence;
    meta.captured_through_at_us = (uint64_t)esp_timer_get_time();
  }
  /*
   * A BROKEN CAPTURE TIMELINE RESTARTS THE FILTER ON CURRENT AUDIO. Asked
   * after the read rather than before it, which is one chunk FRESHER than the
   * board that donated this: a reset latched while the read was in flight is
   * honoured for the chunk it actually invalidated instead of the next one.
   */
  if (meta.epoch_reset &&
      iterate_kit_aec_capture_bridge_reset(&runtime.capture_bridge) !=
          ITERATE_KIT_OK) {
    ++runtime.mic_process_failures;
  }
  {
    /*
     * The far-active plane is a POLICY signal the codec samples, never the
     * analogue reference: noise must not select an uplink branch. Refilled
     * only when it changes, because it is constant for whole answers and
     * constantly zero on a board that cannot report it.
     */
    static int16_t activity_level;
    const int16_t level = meta.playback_content_active ? 1 : 0;
    if (level != activity_level) {
      activity_level = level;
      for (size_t index = 0U; index < FRAME_SAMPLES; ++index) {
        activity_chunk[index] = level;
      }
    }
  }
  if (iterate_kit_aec_capture_bridge_push_aligned(
          &runtime.capture_bridge,
          meta.sequence,
          meta.captured_through_at_us,
          near_chunk,
          reference_chunk,
          activity_chunk,
          chunk_samples) != ITERATE_KIT_OK) {
    ++runtime.mic_process_failures;
  }
  {
    const struct iterate_kit_aec_capture_bridge_metrics *bridge =
        iterate_kit_aec_capture_bridge_metrics(&runtime.capture_bridge);
    if (bridge != NULL) {
      atomic_store_explicit(
          &runtime.aec_bridge_failures,
          bridge->processor_failures,
          memory_order_relaxed);
      atomic_store_explicit(
          &runtime.aec_bridge_reset_failures,
          bridge->processor_reset_failures,
          memory_order_relaxed);
      atomic_store_explicit(
          &runtime.aec_sequence_discontinuities,
          bridge->sequence_discontinuities,
          memory_order_relaxed);
      atomic_store_explicit(
          &runtime.aec_clock_regressions,
          bridge->timestamp_regressions,
          memory_order_relaxed);
      atomic_store_explicit(
          &runtime.aec_egress_copy_failures,
          bridge->egress_copy_failures,
          memory_order_relaxed);
    }
  }
}

static void playback_task(void *argument) {
  (void)argument;
  for (;;) iterate_kit_voice_loop_playback_step();
}

static void capture_task(void *argument) {
  (void)argument;
  for (;;) iterate_kit_voice_loop_capture_step();
}

/* --- boot wiring ----------------------------------------------------------- */

static bool initialise_rings(void) {
  return iterate_kit_spsc_ring_init(
             &runtime.control_inbox,
             inbox_storage_psram,
             CONTROL_INBOX_SLOT_CAPACITY,
             CONTROL_INBOX_SLOTS,
             runtime.inbox_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &runtime.control_outbox,
             outbox_storage_psram,
             CONTROL_OUTBOX_SLOT_CAPACITY,
             CONTROL_OUTBOX_SLOTS,
             runtime.outbox_lengths) == ITERATE_KIT_OK;
}

/*
 * One intent path for both sources, exactly as the app loop already assumes:
 * an RPC lands on the same two display-owned flags a physical button sets, so
 * remote and local control cannot disagree about what the device is doing.
 */
static enum iterate_kit_status handle_device_event(
    void *context, const struct iterate_kit_device_event *event) {
  (void)context;
  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
      /*
       * A PRESS OPENS THE CALL. ONE VERB, NOT TWO.
       *
       * This set the talk latch and nothing else, and the turn machine below
       * reads that latch only inside `wants_call` — so a press with no call up
       * was latched and then never consulted. Driving a button board with
       * `pushToTalk.start()` alone looked completely dead, the reply said the
       * event had been accepted (it had), and an afternoon went into bisecting
       * hardware that was working. The caller had to know to call
       * `conversation.start()` first, and nothing anywhere said so.
       *
       * The stream protocol already decided this the right way round:
       * `ptt-start` opens a call if none is up and the SERVER resolves it. A
       * device press is the same request, so it makes the same claim here —
       * and it is ONE assignment rather than a wrapper that calls two verbs,
       * because two verbs is the thing that was wrong.
       *
       * `conversation.start()` still exists and still means something: an
       * open-mic board has no press at all, and on a button board it is how you
       * open a call to be greeted without holding the microphone open.
       *
       * Only STARTED. Releasing talk commits the turn; it does not hang up, for
       * the same reason `ptt-end` does not.
       */
      runtime.remote_talk = (true);
      runtime.view.wants_call = (true);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      runtime.remote_talk = (false);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
      runtime.view.wants_call = (true);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      runtime.view.wants_call = (false);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      break;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

/* Defined beside health_json, which it adapts. */
static size_t render_health(void *context, char *out, size_t capacity);

/*
 * `talk_would_be_honoured` WAS HERE, and it answered the reply's `latched`
 * field: would a talk request arriving right now actually open the microphone?
 * On a board where a press did not open the call, the honest answer was often
 * "no", and reporting it was the best that could be done about an ordering
 * every caller had to know.
 *
 * The gate it reported is gone — a press opens the call — so the predicate can
 * only answer "yes" and the field it fed can only say `true`. Both went.
 */

static bool initialise_connection(void) {
  /*
   * Five shared (push-to-talk, conversation control, speaker, health,
   * system.update) plus whatever the board has of its own: an AEC stage,
   * servos, a camera, a screen to fill. The busiest board mounts eight.
   */
  static struct iterate_kit_module modules[12];
  static struct iterate_kit_speaker speaker;
  static struct iterate_kit_health health;
  static struct iterate_kit_system_update system_update;
  size_t module_count = 0U;
  struct iterate_kit_itx_connection_options options;
  struct iterate_kit_esp_idf_itx_transport_options transport_options;
  struct iterate_kit_peer_options peer_options;

  {
    const struct iterate_kit_device_event_queue_options event_options = {
      .storage = runtime.device_event_storage,
      .capacity = ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY,
      .handler = {.context = NULL, .handle = handle_device_event},
      .observer = {.context = NULL, .observe = NULL},
    };
    if (iterate_kit_device_event_queue_init(
            &runtime.device_events, &event_options) != ITERATE_KIT_OK ||
        iterate_kit_push_to_talk_init(
            &runtime.push_to_talk, &runtime.device_events) != ITERATE_KIT_OK ||
        iterate_kit_conversation_control_init(
            &runtime.conversation_control, &runtime.device_events) !=
            ITERATE_KIT_OK) {
      return false;
    }
    /*
     * MOUNTED ONLY WHERE IT MEANS SOMETHING. A board whose microphone is open
     * for the whole call has no push-to-talk to offer, and offering it anyway
     * gives an agent a method that would silently mute live audio. Two boards
     * already refused these events by hand in `handle_device_event`, one
     * returning "invalid" and one "state error"; not mounting the module says
     * the same thing once, before anybody can call it.
     */
    if (runtime.facts->turns == ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK) {
      modules[module_count++] =
          iterate_kit_push_to_talk_module(&runtime.push_to_talk);
    }
    modules[module_count++] =
        iterate_kit_conversation_control_module(&runtime.conversation_control);
  }
  /*
   * TURN IT UP. Every board here shipped at a volume somebody measured once
   * and nobody could change without a reflash, and all four were reported as
   * too quiet. The driver keeps its ceiling; the knob is now a call away.
   */
  {
    if (iterate_kit_speaker_init(&speaker, &runtime.facts->speaker) ==
        ITERATE_KIT_OK) {
      modules[module_count++] = iterate_kit_speaker_module(&speaker);
    }
  }
  /*
   * ASKABLE, and only askable. There was a copy of this document pushed onto
   * the stream every five seconds as dev-stats; it was deleted because a board
   * that talks on a timer keeps a Durable Object awake forever. The pull is
   * what is left, and it is the better half: the pushed copy only reached
   * whoever was already listening, and the other way to interrogate a quiet
   * board is its console, which on this hardware REBOOTS it.
   */
  {
    const struct iterate_kit_health_driver driver = {
      .context = NULL,
      .render = render_health,
    };
    if (iterate_kit_health_init(
            &health,
            &driver,
            runtime.stats_buffer,
            sizeof(runtime.stats_buffer)) == ITERATE_KIT_OK) {
      modules[module_count++] = iterate_kit_health_module(&health);
    }
  }
  /*
   * OTA as a capability: the server names a url and a digest, the device
   * fetches, verifies, and reboots into it. Until this, every deploy meant a
   * serial cable on somebody's desk.
   */
  {
    const struct iterate_kit_system_update_driver driver = {
      .context = NULL,
      .begin = iterate_kit_esp_idf_system_update_begin,
    };
    if (iterate_kit_system_update_init(&system_update, &driver) ==
        ITERATE_KIT_OK) {
      modules[module_count++] = iterate_kit_system_update_module(&system_update);
    }
  }
  /*
   * AND WHAT ONLY THIS BOARD HAS — which until now was nothing, on every
   * board.
   *
   * `board_ops.modules` is declared, documented, and implemented (HAVPE's
   * `aec.setStage`); it was never called. The array above was sized at twelve
   * for "four shared plus whatever the board has of its own" and then filled
   * with the four. So a board-local method failed at the call site as
   * "unknown device capability" — which reads like a misspelled path, not
   * like a capability that was never mounted, and cost an evening of looking
   * for the typo in a registration table that was correct.
   */
  if (runtime.board->modules != NULL) {
    module_count += runtime.board->modules(
        runtime.board_context,
        modules + module_count,
        (sizeof(modules) / sizeof(modules[0])) - module_count);
  }
  peer_options = (struct iterate_kit_peer_options){
    runtime.facts->peer_description,
    strlen(runtime.facts->peer_description),
    modules,
    module_count,
  };
  if (iterate_kit_peer_init(&runtime.peer, &peer_options) != CAPNWEB_OK) {
    return false;
  }

  memset(&options, 0, sizeof(options));
  options.pending_calls = runtime.pending_calls;
  options.pending_call_count = PENDING_CALL_CAPACITY;
  options.exports = runtime.exports;
  options.export_count = EXPORT_CAPACITY;
  options.imports = runtime.imports;
  options.import_count = IMPORT_CAPACITY;
  options.tokens = runtime.tokens;
  options.token_count = TOKEN_CAPACITY;
  options.outbound_buffer = runtime.output_buffer;
  options.outbound_buffer_size = OUTPUT_CAPACITY;
  options.send_text = iterate_kit_esp_idf_itx_transport_send_text;
  options.send_text_context = &transport;
  options.project_id = runtime.configuration.project_id;
  options.project_api_key = runtime.configuration.project_api_key;
  options.client_path = runtime.facts->client_path;
  options.capability = iterate_kit_peer_capability(&runtime.peer);
  /*
   * THE ONLY DESCRIPTION A MODEL EVER SEES.
   *
   * Not `facts->peer_description` — the capability host flattens this mount and
   * reports `children: {}` because sub-paths are routes the device interprets,
   * not members the host can list. So `peer_description` documents it for
   * people reading this file, and THIS string is what an agent discovers in
   * itx.__describe().capabilities. It was one 46-character line, which is why a
   * back-office agent asked for the device's metrics went looking through
   * telemetry streams instead of calling health(): nothing told it the call
   * existed.
   */
  options.description = runtime.facts->instructions;
  options.session_ended = on_session_ended;
  options.session_ended_context = NULL;
  if (iterate_kit_itx_connection_init(&runtime.connection, &options) !=
      CAPNWEB_OK) {
    return false;
  }

  memset(&transport_options, 0, sizeof(transport_options));
  transport_options.configuration = &runtime.configuration;
  transport_options.connection = &runtime.connection;
  transport_options.control_inbox = &runtime.control_inbox;
  transport_options.control_outbox = &runtime.control_outbox;
  return iterate_kit_esp_idf_itx_transport_prepare(
             &transport, &transport_options) == ITERATE_KIT_OK;
}

/*
 * HOW THIS DEVICE IS, AS ONE DOCUMENT, ANSWERED ONLY WHEN SOMEBODY ASKS.
 *
 * It used to be two things — this, and a copy pushed on a timer — and they
 * were never allowed to disagree. There is only the pull now, which is the
 * same document and none of the traffic.
 */
static size_t health_json(char *out, size_t capacity) {
  /*
   * PURE. This serializes local statistics and records nothing.
   *
   * It used to stamp "somebody asked us something" here, on the reasoning that
   * answering an RPC is the only proof the mount is still reachable — which is
   * true, and was defeated by the placement: the deleted `append_stats` called
   * this every five seconds to build the telemetry body, so the device renewed
   * its own liveness lease twelve times a minute by talking to itself. On
   * 2026-08-04 that left the pinned board unreachable for over seven minutes
   * with a 90s watchdog armed and a server holding zero connections.
   *
   * Reachability comes from `iterate_kit_peer_served_dispatches` — INBOUND
   * dispatches, which no amount of outbound telemetry can inflate. Keeping
   * this pure is what makes that true, and it outlived the push that broke it.
   */
  /*
   * NAME AND VALUE TRAVEL TOGETHER.
   *
   * This was one snprintf with sixty-odd "%" specifiers in a format string
   * and sixty-odd arguments below it, aligned by hand. They drifted, twice —
   * a counter was published under its neighbour's name, and because every
   * argument is a uint32_t the compiler could not see it: -Wformat checks
   * types, and a reorder among identically typed arguments is type-correct.
   *
   * The cost was not the wrong number. It was a whole investigation into 133
   * "liveness restarts" that never happened, and three hypotheses tested
   * against labels that were describing other counters. A misaligned metric
   * is worse than a missing one: a missing one asks a question, and a
   * misaligned one answers it wrongly.
   *
   * So a name is now written next to the value it names, and one loop emits
   * the pairs. Adding a counter is one line, and a line cannot be misaligned
   * with itself.
   */
  struct field {
    const char *name;
    uint32_t value;
  };
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  struct iterate_kit_spsc_ring_metrics outbox_metrics;
  const uint64_t now = now_ms(NULL);
  size_t used;
  size_t index;
  int written;

  struct iterate_kit_itx_connection_tables tables;
  iterate_kit_itx_connection_tables(&runtime.connection, &tables);
  iterate_kit_esp_idf_itx_transport_metrics(&transport, &metrics);
  iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox_metrics);

  /*
   * The gate every producer sits behind. Closed, the device answers RPCs and
   * does nothing else — which is exactly what a broken one looks like, so it
   * is reported rather than inferred.
   */
  const bool gate_open =
      (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY) &&
      transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
      runtime.voicelab_generation == runtime.connection.generation;

  const struct field fields[] = {
    {"connectionState", (uint32_t)runtime.connection.state},
    {"seq", runtime.stats_sequence++},
    {"framesSent", runtime.voicelab.frames_sent},
    {"frameFailures", runtime.voicelab.frame_send_failures},
    {"micCaptured", runtime.mic_frames_captured},
    {"micDropped", runtime.mic_frames_dropped},
    {"micProcessFailures", runtime.mic_process_failures},
    {"micIdle", runtime.mic_frames_idle},
    /*
     * THE CAPTURE BRIDGE'S OWN CENSUS: refused frames, and the two ways its
     * input can lie about being one continuous timeline. On a board where all
     * three cadences are 320 these can only move if something is genuinely
     * wrong — the timeline is synthesised from a monotonic counter and clock,
     * so a discontinuity or a regression there is a defect, not a chunk grain.
     */
    {"aecBridgeFailures",
     atomic_load_explicit(&runtime.aec_bridge_failures, memory_order_relaxed)},
    {"aecBridgeResetFailures",
     atomic_load_explicit(
         &runtime.aec_bridge_reset_failures, memory_order_relaxed)},
    {"aecSeqDiscontinuities",
     atomic_load_explicit(
         &runtime.aec_sequence_discontinuities, memory_order_relaxed)},
    {"aecClockRegressions",
     atomic_load_explicit(
         &runtime.aec_clock_regressions, memory_order_relaxed)},
    {"aecEgressCopyFailures",
     atomic_load_explicit(
         &runtime.aec_egress_copy_failures, memory_order_relaxed)},
    /*
     * WHETHER THIS DEVICE CAN HEAR ANYTHING AT ALL, and the loudest it ever
     * has. A deaf board and a quiet room are indistinguishable from every
     * other counter here — micCaptured climbs identically for both.
     */
    {"micPeak",
     atomic_load_explicit(&runtime.mic_peak, memory_order_relaxed)},
    {"micPeakMax",
     atomic_load_explicit(&runtime.mic_peak_max, memory_order_relaxed)},
    {"spkFrames", runtime.voicelab.spk_frames_received},
    {"spkPlayed", runtime.speaker_frames_played},
    {"spkOverflow",
     atomic_load_explicit(
         &runtime.speaker_overflow_drops, memory_order_relaxed)},
    /* Audio arriving just after a software-dry tick. Same signal, one step on. */
    {"spkSoftDryRefills", runtime.speaker_underruns},
    /* The task-side starvation measure: ms the ring was empty, and how often. */
    /*
     * SOFTWARE-BUFFER LATENESS, absorbed by the hardware ring — not an audible
     * gap, and named so nobody gates on it. The 90ms DMA ring sits between this
     * and the listener: on the turns that moved it, spkStarvedMs was 0 and every
     * frame received was played. spkStarvedMs is the audible-failure gate.
     */
    {"spkSoftDryTicks", runtime.speaker_conceal_frames},
    {"spkCatchup", runtime.speaker_catchup_frames},
    {"spkWriteFailures", runtime.speaker_write_failures},
    {"spkMarginMaxMs", runtime.speaker_margin_max_ms},
    {"spkLagMaxMs", runtime.speaker_lag_max_ms},
    {"spkMarginMinMs", runtime.speaker_margin_min_ms},
    {"spkWrites", runtime.speaker_writes},
    {"spkBadFrames", runtime.speaker_bad_frames},
    /*
     * A CHUNK THE DEVICE COULD NOT DECODE, which is now the only way audio
     * can fail to reach the speaker before it is queued.
     *
     * The old classifier's `spkIgnoredCall`/`spkIgnoredStale`/`spkIgnoredDup`
     * are gone with the classifier: the sender paces the answer and no frame
     * carries a call or an answer any more, so there is nothing for the
     * device to refuse. Numbering, though, RETURNED with
     * `deviceSpeakerFrameSeq` — the flush that names a sequence number needs
     * one — and the stream layer counts its holes. Published here because a
     * lost-chunk question asked over RPC had no witness: a whole evening's
     * barge diagnosis (2026-08-20) stalled on exactly that.
     */
    {"spkDecodeFailures", runtime.voicelab.spk_decode_failures},
    {"spkSeqGaps", runtime.voicelab.spk_seq_gaps},
    {"spkSeqMissing", runtime.voicelab.spk_seq_missing},
    {"spkSeqRegressions", runtime.voicelab.spk_seq_regressions},
    {"spkDiscarded",
     atomic_load_explicit(
         &runtime.speaker_discarded_frames, memory_order_relaxed)},
    /*
     * NORMAL TRANSITIONS, named so nobody tiers them as faults again. Both move
     * once per answer on a perfect turn: every answer begins by clearing what
     * the last one left, and every answer ends by the source going dry.
     */
    {"spkAnswerStarts", runtime.answers_started},
    /* The subset that cost the listener audio: superseded while still playing. */
    {"spkSupersededMidplay", runtime.answers_superseded_midplay},
    /* Drops obeyed, and the board uptime at the last one. Compare against
     * `uptimeMs` in this same payload to get how long ago it happened, on
     * a clock that owes nothing to the event lane. */
    {"spkDrops", runtime.speaker_drops},
    {"spkLastDropUptimeMs", runtime.last_drop_uptime_ms},
    {"spkWaitPriming", runtime.speaker_waits_priming},
    {"spkAnswerDrains", runtime.speaker_waits_dry},
    /*
     * THE FACE LANE, AND WHICH HALF OF IT IS DARK.
     *
     * Two numbers because they fail apart: `facePolls` standing still means
     * the gate never opened (no audio, or no mouth on this board), and
     * `facePolls` climbing while `faceUpdates` does not means the processor is
     * being asked and has no face to report. A frozen mouth was diagnosed from
     * source once because there was no counter to look at.
     */
    {"facePolls", runtime.voicelab.face_polls},
    {"faceUpdates", runtime.voicelab.face_updates},
    {"turnMarkerFailures", runtime.turn_marker_failures},
    /*
     * THE FACE, AND THE ONE NUMBER THAT SAYS IT IS ALIVE.
     *
     * `faceFrames` counts completed analysis windows — 100 a second while audio
     * plays. A mouth that has stopped moving is either this number standing
     * still or the audio never arriving, and nothing on the screen tells those
     * apart. The frozen-pose bug was diagnosed from source because there was no
     * counter to look at; there is one now.
     */
    {"batches", runtime.voicelab.batches_on_connection},
    {"connGeneration", runtime.voicelab.connection_generation},
    /* Hop liveness only — never application delivery credit. */
    {"wsPongs", metrics.websocket_pongs_received},
    /* Inbound capability dispatches served — the reachability proof. */
    {"servedDispatches", iterate_kit_peer_served_dispatches(&runtime.peer)},
    {"bridgeAgeMs",
     runtime.voicelab.last_bridge_ms == 0U
         ? 0U
         : (uint32_t)iterate_kit_voice_elapsed_ms(
               now, runtime.voicelab.last_bridge_ms)},
    {"downlinkRecycles", runtime.downlink_recycles},
    /*
     * THE PRESS PROBE, AS AN INSTRUMENT RATHER THAN A BELIEF.
     *
     * `pressProbeMs` is the last PONG round trip measured after a press, and it
     * is the only evidence anybody has for what that costs on this hardware —
     * the 1500 ms budget it is checked against was a guess. `pressProbeMisses`
     * counts probes no PONG answered (a lossy access point moves this without
     * anything being wrong); `pressProbeRestarts` counts sockets replaced
     * because two in a row went unanswered, and that one should stay at zero
     * unless a socket really did die.
     */
    {"pressProbes", runtime.press_probes},
    {"pressProbeMs", runtime.press_probe_ms},
    {"pressProbeMisses", runtime.press_probe_misses},
    {"pressProbeRestarts", runtime.press_probe_restarts},
    {"batchAgeMs",
     runtime.voicelab.last_batch_ms == 0U
         ? 0U
         : (uint32_t)iterate_kit_voice_elapsed_ms(
               now, runtime.voicelab.last_batch_ms)},
    /*
     * THE THREE FIXED TABLES. Sized at boot and never grown; when one fills,
     * the next call fails with a status that names no table and the device
     * latches. Published as used/capacity pairs so "nearly full" is visible
     * before "full" makes the board look broken.
     */
    {"rpcExports", tables.exports_used},
    {"rpcExportsMax", tables.exports_capacity},
    {"rpcImports", tables.imports_used},
    {"rpcImportsMax", tables.imports_capacity},
    {"rpcCalls", tables.calls_used},
    {"rpcCallsMax", tables.calls_capacity},
    /* Which step of preparing a conversation failed last — the reason that
     * used to exist only on a console whose opening reboots the board. */
    {"heapFree", (uint32_t)esp_get_free_heap_size()},
    /*
     * INTERNAL, NOT TOTAL. `heapFree` counts PSRAM, and on a board with eight
     * megabytes of it a number near six million looks like abundance while the
     * internal heap — the only kind TLS, Wi-Fi and DMA can use — is down to
     * scraps. That is not a hypothetical: a StackChan reading heapFree
     * 5,800,196 dropped its socket mid-sentence with "esp-aes: Failed to
     * allocate memory", and nothing in this document could say why.
     */
    {"internalFree",
     (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL)},
    {"internalMin",
     (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL)},
    {"internalLargest",
     (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)},
    {"heapMin", (uint32_t)esp_get_minimum_free_heap_size()},
    /* Image buffers are PSRAM, so a leak there is invisible in heapFree. */
    {"psramFree", (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM)},
    {"dmaLargest", (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_DMA)},
    {"wsSent", metrics.control_messages_sent},
    {"outboxDiscarded", metrics.control_outbox_discarded},
    {"outboxUsed", (uint32_t)outbox_metrics.current_slots},
    {"outboxSlots", (uint32_t)CONTROL_OUTBOX_SLOTS},
    {"inboxPublished", metrics.control_inbox.messages_published},
    {"inboxConsumed", metrics.control_inbox.messages_consumed},
    {"inboxDiscarded", metrics.control_inbox_discarded},
    {"inboxHighWater", metrics.control_inbox.high_water_slots},
    {"inboxDeferrals", metrics.control_inbox_deferrals},
    {"sessionGeneration", runtime.connection.generation},
    {"protoFailures", metrics.protocol_failures},
    {"recvFailures", metrics.control_receive_failures},
    {"sendFailures", metrics.control_send_failures},
    {"lastAppStatus", (uint32_t)metrics.last_application_capnweb_status},
  };

  /*
   * What the clock says, in exactly the form a new conversation would be named.
   *
   * Empty until the time server answers, which is the useful distinction: a
   * device with no clock names conversations from the RNG, and this is the only
   * way to tell that from outside. A READ, so health_json stays pure — see the
   * comment on this function about what recording anything here once cost.
   */
  char clock[20];
  if (!clock_slug(clock, sizeof(clock))) clock[0] = '\0';

  /* The strings and the one 64-bit field, which do not fit the pair table. */
  written = snprintf(
      out,
      capacity,
      "{\"transport\":\"%s\",\"voicelab\":\"%s\",\"voicelabFailure\":\"%s\","
      /*
       * WHICH CONVERSATION. Every call gets its own stream and the path is
       * chosen ON THE DEVICE, so without this the only way to find the
       * transcript of the call you are looking at is to guess a UTC second.
       */
      "\"conversation\":\"%s\","
      "\"clock\":\"%s\","
      /* WHY IT LAST RESTARTED. Uptime says one happened; only this
       * says whether it was a panic, a stall or somebody's thumb. */
      "\"resetReason\":\"%s\",\"restartNote\":\"%s\","
      "\"connection\":\"%s\","
      "\"callActive\":%s,\"callPending\":%s,\"wantsCall\":%s,\"talking\":%s,"
      /*
       * WHY A PRESS DID NOT BECOME A CALL. Every input the launch seam reads,
       * reported over the stream — because the console port reboots this
       * board, so the only way to watch it decide is to have it say so. A
       * board that wants a call and never places one is otherwise silent
       * about which of three conditions refused it.
       */
      "\"hasStreamCap\":%s,\"outboxFree\":%u,"
      "\"lastStartStatus\":%d,\"startCallFailures\":%u,"
      "\"lastLaunchStep\":%d,\"launchPolls\":%u,"
      "\"sawWantsCall\":%s,\"sawLinkReady\":%s,\"wantsCallPolls\":%u,"
      "\"gateOpen\":%s,\"t\":%" PRIu64 ",\"uptimeMs\":%" PRIu64,
      iterate_kit_esp_idf_itx_transport_state_name(transport.state),
      iterate_kit_voicelab_state_name(runtime.voicelab.state),
      iterate_kit_voicelab_failure_name(runtime.voicelab.failure),
      stream_path,
      clock,
      iterate_kit_esp_reset_reason_name(),
      iterate_kit_esp_last_restart_note(),
      iterate_kit_itx_connection_state_name(runtime.connection.state),
      runtime.voicelab.call_active ? "true" : "false",
      runtime.voicelab.call_pending ? "true" : "false",
      runtime.view.wants_call ? "true" : "false",
      runtime.talking ? "true" : "false",
      runtime.voicelab.has_stream_capability ? "true" : "false",
      (unsigned)(CONTROL_OUTBOX_SLOTS - outbox_metrics.current_slots),
      (int)runtime.last_start_status,
      (unsigned)runtime.start_call_failures,
      runtime.last_launch_step,
      (unsigned)runtime.launch_polls,
      runtime.saw_wants_call ? "true" : "false",
      runtime.saw_link_ready ? "true" : "false",
      (unsigned)runtime.wants_call_polls,
      gate_open ? "true" : "false",
      now,
      now);
  if (written <= 0 || (size_t)written >= capacity) return 0U;
  used = (size_t)written;

  for (index = 0U; index < sizeof(fields) / sizeof(fields[0]); index++) {
    written = snprintf(
        out + used,
        capacity - used,
        ",\"%s\":%" PRIu32,
        fields[index].name,
        fields[index].value);
    if (written <= 0 || (size_t)written >= capacity - used) {
      /*
       * Name the field that did not fit. "health overflow" alone sends the
       * reader to the transport, when the answer is always the same: this
       * buffer is one field too small.
       */
      ESP_LOGE(
          tag, "health json full at \"%s\" (%u bytes)", fields[index].name,
          (unsigned int)capacity);
      return 0U;
    }
    used += (size_t)written;
  }
  /*
   * AND THE BOARD'S OWN, in the same shape and under the same rule.
   *
   * A dozen of the fields above were a particular board's hardware — DMA
   * ledgers, codec overruns, an I2C button's read failures, a face's frame
   * count — and the four device files each carried their own dozen. They are
   * the board's to name, so the board appends them, and a board that overflows
   * fails the same way the shared table does: nothing is sent, because a
   * truncated stats line is not a shorter document, it is no document.
   */
  if (runtime.board->health != NULL) {
    const size_t appended =
        runtime.board->health(runtime.board_context, out + used, capacity - used);
    if (appended == 0U) {
      ESP_LOGE(tag, "health json full in the board's fields (%u bytes)",
               (unsigned int)capacity);
      return 0U;
    }
    used += appended;
  }
  if (used + 2U >= capacity) return 0U;
  out[used++] = '}';
  out[used] = '\0';
  return used;
}

static size_t render_health(void *context, char *out, size_t capacity) {
  (void)context;
  return health_json(out, capacity);
}

/*
 * `append_stats` WAS HERE, AND IT IS WHY NOTHING COULD EVER SLEEP.
 *
 * It pushed this same document onto the conversation stream every five
 * seconds, unconditionally, from inside the "everything ready" gate — so four
 * idle boards were four Durable Objects woken twelve times a minute each,
 * forever, whether or not anybody was in the room. A heartbeat is the one
 * thing a hibernating object cannot tolerate, and this one was declared in no
 * contract and duplicated `health()` exactly.
 *
 * The numbers did not go anywhere: `render_health` above is the same document,
 * and a capability call costs nothing when nobody asks. State, not a pulse.
 */

/*
 * A CLOCK, KEPT ONLY SO A CONVERSATION CAN BE NAMED AFTER WHEN IT HAPPENED.
 *
 * Nothing else on this device needs the time: every deadline it has is measured
 * with esp_timer, which counts from boot and cannot be wrong. This exists
 * because a person scrolling a list of streams has to be able to tell which one
 * was this morning's, and `dev-6f0b6ae2562613aa` cannot tell them.
 *
 * Started once, and never waited for. A device whose clock has not arrived is
 * fully usable — it just names conversations the old way — so blocking startup
 * on a UDP round trip to somebody else's server would trade the whole device
 * for a nicety.
 */
static void start_clock_once(void) {
  static bool started;
  esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");

  if (started) return;
  started = true;
  if (esp_netif_sntp_init(&config) != ESP_OK) {
    ESP_LOGW(tag, "no time source; new conversations keep their random names");
    return;
  }
  ESP_LOGI(tag, "asked pool.ntp.org for the time");
}

enum {
  /*
   * 2023-11-14. Any timestamp before this is the system clock's power-on value
   * rather than the real time, and a conversation called "1970-01-01-000012"
   * is worse than one called after a random number: it looks like a date.
   */
  CLOCK_TRUSTWORTHY_AFTER = 1700000000,
};

/** UTC, as YYYY-MM-DD-HHMMSS. False when the clock has not arrived yet. */
static bool clock_slug(char *out, size_t capacity) {
  const time_t seconds = time(NULL);
  struct tm parts;

  if (seconds < (time_t)CLOCK_TRUSTWORTHY_AFTER) return false;
  if (gmtime_r(&seconds, &parts) == NULL) return false;
  return strftime(out, capacity, "%Y-%m-%d-%H%M%S", &parts) > 0U;
}
/*
 * A START-UP FAULT MUST BE VISIBLE, NOT A REBOOT LOOP.
 *
 * Every failure path below this point used to `return`, and the task watchdog
 * had already been subscribed by then — so the main task simply stopped
 * feeding it and the board panicked twenty seconds later, over and over.
 * From across a room that is indistinguishable from a dead device.
 *
 * So park instead: keep the watchdog fed, keep the screen alive,
 * and let the fault sit where somebody can read it.
 */
static void park_with_fault(const char *what) {
  ESP_LOGE(tag, "fatal: %s", what);
  runtime.view.fault = true;
  runtime.view.link_ready = false;
  runtime.view.status = what;
  for (;;) {
    (void)esp_task_wdt_reset();
    /*
     * Present inside the park. One panel is driven by LVGL's own timer and
     * needs nothing, but three are pumped by their caller — and a board that
     * parks without pumping shows the fault to nobody, which is the whole
     * reason parking beats returning.
     */
    present();
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

/*
 * Power the board and check that what it handed back can carry a conversation.
 *
 * PARKS RATHER THAN RETURNS on failure — that is the caller's job, but it is
 * why this is a function: two of the four boards `return`ed from here with the
 * task watchdog already subscribed, which is a reboot loop, and from across a
 * room a board rebooting every twenty seconds is indistinguishable from a dead
 * one and cannot be asked what went wrong.
 *
 * The order INSIDE `start` is the board's own: one must raise its panel before
 * its codec because both resets hang off a single TCA9554, and doing it the
 * other way round resets a configured codec. WHEN this runs relative to the
 * radio is the loop's, and that is `facts->radio_before_codec`.
 */
static bool start_board(void) {
  /*
   * The bridge's five buffers, caller-owned for its whole life and sized for
   * the largest cadence any board declares. Internal RAM on purpose: four of
   * them are what a board's DSP reads and writes every frame, and the one
   * board with a real canceller runs esp-sr over them inline.
   */
  static int16_t bridge_near[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  static int16_t bridge_reference[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  static int16_t bridge_playout[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  static int16_t bridge_clean[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  static int16_t bridge_egress[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  struct iterate_kit_board_audio audio;
  memset(&audio, 0, sizeof(audio));
  if (!runtime.board->start(runtime.board_context, &audio)) return false;
  runtime.codec = audio.codec;
  runtime.processor = audio.processor;
  if (iterate_kit_audio_codec_validate(&runtime.codec) != ITERATE_KIT_OK ||
      iterate_kit_audio_processor_validate(&runtime.processor) !=
          ITERATE_KIT_OK ||
      runtime.codec.properties->capture_sample_rate_hz !=
          runtime.processor.properties->sample_rate_hz ||
      /*
       * The processor is checked against the BRIDGE cadence, not the wire's:
       * on the board whose DSP frame is 256 those are different numbers, and
       * checking the wire's would reject a correct composition.
       */
      runtime.processor.properties->frame_samples !=
          runtime.facts->processing_frame_samples ||
      runtime.facts->capture_chunk_samples == 0U ||
      runtime.facts->capture_chunk_samples >
          ITERATE_KIT_VOICE_FRAME_SAMPLES ||
      (runtime.processor.properties->requires_reference_channel &&
       !runtime.codec.properties->has_reference_channel) ||
      iterate_kit_audio_processor_reset(&runtime.processor) !=
          ITERATE_KIT_OK) {
    return false;
  }
  {
    const struct iterate_kit_aec_capture_bridge_options bridge_options = {
      .sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
      .processing_frame_samples = runtime.facts->processing_frame_samples,
      .egress_frame_samples = FRAME_SAMPLES,
      .near_frame = bridge_near,
      .reference_frame = bridge_reference,
      .playout_frame = bridge_playout,
      .clean_frame = bridge_clean,
      .processing_frame_capacity = ITERATE_KIT_VOICE_FRAME_SAMPLES,
      .egress_frame = bridge_egress,
      .egress_frame_capacity = ITERATE_KIT_VOICE_FRAME_SAMPLES,
      .processor_context = NULL,
      .process = bridge_process,
      .reset_processor = bridge_reset_processor,
      .egress_context = NULL,
      .copy_egress = bridge_copy_egress,
    };
    return iterate_kit_aec_capture_bridge_init(
               &runtime.capture_bridge, &bridge_options) == ITERATE_KIT_OK;
  }
}

bool iterate_kit_voice_loop_init(
    const struct iterate_kit_board_ops *ops,
    const struct iterate_kit_board_facts *facts,
    void *context) {
  TaskHandle_t capture_task_handle = NULL;
  if (ops == NULL || facts == NULL || ops->start == NULL ||
      ops->present == NULL) {
    return false;
  }
  runtime.board = ops;
  runtime.facts = facts;
  runtime.board_context = context;
  (void)snprintf(
      stream_path, sizeof(stream_path), "%s", facts->stream_path);
  turn_policy = facts->turns;
  iterate_kit_voice_playback_clock_init(&runtime.playout_clock);
  /*
   * The app task is the sole consumer of the control inbox and therefore the
   * producer of every speaker frame: it parses the delivery batch, base64
   * decodes the PCM and pushes it to the playback buffer, all inside a 20ms
   * budget. FreeRTOS starts it at priority 1 — below the WebSocket task, the
   * display and timer services — and there is no Kconfig symbol to
   * change that (ESP_MAIN_TASK_PRIORITY does not exist; believing it did
   * left this at 1 through several rounds of "priority fixes"). So it raises
   * itself, above everything on this core except Wi-Fi, lwIP and the timers.
   */
  /*
   * 4, deliberately BELOW the WebSocket/TLS task at 5 that feeds this one.
   * At 10 the consumer outranked its own producer on the same core, and this
   * loop polls hard — so the network task got starved and everything felt
   * laggy: buttons late, UI stale, the greeting never arriving. Above LVGL
   * (2), below the producer. Priority 1 (the FreeRTOS default, and what this
   * was before) is the other extreme and was equally wrong: below LVGL.
   */
  /*
   * EQUAL to the network task (5), deliberately, so the two round-robin
   * instead of one starving the other.
   *
   * At 4 — one below — the network task won every time it had work, and
   * during an answer it ALWAYS has work: audio arrives continuously. This
   * task is what drains the inbox, decodes that audio, answers every RPC,
   * polls the buttons and sends the microphone, so it got whatever was left,
   * which was not much. Measured: health() calls that took 50 SECONDS to
   * return mid-answer, ping round trips of 28s, and a device that looks
   * frozen with a dead talk button — because it very nearly was.
   *
   * Above (10) was the opposite error and is in this file's history: the app
   * loop polls hard, so the network task starved and nothing arrived at all.
   * Equal priority is the only setting where both make progress.
   */
  vTaskPrioritySet(NULL, 5);
  const struct iterate_kit_esp_configuration_result configuration_result =
      iterate_kit_esp_read_configuration(&runtime.configuration);
  if (configuration_result.status != ITERATE_KIT_ESP_CONFIGURATION_OK) {
    ESP_LOGE(
        tag,
        "device is not provisioned: storage=%s",
        iterate_kit_esp_configuration_status_name(
            configuration_result.status));
    return false;
  }
  /*
   * Subscribe only after provisioning succeeds. An intentionally unprovisioned
   * board returns to its setup path; subscribing before that return created a
   * watchdog reboot loop. From here onward this task owns every recovery path,
   * so a stall must still reboot loudly.
   */
  (void)esp_task_wdt_add(NULL);
  if (!runtime.facts->radio_before_codec && !start_board()) {
    park_with_fault("board bring-up failed");
  }
  runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_CONNECTING;
  runtime.view.status = ("connecting to iterate");
  ESP_LOGI(
      tag,
      /*
       * The largest CONTIGUOUS DMA block is the number that predicts a display
       * freeze: free-size hides fragmentation, and a flush needs one
       * contiguous ~15 KiB internal allocation. If this dips near that, the
       * next flush is the one that fails.
       */
      "heap after display: internal=%u dma=%u dmaLargest=%u total=%u",
      (unsigned int)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
      (unsigned int)heap_caps_get_free_size(MALLOC_CAP_DMA),
      (unsigned int)heap_caps_get_largest_free_block(MALLOC_CAP_DMA),
      (unsigned int)esp_get_free_heap_size());
  /*
   * PSRAM, like the speaker queue beside it and for the same reasons.
   *
   * 32 frames of 640 bytes is 20 KiB, and three of the four boards were
   * spending that in INTERNAL RAM — the only kind TLS, Wi-Fi and DMA can use.
   * The fourth already knew better: the board with a camera, LVGL and esp-sr
   * put its microphone queue in PSRAM, and it is also the board that dropped
   * its socket mid-sentence with "esp-aes: Failed to allocate memory" while
   * `heapFree` read 5,800,196. Unifying to internal would have taken 20 KiB
   * back from exactly the board that has already proved it cannot spare it.
   *
   * Safe for the same reason the speaker queue is: an item is one indivisible
   * 20 ms frame, FreeRTOS copies on send and receive, and this is never a DMA
   * target. It is touched at 50 Hz by two tasks that already touch PSRAM.
   */
  runtime.mic_queue = xQueueCreateWithCaps(
      MIC_QUEUE_DEPTH, sizeof(struct mic_frame), MALLOC_CAP_SPIRAM);
  /*
   * PSRAM, not internal. Each queue item is one indivisible 20 ms frame plus
   * its answer generation. FreeRTOS synchronizes reset with receive, while the
   * generation rejects a frame a consumer had already copied when reset ran.
   * That is the replacement guarantee a byte stream cannot provide.
   */
  runtime.speaker_queue = xQueueCreateWithCaps(
      SPEAKER_QUEUE_DEPTH, sizeof(struct speaker_frame), MALLOC_CAP_SPIRAM);
  if (runtime.mic_queue == NULL || runtime.speaker_queue == NULL) {
    park_with_fault("audio buffer allocation failed");
  }
  if (!initialise_rings() || !initialise_connection()) {
    park_with_fault("bounded runtime initialization failed");
  }
  /*
   * A RADIO THAT WILL NOT START IS NOT A FATAL FAULT, IT IS AN OFFLINE
   * DEVICE. This used to return, which — with the watchdog already
   * subscribed — turned a transient Wi-Fi start failure into a permanent
   * reboot loop. Keep trying, and keep the surface honest while trying.
   */
  while (iterate_kit_esp_idf_itx_transport_start(&transport) !=
         ITERATE_KIT_OK) {
    ESP_LOGE(
        tag,
        "transport start failed: platform=%ld — retrying",
        (long)transport.last_platform_error);
    runtime.view.status = "network start failed — retrying";
    for (int wait = 0; wait < 50; ++wait) {
      (void)esp_task_wdt_reset();
      /*
       * Present inside the wait. One panel is driven by LVGL's own timer and
       * needs nothing here, but three are pumped by their caller — and this
       * five-second loop is exactly where a board that is retrying looks
       * frozen if nobody pumps it.
       */
      present();
      vTaskDelay(pdMS_TO_TICKS(100));
    }
  }
  /*
   * ...AND THE CODEC NOW, on the board that asked for it, while the radio is
   * off doing its own waiting. Its XMOS + AIC3204 bring-up is 6.2 s measured
   * and it used to run to completion BEFORE Wi-Fi was even started, so two
   * waits ran back to back for no reason: that board reached a ready mount at
   * ~14 s where the others managed ~8. Nothing in the transport needs the
   * codec, and only the two tasks below do.
   */
  if (runtime.facts->radio_before_codec && !start_board()) {
    park_with_fault("board bring-up failed");
  }
  if (xTaskCreatePinnedToCore(
          capture_task,
          "vl-capture",
          runtime.facts->capture_stack_bytes,
          NULL,
          16,
          &capture_task_handle,
          1) != pdPASS ||
      xTaskCreatePinnedToCore(
          playback_task, "vl-playback", 4096, NULL, 17, NULL, 1) != pdPASS) {
    if (capture_task_handle != NULL) {
      vTaskDelete(capture_task_handle);
    }
    park_with_fault("portable audio task creation failed");
  }
  ESP_LOGI(
      tag,
      /*
       * Both halves, because they come out of different pools now and a single
       * total would hide the one that matters: `internal_bytes` is the
       * transport's static task stack, which is the only part of this loop
       * that competes with TLS, Wi-Fi and DMA.
       */
      "voicelab voice client ready: psram_bytes=%u internal_bytes=%u stream=%s",
      (unsigned int)sizeof(runtime),
      (unsigned int)sizeof(transport),
      stream_path);
  return true;
}

/*
 * ASK THE HOP, BECAUSE A PRESS JUST MADE THE ANSWER WORTH KNOWING.
 *
 * Queues one WebSocket PING and records the PONG count to beat. Called when a
 * call is placed and, once, again if the first went unanswered — see
 * ITERATE_KIT_VOICE_PRESS_PROBE_MS for why the answer is a PONG rather than a
 * delivered batch, and why a single missed one is not evidence.
 *
 * Takes the pong baseline from a metrics snapshot the caller already has, so
 * arming costs one control frame and no extra sampling.
 */
static void arm_press_probe(uint64_t now, uint32_t pongs_now) {
  runtime.press_probe_sent_ms = now;
  runtime.press_probe_pongs_before = pongs_now;
  ++runtime.press_probe_attempt;
  ++runtime.press_probes;
  iterate_kit_esp_idf_itx_transport_request_probe(&transport);
}

static void disarm_press_probe(void) {
  runtime.press_probe_sent_ms = 0U;
  runtime.press_probe_attempt = 0U;
}

/*
 * ONE PASS OF THE DEVICE.
 *
 * `now_ms` is a parameter rather than a call, because a step that is handed
 * its clock can be driven by a virtual one — and a device whose every deadline
 * is measured against a clock it fetches itself cannot be tested at all.
 */
void iterate_kit_voice_loop_step(uint64_t now_ms_value) {
  static uint64_t next_control_poll_at;
  (void)now_ms_value;
  {
    (void)esp_task_wdt_reset();
    (void)iterate_kit_esp_idf_itx_transport_poll(&transport, 16U);
    /*
     * The controls, at a human cadence rather than the loop's.
     *
     * One board's talk button hangs off a TCA9554, so every read is an I2C
     * transaction on the bus the codec and the touch controller share: at the
     * loop's 5 ms that was 200 reads a second of pure contention. 25 ms is
     * still far faster than a person can press, and a board with cheaper
     * controls loses nothing by being asked at the same rate.
     */
    if (now_ms(NULL) >= next_control_poll_at) {
      next_control_poll_at = now_ms(NULL) + CONTROL_POLL_MS;
      memset(&runtime.intent, 0, sizeof(runtime.intent));
      if (runtime.board->poll != NULL) {
        runtime.board->poll(runtime.board_context, &runtime.intent);
      }
    }
    /*
     * ...and drain what those methods queued. A capability that accepts an
     * intent and never delivers it is worse than one that is absent: the
     * first proof run of this board's new conversation.start() returned
     * success, and health() then reported wantsCall FALSE forever, because
     * the event sat in a queue nothing was reading.
     */
    (void)iterate_kit_device_event_poll(
        &runtime.device_events, ITERATE_KIT_VOICE_DEVICE_EVENT_POLL_BUDGET);
    /*
     * WHETHER THIS DEVICE CAN DO ANYTHING, published every time it changes.
     *
     * The same gate every producer sits behind and that `health()` reports as
     * `gateOpen`: transport ready, stream mounted, generations agreed. The
     * screen needs it continuously rather than at one transition, because the UI
     * state it used to be folded into is written from nine places and any of
     * them would erase it — which is exactly how the board came to read "ready"
     * while the server was refusing it every three seconds.
     *
     * On change only: publishing marks the snapshot dirty, and doing that on
     * every pass would repaint the whole screen at the app loop's rate.
     */
    {
      static bool published_link_ready = true;
      /*
       * THE SAME PREDICATE, SPLIT INTO ITS RUNGS. `link_ready` is unchanged —
       * it is the whole chain, and every producer still sits behind it. What
       * is new is publishing the two halves separately, so the lights can say
       * WHICH one is missing instead of showing one undifferentiated amber.
       */
      const bool api_ready =
          transport.state == ITERATE_KIT_ESP_IDF_ITX_READY;
      const bool stream_ready =
          runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
          runtime.voicelab_generation == runtime.connection.generation;
      const bool ready = api_ready && stream_ready;
      runtime.view.api_ready = api_ready;
      runtime.view.stream_ready = stream_ready;
      if (ready != published_link_ready) {
        published_link_ready = ready;
        runtime.view.link_ready = ready;
      }
    }
    /*
     * INTENT IS THE LOOP'S, and this is the only place a control changes it.
     *
     * What arrives is the pair of explicit edges every board's shared
     * session grammar resolved its gestures into — a raw press never gets
     * this far, so there is no toggle left to disambiguate against the
     * intent the loop holds.
     */
    /*
     * THE AUDIT RIDES THE ONE RESOLUTION SITE, so a finger and an injected
     * press write the same record. Latest-wins latch rather than a queue:
     * two controls in one pass is already a person mashing, and the append
     * below needs a READY session the press may predate.
     */
    if (runtime.intent.end_call) runtime.pending_button_audit = "end";
    if (runtime.intent.start_call) runtime.pending_button_audit = "start";
    if (runtime.intent.end_call) {
      runtime.view.wants_call = false;
      /*
       * THE TAIL DIES WITH THE PRESS. The far end's conversation-ended will
       * also abandon, but that is a round trip away, and the ring holds
       * thirty seconds — a person who just ended a call and keeps hearing
       * the answer reads the button as broken, not the call as draining.
       */
      (void)abandon_speaker_audio();
      ESP_LOGI(tag, "control: ending call");
    }
    if (runtime.intent.start_call && !runtime.voicelab.call_active) {
      runtime.view.wants_call = true;
      ESP_LOGI(tag, "control: starting call");
    }
    runtime.intent.start_call = false;
    runtime.intent.end_call = false;
    {
      static bool talk_down;
      if (runtime.intent.talk_held != talk_down) {
        talk_down = runtime.intent.talk_held;
        /*
         * ...AND A FINGER ON THE TALK BUTTON OPENS THE CALL TOO, for the same
         * reason `pushToTalk.start()` does: one verb. The shared session
         * grammar already mints `start_call` for the hold that wakes a
         * push-to-talk board and reports the level only where the table says
         * holding means talking, so this edge restates a claim the board has
         * already made — kept because it is the loop's own spelling of the
         * one-verb rule, the same claim `ptt-start` makes over the wire.
         *
         * THE RISING EDGE, not the level. `talk_held` stays true for as long as
         * the button is down, so raising on the level would re-open a call the
         * person had just ended with their other hand and there would be no way
         * to hang up without letting go first.
         *
         * Placed after the explicit start/end above so that within one pass
         * the specific instruction wins over this implicit one.
         */
        if (talk_down) runtime.view.wants_call = true;
        ESP_LOGI(
            tag, "talk %s",
            talk_down ? "down (talking)" : "up (commit)");
      }
    }

    if (transport.state != runtime.last_transport_state) {
      ESP_LOGI(
          tag,
          "transport state=%s",
          iterate_kit_esp_idf_itx_transport_state_name(
              transport.state));
      if (runtime.last_transport_state == ITERATE_KIT_ESP_IDF_ITX_READY) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        iterate_kit_esp_idf_itx_transport_metrics(&transport, &metrics);
        ESP_LOGE(
            tag,
            "left ready: recvStatus=%" PRId32 " wsClose=%" PRId32
            " wsErrType=%" PRId32 " tlsErr=%" PRId32 " errno=%" PRId32
            " protoFail=%" PRIu32 " recvFail=%" PRIu32 " sendFail=%" PRIu32
            " inboxDiscard=%" PRIu32 " outboxDiscard=%" PRIu32
            " appCapnweb=%" PRId32,
            metrics.last_control_receive_status,
            metrics.last_websocket_close_status_code,
            metrics.last_websocket_error_type,
            metrics.last_websocket_tls_error,
            metrics.last_websocket_transport_errno,
            metrics.protocol_failures,
            metrics.control_receive_failures,
            metrics.control_send_failures,
            metrics.control_inbox_discarded,
            metrics.control_outbox_discarded,
            metrics.last_application_capnweb_status);
      }
      if (transport.state == ITERATE_KIT_ESP_IDF_ITX_READY) {
        /* The socket is up, so DNS and UDP work: a good moment to ask what
         * time it is. Once, and never blocking on the answer. */
        start_clock_once();
      }
      if (transport.state == ITERATE_KIT_ESP_IDF_ITX_FAILED) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        /*
         * The reason, on the screen. Whether the screen SAYS offline is decided
         * by the published link flag rather than here — nine other places set
         * the UI state, and a one-shot "offline" survived only until the next of
         * them ran.
         */
        runtime.view.status = (iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
        iterate_kit_esp_idf_itx_transport_metrics(&transport, &metrics);
        ESP_LOGE(
            tag,
            "mount diagnosis: connection=%d mount=%s failure=%s "
            "protoFail=%" PRIu32 " lastRecvStatus=%" PRId32
            " wsClose=%" PRId32 " appCapnweb=%" PRId32 "@%" PRIu32
            " recvFail=%" PRIu32 " sendFail=%" PRIu32,
            (int)runtime.connection.state,
            iterate_kit_itx_mount_state_name(runtime.connection.mount.state),
            iterate_kit_itx_mount_failure_name(
                runtime.connection.mount.failure),
            metrics.protocol_failures,
            metrics.last_control_receive_status,
            metrics.last_websocket_close_status_code,
            metrics.last_application_capnweb_status,
            metrics.last_application_capnweb_generation,
            metrics.control_receive_failures,
            metrics.control_send_failures);
      }
      runtime.last_transport_state = transport.state;
    }

    const uint64_t now = now_ms(NULL);

    /*
     * The transport can latch a fatal state that nothing ever clears — most
     * reachably when the network task's stack high-water (a minimum-EVER
     * measurement) dips below its floor once, which then forbids every
     * future reconnect for the life of the boot. A human's remedy is the
     * power button, so make that the device's remedy too, bounded and loud,
     * rather than sitting on "connecting" forever.
     */
    {
      static uint64_t unhealthy_since;
      const bool healthy =
          transport.state != ITERATE_KIT_ESP_IDF_ITX_FAILED;
      if (healthy) {
        unhealthy_since = 0U;
      } else if (unhealthy_since == 0U) {
        unhealthy_since = now;
      } else if (iterate_kit_voice_elapsed_ms(now, unhealthy_since) > UNHEALTHY_RESTART_MS) {
        ESP_LOGE(
            tag,
            "transport unrecoverable for %us — restarting",
            (unsigned int)(UNHEALTHY_RESTART_MS / 1000U));
        iterate_kit_esp_restart_with_note("transport latched fatal");
      }
    }

    /*
     * LIVENESS, not optimism.
     *
     * FAILED is the honest failure and the block above handles it. This one is
     * the dishonest failure: the socket stays open, the transport stays READY,
     * and nothing moves in either direction — a half-open TCP connection is
     * indistinguishable from a quiet one from this end. The device goes on
     * believing it has a session and a call, lights "listening" and "speaking"
     * at the user, and sends every word into a void for hours.
     *
     * THE EVIDENCE IS A WEBSOCKET PONG, and it took two tries to get right.
     *
     * It was a pulled application-level `voice-agent/ping` append, which was a
     * third liveness mechanism above the two that measure the hop honestly, and
     * it woke a processor twelve times a minute to be told it was awake. That
     * went. But deleting it left NOTHING watching this failure, because both
     * ends of the connection answered pings and neither asked — so the device
     * now originates a WebSocket PING when the hop has been quiet both ways
     * (see the keepalive in websocket_connection.c) and this watches the PONGs.
     *
     * WHY NOT ANY INBOUND APPLICATION SIGNAL: delivery batches and served
     * dispatches both stop on a perfectly healthy IDLE board, so re-keying on
     * them would restart every idle device on a timer. The mount watchdog made
     * exactly that mistake; the note in voice_device_profile.h is what it cost.
     * A PONG keeps arriving on an idle board, which is the whole point.
     *
     * A PONG IS NOT DELIVERY CREDIT. It proves the hop parsed a frame in order
     * and nothing more — the rule at iterate_kit_websocket_tx_queue_control is
     * unchanged and this must never become an application acknowledgement. It
     * is read here, by a watchdog asking whether the hop is alive at all, and
     * nowhere else.
     */
    {
      static uint64_t last_liveness_ms;
      /** When the transport last stopped being ready; 0 while it is ready. */
      static uint64_t not_ready_since_ms;
      static uint32_t last_pong_count;
      struct iterate_kit_esp_idf_itx_transport_metrics liveness;
      iterate_kit_esp_idf_itx_transport_metrics(&transport, &liveness);
      if (last_liveness_ms == 0U) last_liveness_ms = now;
      if (liveness.websocket_pongs_received != last_pong_count) {
        last_pong_count = liveness.websocket_pongs_received;
        last_liveness_ms = now;
      }
      runtime.pongs_seen = liveness.websocket_pongs_received;
      /*
       * THE PRESS'S OWN QUESTION, ANSWERED ON THE PRESS'S OWN CLOCK.
       *
       * The watchdog above waits seven minutes, deliberately, because on an
       * idle board a dead hop costs nothing. This one waits three seconds,
       * because a press just went out and a press is the one moment a dead hop
       * is the difference between a device and a brick. It exists at all
       * because the append the press sends CANNOT report its own failure: a
       * one-way write into a half-open socket is accepted by TCP, reports
       * success, and is noticed by nothing until DOWNLINK_SILENCE_MS ten
       * seconds later.
       *
       * It shares this block only because the PONG count is already sampled
       * here; the two deadlines are unrelated and must not be merged.
       *
       * Disarmed the moment the transport stops being READY — the socket is
       * already being replaced, and a PONG from a connection that no longer
       * exists is never coming.
       */
      if (runtime.press_probe_sent_ms != 0U) {
        if (transport.state != ITERATE_KIT_ESP_IDF_ITX_READY) {
          disarm_press_probe();
        } else if (liveness.websocket_pongs_received !=
                   runtime.press_probe_pongs_before) {
          /*
           * ALIVE — and now measured. `pressProbeMs` is the only evidence
           * anybody has for what a PONG round trip actually costs on these
           * boards, which is what the 1500 ms budget was guessed against.
           */
          runtime.press_probe_ms = (uint32_t)iterate_kit_voice_elapsed_ms(
              now, runtime.press_probe_sent_ms);
          disarm_press_probe();
        } else if (iterate_kit_voice_elapsed_ms(
                       now, runtime.press_probe_sent_ms) > PRESS_PROBE_MS) {
          ++runtime.press_probe_misses;
          if (runtime.press_probe_attempt < PRESS_PROBE_ATTEMPTS) {
            /* One missed PONG is a dropped packet. Ask again before acting. */
            ESP_LOGW(
                tag,
                "no pong %ums after a press — asking once more",
                (unsigned int)PRESS_PROBE_MS);
            arm_press_probe(now, liveness.websocket_pongs_received);
          } else {
            /*
             * TWO IN A ROW IS A DEAD SOCKET, and the only remedy for a dead
             * socket is a new one: recycling the stream connection would send
             * its round trip down the same silent pipe. Forget the call first
             * — it was requested into nothing, and believing in it would stop
             * the intent from placing a real one on the replacement session.
             */
            ESP_LOGE(
                tag,
                "hop did not answer %u probes after a press — replacing the "
                "socket",
                (unsigned int)PRESS_PROBE_ATTEMPTS);
            ++runtime.press_probe_restarts;
            disarm_press_probe();
            iterate_kit_voicelab_forget_call(&runtime.voicelab);
            iterate_kit_esp_idf_itx_transport_request_restart(&transport);
          }
        }
      }
      /*
       * A TRANSPORT THAT IS NEVER READY MUST NOT DISABLE THE RESTART.
       *
       * Holding the liveness clock while the transport is down is right — you
       * cannot fault a device for missing round trips it had no lane for — but
       * it was once the ONLY thing this branch did, so a transport that never
       * came back reset the clock every tick and the restart could never fire.
       * Measured on the StackChan: unreachable for ten minutes and more, no
       * capability, no face, task watchdog fed the whole time, recovered only
       * by a human pulling power. So the grace is bounded: being down is
       * forgiven, being down forever is the failure this restart exists for.
       */
      if (transport.state != ITERATE_KIT_ESP_IDF_ITX_READY) {
        last_liveness_ms = now;
        if (not_ready_since_ms == 0U) not_ready_since_ms = now;
        if (iterate_kit_voice_elapsed_ms(now, not_ready_since_ms) >
            NO_LIVENESS_RESTART_MS) {
          ESP_LOGE(
              tag,
              "transport has not been ready for %us — restarting",
              (unsigned int)(NO_LIVENESS_RESTART_MS / 1000U));
          iterate_kit_esp_restart_with_note("transport never became ready");
        }
      } else {
        not_ready_since_ms = 0U;
      }
      if (iterate_kit_voice_elapsed_ms(now, last_liveness_ms) >
          NO_LIVENESS_RESTART_MS) {
        ESP_LOGE(
            tag,
            "no pong in %us despite a ready transport — restarting",
            (unsigned int)(NO_LIVENESS_RESTART_MS / 1000U));
        iterate_kit_esp_restart_with_note("hop dead on a ready transport");
      }
    }

    /*
     * A FAILED VOICELAB IS NOT A RESTING STATE.
     *
     * `fail()` latches, and the only thing that re-mounts is a CONNECTION
     * generation change — so a mount that failed while the transport stayed
     * perfectly ready sat failed forever. Measured on the HA Voice PE:
     * voicelab=failed, failure=open-call, transport=ready, pings frozen at 0,
     * every later call request ignored, until the 180-second liveness watchdog
     * restarted the whole chip. Three minutes of a device that answers nothing
     * and then reboots, from one transient refusal.
     *
     * Re-mounting is the same work the connection-generation path does, so it
     * is asked for the same way: forget which generation we mounted, and the
     * block below builds a new one. Backed off, because a mount that fails
     * every time must not become a spin.
     */
    if (runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY) {
      static struct iterate_kit_retry_gate remount_gate;
      static bool remount_gate_ready;
      if (!remount_gate_ready) {
        remount_gate_ready =
            iterate_kit_retry_gate_init(
                &remount_gate,
                (uint32_t)ITERATE_KIT_VOICE_REMOUNT_RETRY_MS,
                (uint32_t)ITERATE_KIT_VOICE_REMOUNT_RETRY_MAX_MS) ==
            ITERATE_KIT_OK;
      }
      /*
       * RECOVERY HAS TO CLEAR THE BACKOFF, or the backoff outlives the fault.
       *
       * This gate was only ever deferred. Five transient failures — an
       * access-point blip in the first minute will do it — walked the delay
       * 2s, 4s, 8s, 16s, 30s and left it there for the rest of the boot, so a
       * board that had been perfectly healthy for an hour still took thirty
       * seconds to notice the next failed mount. A mount that reached READY
       * is the evidence the gate exists to wait for, and it is the same
       * signal both transport gates already reset themselves on.
       */
      if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY) {
        iterate_kit_retry_gate_reset(&remount_gate);
      } else if (
          runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED &&
          remount_gate_ready &&
          iterate_kit_retry_gate_ready(&remount_gate, (int64_t)now * 1000)) {
        iterate_kit_retry_gate_defer(&remount_gate, (int64_t)now * 1000);
        ESP_LOGW(
            tag,
            "voicelab failed (%s) with a ready connection — re-mounting",
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
        (void)iterate_kit_voicelab_close(&runtime.voicelab);
        runtime.voicelab_generation = 0U;
      }
    }

    if (transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY &&
        runtime.voicelab_generation != runtime.connection.generation) {
      /*
       * Designated on purpose: this init used to be positional, and the
       * voicelab options struct grows fields — a silent mis-binding here is
       * exactly the hazard the header warns about.
       */
      const struct iterate_kit_voicelab_options options = {
        .session = &runtime.connection.session,
        .project_id = runtime.configuration.project_id,
        .project_api_key = runtime.configuration.project_api_key,
        .stream_path = stream_path,
        .client_path = runtime.facts->client_path,
        .conversation_id = runtime.facts->conversation_id,
        .now_ms = now_ms,
        .clock_context = NULL,
        .on_speaker = on_speaker_pcm,
        .on_control = on_control,
        /*
         * Only where there is a mouth. A board with no `observe_answer` has
         * nowhere to put a viseme, and offering the callback would make the
         * poll below look worth doing on a board that can never use it.
         */
        .on_face =
            runtime.board->observe_answer != NULL ? on_face : NULL,
        .downlink_context = NULL,
      };
      const enum capnweb_status started =
          iterate_kit_voicelab_start(&runtime.voicelab, &options);
      if (started != CAPNWEB_OK) {
        /*
         * Rate-limited, but never silent. This retries every 5 ms, and a
         * start that keeps failing leaves the device answering RPCs while
         * doing nothing else — the single most confusing state it has, and
         * previously the only one it never said a word about.
         */
        static uint64_t next_complaint_at;
        if (now >= next_complaint_at) {
          next_complaint_at = now + 5000U;
          ESP_LOGE(tag, "voicelab mount will not start (status %d)", (int)started);
        }
      }
      if (started == CAPNWEB_OK) {
        runtime.voicelab_generation = runtime.connection.generation;
        runtime.frame_sequence = 0U;
        (void)xQueueReset(runtime.mic_queue); /* drop pre-session stale audio */
        runtime.dial_speech_queued = false;
        /*
         * NOTHING TO FORGET ABOUT THE SENDER ANY MORE.
         *
         * A classifier reset belonged here, because it ignored any frame
         * numbered below the highest answer it had played: a restarted bridge
         * numbered its first answer 0, every frame was then "stale", and the
         * device stayed silent for the rest of the boot while the transport
         * reported ready and the batches kept climbing. A new sender can no
         * longer arrive numerically behind the old one, because no frame
         * carries a number.
         */
        ESP_LOGI(
            tag,
            "voicelab mount started (generation %" PRIu32 ")",
            runtime.connection.generation);
      }
    }

    if (runtime.voicelab.state != runtime.last_voicelab_state) {
      ESP_LOGI(
          tag,
          "voicelab state=%s failure=%s",
          iterate_kit_voicelab_state_name(runtime.voicelab.state),
          iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      runtime.last_voicelab_state = runtime.voicelab.state;
      if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY) {
        runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
        /*
         * NOTHING. The menu's headline is the path and its context line already
         * carries the connection state, so "ready" here was the same word twice
         * on adjacent rows. The status line is for transients — "reconnecting",
         * "call ended" — and being empty is the honest steady state.
         */
        runtime.view.status = ("");
      } else if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED) {
        /* A dead session takes the call with it; the button starts over. */
        runtime.view.wants_call = (false);
        runtime.view.call_active = (false);
        runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_CONNECTING;
        runtime.view.status = (iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      }
    }

    /*
     * The turn's UI state is settled OUTSIDE the session gate below.
     *
     * All of this used to live inside "session is READY", so if the session
     * dropped while the button was held, the release was never processed at
     * all: the device sat on "listening" forever, nothing was ever committed,
     * and no answer could arrive. The user's intent and what the screen says
     * must never depend on the network being up — only the appends do.
     */
    if (runtime.talking && !runtime.flushing_turn &&
        (runtime.voicelab.state != ITERATE_KIT_VOICELAB_READY ||
         /*
          * `&& !wants_call`: talking WITHOUT a call is now the legitimate
          * WAKING state — the microphone opens at the wake press and
          * buffers into the dial. Without this conjunct the abandon fired
          * on every pass of every dial, flapping `talking` and resetting
          * the queue at 200 Hz, which erased the dial buffer this state
          * exists to hold and spammed a WARN per pass while doing it.
          */
         (!runtime.voicelab.call_active && !runtime.view.wants_call))) {
      ESP_LOGW(tag, "turn abandoned: session or call went away");
      runtime.talking = false;
      runtime.flushing_turn = false;
      runtime.remote_talk = false;
      /* Give the pins back: the answer path needs them. */
      board_fence(false);
      /*
       * AND STOP ATTENDING. Every other path out of a turn clears this at the
       * commit; this one bypasses the commit entirely, so a face left here
       * held its listening pose until the next turn opened. Reachable on any
       * board — an open-mic board takes it on every call end.
       */
      runtime.view.listening = false;
      runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
      runtime.view.status = runtime.facts->call_hint;
    }

    if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
        transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.voicelab_generation == runtime.connection.generation) {
      /*
       * EVERY producer gates on outbox headroom: exhaustion is
       * SESSION-FATAL in this peer (finish_message terminalizes on
       * backpressure), and the measured drain is only ~25-50 messages/s.
       * Mic frames aggregate to 4-frame/80ms appends (12.5 pushes/s);
       * frames are skipped without headroom — the freshest-wins mic queue
       * makes that loss honest.
       */
      struct iterate_kit_spsc_ring_metrics outbox_metrics;
      iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox_metrics);
      const size_t outbox_free =
          CONTROL_OUTBOX_SLOTS - outbox_metrics.current_slots;
      static struct mic_frame frame_storage[MIC_FRAMES_PER_APPEND];
      static uint64_t drain_window_at;
      static struct iterate_kit_launch launch;
      static uint64_t call_pending_since;
      static bool call_active_shown;

      /*
       * One intent path for both sources: a physical button edge and an RPC
       * call land on the same two flags, so remote and local control cannot
       * disagree about what the device is doing (the M5StickS3 does the same
       * through its device-event queue).
       */
      const bool wants_call = runtime.view.wants_call;
      /*
       * SILENCE ONLY COUNTS ONCE SOMETHING IS EXPECTED. The downlink watchdog
       * below measures time since the last delivered batch, and nothing is
       * delivered before a call exists — so a device that had been idle for
       * more than ten seconds recycled its connection the instant somebody
       * asked for a call, adding a whole reconnection to the wait. Restart
       * the clock at the moment the expectation starts.
       */
      {
        static bool wanted_previously;
        if (wants_call && !wanted_previously) runtime.voicelab.last_batch_ms = now;
        wanted_previously = wants_call;
      }
      /*
       * A WIRED-OR, and then a turn policy on top of it.
       *
       * A physical control and an RPC hold the microphone open the same way,
       * so either is enough. On a board whose far end segments turns there is
       * no control to hold at all and the microphone rides the open call —
       * requesting the manual default there produces an accepted call and a
       * deaf assistant, so the policy is a fact rather than a guess.
       *
       * `wants_call &&` IS NOW A SAFETY NET RATHER THAN AN ORDERING. It used to
       * be the reason a talk request needed `conversation.start()` in front of
       * it: the latch was set and this conjunct silently discarded it forever.
       * Both talk sources raise `wants_call` at the press now, so nothing can
       * arrive here holding talk without a call being wanted — except the one
       * case this still has to refuse, which is talk held across a deliberate
       * hang-up. Sending microphone frames into a call nobody wants is not a
       * turn, so the conjunct stays.
       */
      const bool wants_talk =
          turn_policy == ITERATE_KIT_VOICE_TURNS_SERVER_VAD
          /*
           * `|| wants_call`: the microphone opens at the WAKE PRESS, not at
           * CALL_ACCEPTED, so speech spoken into the dial lands in the
           * queue and the accepted call carries it — see `dial_buffering`.
           * The drain below still waits for the call, so nothing is SENT
           * early; end-goes-silent means wants_call only rises on a
           * deliberate wake, so this no longer admits idle room noise.
           */
          ? (runtime.voicelab.call_active || wants_call)
          : (wants_call &&
             (runtime.intent.talk_held || runtime.remote_talk));
      runtime.view.talk_held = wants_talk;

      /*
       * THE BRIDGE-SILENCE WATCHDOG WAS HERE, AND ITS EVIDENCE IS GONE.
       *
       * The bridge holds the call in a Durable Object this device cannot see,
       * and it can stop — evicted, redeployed, or simply gone — without
       * appending the conversation-ended that would say so. Overnight that left
       * a device holding a call that had not existed for hours, so the call was
       * believed only while its bridge kept proving it was there.
       *
       * The proof was the pong answering this device's own ping: the ONE
       * bridge-sourced event that arrives while nobody is speaking. With the
       * ping deleted, twenty seconds of a person thinking is indistinguishable
       * from a dead bridge, and the watchdog would have dropped a live call on
       * every thoughtful pause. A watchdog that fires on the normal case is
       * worse than none.
       *
       * `bridgeAgeMs` still reports the age, so the fact is visible to whoever
       * is looking. What replaced the ACTION is the downlink deadline below,
       * which fires on silence only when traffic is expected — and whose remedy
       * (recycle the connection, keep the call) was always the gentler one.
       */

      /*
       * THE DOWNLINK NEEDS ITS OWN PROOF.
       *
       * Everything above trusts that if the bridge appends something, this
       * device hears it. That is one lane, held by the platform as a
       * callback registration inside the stream's Durable Object, and it can
       * be lost on its own: measured here, a device whose uplink was resolving
       * happily while eight conversation-accepted events and eleven more
       * besides were appended by live bridges and NOT ONE of
       * them arrived. Its batch counter did not move for 68 seconds. The UI
       * said "starting call" the whole time, which is exactly what a person
       * sees, and nothing in the device was ever going to notice: the socket
       * was fine, the session was fine, the appends were fine.
       *
       * Silence is only evidence when traffic is expected. It is expected
       * whenever a call is wanted: an accepted call answers, so ten seconds
       * without a single batch means the lane is dead, not quiet.
       * The cure is the recycle that already exists — make-before-break, one
       * round trip — and if three of those change nothing then it is not the
       * connection that is broken, it is the session under it.
       */
      if (wants_call && runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
          runtime.voicelab.has_connection_capability &&
          !runtime.voicelab.recycle_pending && outbox_free >= 4U &&
          runtime.voicelab.last_batch_ms != 0U &&
          iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_batch_ms) > DOWNLINK_SILENCE_MS) {
        ++runtime.downlink_recycles;
        if (runtime.downlink_recycles_running >= 3U) {
          ESP_LOGE(
              tag,
              "downlink still dead after 3 recycles — replacing the session");
          runtime.downlink_recycles_running = 0U;
          iterate_kit_esp_idf_itx_transport_request_restart(&transport);
        } else {
          ++runtime.downlink_recycles_running;
          ESP_LOGW(
              tag,
              "nothing delivered for %us with a call wanted — recycling the "
              "connection (%u)",
              (unsigned int)(DOWNLINK_SILENCE_MS / 1000U),
              (unsigned int)runtime.downlink_recycles_running);
          /*
           * Stamp the deadline forward NOW. The recycle is asynchronous and
           * this poll runs 200 times a second; without it every iteration
           * until the successor resolves would open another connection.
           */
          runtime.voicelab.last_batch_ms = now;
          (void)iterate_kit_voicelab_recycle_connection(&runtime.voicelab);
        }
      }
      /* Any delivery at all means the lane recovered; forget the escalation. */
      if (runtime.downlink_recycles_running > 0U &&
          runtime.voicelab.batches_on_connection > 0U) {
        runtime.downlink_recycles_running = 0U;
      }

      /*
       * call_pending is a promise that something will answer, and promises
       * expire. It is cleared by conversation-accepted or by the start RPC failing —
       * so a start whose reply is simply lost (the session died underneath
       * it, the bridge never came up) latched it true forever, and the
       * reconcile below never ran again. The device then waits, with a call
       * it wants and no call, for as long as it is left on.
       */
      if (runtime.voicelab.call_pending && call_pending_since != 0U &&
          iterate_kit_voice_elapsed_ms(now, call_pending_since) > 20000U) {
        ESP_LOGW(tag, "call start went unanswered for 20s — trying again");
        iterate_kit_voicelab_forget_call(&runtime.voicelab);
        call_pending_since = 0U;
        iterate_kit_launch_retry_now(&launch);
      }
      if (!runtime.voicelab.call_pending) call_pending_since = 0U;

      /*
       * The obituary grace is armed HERE, before the ladder ever sees the
       * fall: the fall and the ladder share a pass, and arming it in the
       * display reconcile sixty lines below let the ladder place the
       * zombie first — measured twice, 126 ms and 87 ms end-to-relaunch.
       * `call_active_shown` still carries last pass's value at this point;
       * the display reconcile below is what updates it.
       */
      if (call_active_shown && !runtime.voicelab.call_active && wants_call) {
        runtime.obituary_grace_until_ms = now + 1500U;
      }
      /*
       * GETTING INTO A CALL. The ladder — prepare ahead, prepare now, place —
       * and its three separate deadlines live in conversation_launch.c, which
       * every board shares and which is tested on the host.
       */
      {
        const struct iterate_kit_launch_inputs launching = {
            .call_active = runtime.voicelab.call_active,
            .call_pending = runtime.voicelab.call_pending,
            .link_ready = outbox_free >= 3U,
            .now_ms = now,
            /* Masked, not cleared: if the obituary lands during the grace it
             * clears the intent itself; if none comes, the want resumes. */
            .wants_call =
                wants_call && now >= runtime.obituary_grace_until_ms,
        };
        runtime.last_launch_step = (int)iterate_kit_launch_next_step(&launch, &launching);
        ++runtime.launch_polls;
        runtime.saw_wants_call = launching.wants_call;
        runtime.saw_link_ready = launching.link_ready;
        if (launching.wants_call) ++runtime.wants_call_polls;
        switch ((enum iterate_kit_launch_step)runtime.last_launch_step) {
          case ITERATE_KIT_LAUNCH_PLACE_CALL:
            call_pending_since = now;
            /*
             * KEEP THE REFUSAL. This discarded the status, so a start that
             * failed was indistinguishable from one that was never attempted:
             * a board sat wanting a call with every launch gate green and
             * nothing anywhere said why.
             */
            runtime.last_start_status =
                iterate_kit_voicelab_start_call(
                    &runtime.voicelab, runtime.facts->greeting);
            if (runtime.last_start_status == CAPNWEB_OK) {
              runtime.view.status = ("starting call");
              /*
               * AND ASK THE HOP, because the request above cannot report its
               * own delivery. It is a Cap'n Web call whose reply arrives only
               * if the far side is still there, and into a half-open socket it
               * simply never returns — accepted by TCP, READY transport, ten
               * seconds of silence before anything notices. The probe is armed
               * HERE and nowhere else: a press is the only event on this device
               * that makes a stale socket expensive, and an idle board must
               * stay silent or the Durable Object behind it never hibernates.
               */
              arm_press_probe(now, runtime.pongs_seen);
            } else {
              ++runtime.start_call_failures;
            }
            break;
          case ITERATE_KIT_LAUNCH_NOTHING:
          default:
            break;
        }
      }
      if (!wants_call && runtime.voicelab.call_active && outbox_free >= 3U) {
        /*
         * ENDING A CALL ABANDONS WHATEVER WAS PLAYING.
         *
         * Same reasoning as the barge-in flush: the ring still holds the last
         * 90ms of an answer nobody will hear the rest of, and it drains while
         * the speaker task sits armed. That gap was counted as starvation on
         * every hang-up-mid-answer — send index 44 in the run that showed it.
         * Ours, intended, and declared at the moment we cause it.
         */
        board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
        (void)iterate_kit_voicelab_end_call(&runtime.voicelab, "button");
        runtime.view.status = ("call ended");
        runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
      }
      if (runtime.voicelab.call_active &&
          runtime.voicelab.call_active != call_active_shown) {
        runtime.speaker_margin_min_ms = 0U;
        runtime.speaker_writes = 0U;
      }
      if (runtime.voicelab.call_active != call_active_shown) {
        /*
         * The call fell while still WANTED and no obituary explained it —
         * either a genuine connection recycle, or a far-end hang-up whose
         * conversation-ended is still in flight. Hold the relaunch long
         * enough to tell them apart; see `obituary_grace_until_ms`.
         */
        if (call_active_shown && !runtime.voicelab.call_active && wants_call) {
          runtime.obituary_grace_until_ms = now + 1500U;
        }
        call_active_shown = runtime.voicelab.call_active;
        runtime.view.call_active = (call_active_shown);
        /*
         * Belt to on_control's braces: a call forgotten for lost liveness
         * never sends CALL_ENDED, and the envelope mouth must not stay gated
         * on a call that no longer exists. Idempotent when on_control already
         * flipped it.
         */
        if (call_active_shown) {
          /*
           * Display only. Emptying the speaker for a new call lives in
           * on_control's CALL_ACCEPTED branch, on the receive path the audio
           * arrives on — this observation runs later and could follow the
           * call's first frame.
           */
          runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
          runtime.view.status = runtime.facts->talk_hint;
        }
      }

      /*
       * TURN EDGES ARE PUSH-TO-TALK'S, AND ONLY PUSH-TO-TALK'S.
       *
       * A marker is not a notification, it is an instruction: `ptt-start`
       * tells the far side `input_audio_buffer.clear` and re-accepts the call,
       * and `ptt-end` sends `input_audio_buffer.commit` + `response.create`
       * with no server-VAD guard on either. On a board whose microphone rides
       * the open call that is wrong twice — the call request ALREADY sent the
       * one `ptt-start` such a board owes, carrying the client path that is
       * what selects server VAD on the far side, so a second one throws away
       * audio the provider had buffered mid-conversation; and a commit forces
       * an answer to a turn the provider's own VAD is responsible for closing.
       *
       * Neither open-mic board published either marker before it ran this
       * loop, and the whole edge machine below — the maximum-length bound, the
       * press, the release, the tail flush — is the same shape: it describes a
       * BUTTON. An open-mic board has none, so its `talking` follows the call
       * and nothing else.
       */
      const bool marks_turns =
          turn_policy == ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK;
      /*
       * DIAL-TIME SPEECH IS BUFFERED, NOT SENT AND NOT DROPPED. While a
       * call is wanted-but-not-active and the posture says the person is
       * talking (open mic: the wake press itself; push-to-talk: the held
       * button), capture queues and the drain waits for the call. The
       * queue is reset once, at the moment buffering begins, so pre-press
       * room noise is dropped exactly where the press is.
       */
      {
        const bool buffering =
            wants_talk && !runtime.voicelab.call_active;
        if (buffering && !runtime.dial_buffering) {
          (void)xQueueReset(runtime.mic_queue); /* pre-press room noise */
          runtime.frame_sequence = 0U;
        }
        if (buffering && marks_turns) runtime.dial_speech_queued = true;
        /*
         * RELEASED DURING THE DIAL: THE SPEECH IS KEPT. This used to clear
         * `dial_speech_queued` on the release edge, on the doctrine that the
         * turn which would have carried the speech never opened. Reversed
         * 2026-08-20: from the moment the device starts listening, captured
         * audio is a promise — press from sleep, say "count to forty",
         * release, and a call that connects seconds later must answer those
         * words as its FIRST turn (the host CLI has always behaved this
         * way, because its dial is warm in a second). The queue holds
         * exactly the press-to-release speech — capture stops queueing when
         * `dial_buffering` falls — and the accept-side branch below the
         * turn-open branch drains it and commits the turn. A NEW press
         * still starts clean: the buffering rising edge above resets the
         * queue, so the kept speech can never prepend itself to a later
         * press's words — it is either carried by the call it dialled, or
         * replaced at the next press, or dies with the call (CALL_ENDED
         * clears the flag). The mint side keeps its own guard — a ptt-start
         * older than 30 s never mints — but the launch ladder re-presses
         * every 3 s, so a long dial still connects and still gets this
         * speech.
         */
        runtime.dial_buffering = buffering;
      }
      if (!marks_turns) {
        /*
         * The microphone rides the call, so this is one edge, not two, and it
         * carries no wire traffic at all. The queue reset is the one thing the
         * press did that still applies: room noise captured before the call
         * came up is not part of it.
         */
        if (runtime.talking != wants_talk) {
          runtime.talking = wants_talk;
          runtime.view.listening = wants_talk;
          if (wants_talk) {
            (void)xQueueReset(runtime.mic_queue); /* pre-call room noise */
            runtime.frame_sequence = 0U;
            runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_LISTENING;
            runtime.view.status = ("listening");
          }
        }
      }
      /*
       * A turn is bounded no matter what. The talk button is read over a
       * shared I2C bus and the UI can request a turn remotely; either can
       * fail in a way that leaves the request stuck on. Rather than trust
       * both, the turn ends itself after a maximum length — nobody speaks
       * for a minute straight, and a wedged turn is worse than a truncated
       * one because nothing is ever sent for an answer.
       */
      if (marks_turns && runtime.talking && !runtime.flushing_turn &&
          iterate_kit_voice_elapsed_ms(now, runtime.turn_started_ms) > TURN_MAX_MS) {
        ESP_LOGW(tag, "turn exceeded %ums — ending it", (unsigned)TURN_MAX_MS);
        runtime.remote_talk = false;
        board_fence(false);
        runtime.flushing_turn = true;
        runtime.flush_frames_left = 0U;
        runtime.flush_deadline_ms = now;
      }
      if (marks_turns && wants_talk && !runtime.talking &&
          runtime.voicelab.call_active && outbox_free >= 3U) {
        /*
         * Pressing to talk abandons whatever is still playing, which is an
         * intentional flush like any other — and this site never disarmed the
         * starvation watch at all. The funnel also reprimes: the discard empties
         * the ring, so the next answer's first frame would otherwise play with
         * zero cushion and starve immediately, putting a hole at the START of
         * every answer after a turn.
         */
        (void)abandon_speaker_audio();
        if (!runtime.dial_speech_queued) {
          (void)xQueueReset(runtime.mic_queue); /* drop pre-press room noise */
          runtime.frame_sequence = 0U;
        }
        /* Consumed either way: only the turn that OPENED the call may keep
         * the dial buffer, and it just did. */
        runtime.dial_speech_queued = false;
        if (publish_turn_marker(ITERATE_KIT_VOICELAB_TURN_START)) {
          runtime.talking = true;
          runtime.turn_started_ms = now;
          runtime.flushing_turn = false;
          /*
           * THE HANDOFF: only now, with the turn marker on the wire and the
           * speaker queue emptied by the abandon above, may the microphone
           * take the pins. If the marker failed, nothing is taken and no turn
           * opens — which is the whole reason this sits inside the branch.
           */
          board_fence(true);
          ESP_LOGI(tag, "turn start");
          /*
           * The face attends and shuts its mouth. Told rather than inferred from
           * silence: the audio it was animating has just been discarded, and
           * without this the last shape of the interrupted word would sit on the
           * face for the whole time the person is speaking.
           */
          runtime.view.listening = (true);
          runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_LISTENING;
          runtime.view.status = ("listening — release to send");
        }
      }
      /*
       * THE BUTTON CAME UP WHILE THE CALL WAS STILL DIALLING, and the words
       * are already in the queue. The moment the accepted call can carry
       * them, open the turn they were always going to be: publish the turn
       * marker, mark the turn open, and let the release machinery directly
       * below — which sees `talking && !wants_talk` on this very pass —
       * flush the queue and send the commit exactly as it does for a live
       * release. The marker mirrors the held-through-connect path, which
       * also publishes a fresh ptt-start after CALL_ACCEPTED, so the far
       * side sees the same wire shape either way. `dial_speech_queued` is
       * consumed only once the marker is actually on the wire, so a full
       * outbox retries next pass instead of losing the words. The launch
       * ladder's 3 s re-press appends more durable ptt-starts while
       * dialling, but they all land BEFORE call_active — this branch runs
       * once per accepted call and owes exactly one commit.
       */
      if (marks_turns && !wants_talk && !runtime.talking &&
          runtime.voicelab.call_active && runtime.dial_speech_queued &&
          outbox_free >= 3U) {
        if (uxQueueMessagesWaiting(runtime.mic_queue) == 0U) {
          /*
           * A PROMISE WITH NO WORDS IN IT IS CONSUMED SILENTLY. The flag is
           * raised from intent — wanting the call while it dialled — but on
           * a board whose microphone only owns its pins behind the capture
           * fence (the stick), a dial can end with nothing captured. Opening
           * a turn here committed an EMPTY ptt-end and asked the provider to
           * answer silence — worse than the pre-buffering behaviour, which
           * simply stayed quiet until the next real press.
           */
          runtime.dial_speech_queued = false;
        } else {
          /* A turn opening is a barge like any other; on a call this fresh
           * the abandon is usually a no-op, but a greeting's first frames
           * must not play under the person's own turn. */
          (void)abandon_speaker_audio();
          if (publish_turn_marker(ITERATE_KIT_VOICELAB_TURN_START)) {
            runtime.dial_speech_queued = false;
            runtime.talking = true;
            runtime.turn_started_ms = now;
            runtime.flushing_turn = false;
            ESP_LOGI(tag, "turn start (dial speech, button already up)");
          }
        }
      }
      /*
       * Releasing does NOT commit immediately. The capture queue holds up to
       * 640 ms, and the sender only drains it 6 frames at a time — so
       * committing on the button edge threw away the tail of every
       * utterance, which is the last word or two of whatever was said. The
       * turn stays open until the queue is empty (or a bounded deadline
       * passes, so a stalled uplink cannot hang the turn forever), and only
       * then is the commit sent.
       */
      if (marks_turns && !wants_talk && runtime.talking &&
          !runtime.flushing_turn) {
        /*
         * Flush exactly what was captured UP TO the release, and no more.
         * Waiting for the queue to empty could not work: the capture task
         * keeps filling it every 20ms regardless, so "empty" was a race the
         * sender only won transiently — and four turns in ten hit the
         * deadline instead, dropping their tail.
         */
        runtime.flushing_turn = true;
        runtime.flush_frames_left =
            (uint32_t)uxQueueMessagesWaiting(runtime.mic_queue);
        runtime.flush_deadline_ms = now + TURN_FLUSH_TIMEOUT_MS;
        /*
         * The microphone's job ended at the RELEASE edge, so give the pins
         * back now rather than at the commit below — the answer can then play
         * the moment it arrives. Queued frames still flush; the fence only
         * stops NEW capture.
         */
        board_fence(false);
        runtime.view.status = "sending";
      }
      if (runtime.flushing_turn &&
          (runtime.flush_frames_left == 0U ||
           now >= runtime.flush_deadline_ms)) {
        const bool timed_out = runtime.flush_frames_left > 0U;
        runtime.talking = false;
        runtime.flushing_turn = false;
        ESP_LOGI(tag, "turn commit%s", timed_out ? " (tail dropped)" : "");
        /* Done listening: the face waits for the answer rather than for us. */
        runtime.view.listening = (false);
        if (publish_turn_marker(ITERATE_KIT_VOICELAB_TURN_COMMIT)) {
          runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_SPEAKING;
          runtime.view.status = ("thinking");
        }
      }

      /*
       * THE 180-SECOND REMOUNT WATCHDOG WAS HERE, restarting the transport
       * after any three quiet minutes because the platform once dropped
       * mounts silently. Measured 2026-08-20: that metronome was the fleet's
       * dominant Durable Object churn — one incarnation per board per cycle,
       * ~480/day/stream — and the platform faults it papered over have their
       * own reactive answers now (the voicelab-FAILED remount and the
       * mic-jam restart below, both keyed on evidence instead of a clock).
       * A quiet afternoon is allowed to be quiet.
       */

      /* The pressed-button audit, owed since its press, sent when the
       * session can carry it. */
      if (runtime.pending_button_audit != NULL && outbox_free >= 3U) {
        (void)iterate_kit_voicelab_note_button(
            &runtime.voicelab, runtime.pending_button_audit);
        runtime.pending_button_audit = NULL;
      }

      /* The microphone is only on the wire while the talk button is down. */
      {
        const size_t queued = uxQueueMessagesWaiting(runtime.mic_queue);
        /* A partial batch is only worth sending at the end of a turn. */
        const size_t needed =
            runtime.flushing_turn ? 1U : (size_t)MIC_FRAMES_PER_APPEND;
        /*
         * A MICROPHONE THAT CANNOT DRAIN INTO A LIVE CALL IS A DEAD LANE,
         * and the device is the only one who can tell: the appends are
         * one-way, so nothing upstream ever refuses them — they just
         * vanish. Measured 2026-08-19 16:07 after a DO storage reset: the
         * call dialled fine, capture ran, the queue filled and rolled
         * (micDropped 217), and the person's opening sentence aged out of
         * the 5 s buffer during the ~60 s the watchdog took to notice.
         * Half a queue with no headroom for three seconds is not
         * backpressure, it is the jam — restart the transport now.
         */
        {
          static uint64_t drain_jammed_since;
          const bool jammed = runtime.talking &&
              runtime.voicelab.call_active &&
              queued >= (size_t)(MIC_QUEUE_DEPTH / 2) &&
              outbox_free < (size_t)MIC_OUTBOX_RESERVE;
          if (!jammed) {
            drain_jammed_since = 0U;
          } else if (drain_jammed_since == 0U) {
            drain_jammed_since = now;
          } else if (
              iterate_kit_voice_elapsed_ms(now, drain_jammed_since) > 3000U) {
            ESP_LOGW(
                tag, "mic backlog with no outbox drain — restarting transport");
            runtime.view.status = ("re-registering");
            iterate_kit_esp_idf_itx_transport_request_restart(&transport);
            drain_jammed_since = 0U;
          }
        }
        /*
         * The window paces the uplink at exactly capture rate, so any
         * backlog is permanent — four of ten turns in one call hit the
         * flush deadline with audio still queued ("tail dropped"). When a
         * backlog exists, send immediately instead of waiting for the
         * window, so the sender can actually catch up.
         */
        const bool behind = queued >= (size_t)(MIC_FRAMES_PER_APPEND * 2U);
        /* `call_active &&`: dial-buffered speech leaves only once there is
         * a call to carry it. Push-to-talk already implied this through the
         * turn machinery; the open microphone now needs it said. */
        if (runtime.talking && runtime.voicelab.call_active &&
            (behind || now >= drain_window_at) &&
            queued >= needed && outbox_free >= (size_t)MIC_OUTBOX_RESERVE) {
          const size_t take = queued < (size_t)MIC_FRAMES_PER_APPEND
              ? queued
              : (size_t)MIC_FRAMES_PER_APPEND;
          /*
           * The window only advances on a batch that was actually sent. It
           * used to advance regardless, so a moment of outbox backpressure
           * silently dropped that speech instead of sending it a beat later —
           * the mic queue holds 640ms and is the right place to absorb this.
           */
          const uint8_t *frame_pointers[MIC_FRAMES_PER_APPEND];
          size_t index;
          drain_window_at =
              (drain_window_at == 0U ||
               iterate_kit_voice_elapsed_ms(now, drain_window_at) > MIC_FRAMES_PER_APPEND * FRAME_MS * 4U)
              ? now + (uint64_t)take * FRAME_MS
              : drain_window_at + (uint64_t)take * FRAME_MS;
          for (index = 0U; index < take; ++index) {
            (void)xQueueReceive(runtime.mic_queue, &frame_storage[index], 0);
            frame_pointers[index] =
                (const uint8_t *)frame_storage[index].samples;
          }
          (void)iterate_kit_voicelab_append_frames(
              &runtime.voicelab,
              frame_pointers,
              take,
              sizeof(frame_storage[0].samples),
              runtime.frame_sequence,
              now);
          runtime.frame_sequence += (uint32_t)take;
          runtime.flush_frames_left = runtime.flush_frames_left > take
              ? runtime.flush_frames_left - (uint32_t)take
              : 0U;
        }
      }
      /*
       * THE FACE, ASKED FOR ONLY WHILE THERE IS AUDIO TO MOVE A MOUTH FOR.
       *
       * The mouth is reduced state in the voice-agent processor's runtime bag
       * — `{answer, playoutSamples, viseme, confidence, at}` — and there is no
       * push path for a facet's contributed bag, so it has to be asked for.
       * That makes the GATE the whole design rather than a detail: a face
       * cannot change while nothing is playing, so the condition is the
       * speaker queue being non-empty, and an idle board therefore makes this
       * call exactly zero times. A poll on a plain timer would be the same
       * defect as the five-second telemetry heartbeat that was deleted to let
       * these Durable Objects hibernate.
       *
       * 100 ms, because a face rendered at 10 Hz looks fine and the
       * classifier's own output is sparser than that. It stops the moment the
       * queue drains — the tail of an answer is a resting mouth, which the
       * avatar already knows how to hold.
       *
       * Gated on outbox headroom like every other producer, and the stream
       * refuses a second poll while one is in flight.
       */
      if (runtime.board->observe_answer != NULL && outbox_free >= 4U &&
          speaker_queued_bytes() > 0U) {
        static uint64_t next_face_poll_at;
        if (now >= next_face_poll_at) {
          next_face_poll_at = now + ITERATE_KIT_VOICE_FACE_POLL_MS;
          (void)iterate_kit_voicelab_poll_face(&runtime.voicelab);
        }
      }
      /*
       * Recycling opens a NEW connection — a TLS-backed round trip — inline
       * on this task, which is the same task that decodes speaker PCM. The
       * steady-state cushion is only the 160 ms prefill plus ~90 ms of DMA,
       * so a recycle mid-answer starves the DAC and costs an audible hole.
       * At ~600 batches that lands roughly 12 s into every answer and again
       * every 12 s after — "it gets worse as the session goes on".
       *
       * So it waits for a quiet moment: no audio queued and nothing being
       * spoken. The budget it is racing is ~1000 pushes and it becomes due
       * at 600, so there is ample room to wait for a gap between turns.
       */
      if (outbox_free >= 4U &&
          iterate_kit_voicelab_needs_recycle(&runtime.voicelab)) {
        const bool speaker_idle = speaker_queued_bytes() == 0U;
        if ((speaker_idle && !runtime.talking) ||
            runtime.voicelab.batches_on_connection >
                ITERATE_KIT_VOICELAB_RECYCLE_AFTER_BATCHES + 250U) {
          (void)iterate_kit_voicelab_recycle_connection(&runtime.voicelab);
        }
      }
      /*
       * A one-second pulse while a turn is open. When the device freezes
       * mid-turn nothing else can be read out of it — health() is answered by
       * this very task — so this is the only way to tell a stalled APP task
       * from a stalled TRANSPORT: if the pulse keeps printing, the loop is
       * running and the network is stuck; if it stops, the loop is.
       */
      /*
       * The pulse used to cover only the TURN, which is the half of a
       * conversation that was already working. Choppy playback lives in the
       * other half: it needs received-versus-played-versus-concealed and how
       * much audio was standing in the ring, once a second, while the answer
       * is happening. A count taken afterwards cannot show a lane that
       * delivered 240ms and then went quiet for two seconds, which is what
       * a listener hears as clipping in and out.
       */
      if (runtime.talking || runtime.voicelab.call_active ||
          iterate_kit_voice_elapsed_ms(now, runtime.last_pulse_ms) < 3000U) {
        if (iterate_kit_voice_elapsed_ms(now, runtime.last_pulse_ms) >= 1000U) {
          struct iterate_kit_esp_idf_itx_transport_metrics pulse;
          iterate_kit_esp_idf_itx_transport_metrics(&transport, &pulse);
          runtime.last_pulse_ms = now;
          ESP_LOGI(
              tag,
              "pulse loops=%" PRIu32 " outbox=%u/%u inPub=%" PRIu32
              " inCon=%" PRIu32 " sent=%" PRIu32 " frames=%" PRIu32
              " | batches=%" PRIu32 " rx=%" PRIu32 " bad=%" PRIu32
              " played=%" PRIu32 " conceal=%" PRIu32 " under=%" PRIu32
              " ringMs=%u",
              runtime.loop_count,
              (unsigned int)outbox_metrics.current_slots,
              (unsigned int)CONTROL_OUTBOX_SLOTS,
              pulse.control_inbox.messages_published,
              pulse.control_inbox.messages_consumed,
              pulse.control_messages_sent,
              runtime.voicelab.frames_sent,
              runtime.voicelab.batches_on_connection,
              runtime.voicelab.spk_frames_received,
              runtime.voicelab.spk_decode_failures,
              runtime.speaker_frames_played,
              runtime.speaker_conceal_frames,
              runtime.speaker_underruns,
              (unsigned int)(speaker_queued_bytes() / 32U));
        }
      }
    }

    ++runtime.loop_count;
  }
  /*
   * The meter, carried across from the capture task exactly here — one
   * relaxed load per pass, on the task that owns the view, immediately before
   * the view is shown. Anywhere earlier and a board renders a peak one whole
   * app-loop pass old for no reason.
   */
  runtime.view.microphone_peak =
      atomic_load_explicit(&runtime.mic_peak, memory_order_relaxed);
  /*
   * SHOW IT, LAST AND ALWAYS.
   *
   * Everything above assembles one view; this is the single place it reaches
   * the hardware. Unconditional, because the board's own comparison is cheaper
   * than the nine lock round trips the setters used to cost, and because three
   * of the four panels are pumped by their caller and this is that pump.
   */
  present();
}

void iterate_kit_voice_loop_run(
    const struct iterate_kit_board_ops *ops,
    const struct iterate_kit_board_facts *facts,
    void *context) {
  if (!iterate_kit_voice_loop_init(ops, facts, context)) {
    /*
     * Nothing is up yet — no panel, no watchdog subscription — so there is
     * nowhere to park and nothing to park on. The caller returns to its setup
     * path, which is what an unprovisioned board is supposed to do.
     */
    ESP_LOGE(tag, "voice loop refused its board");
    return;
  }
  for (;;) {
    iterate_kit_voice_loop_step(now_ms(NULL));
    DELAY_MS(5);
  }
}

void iterate_kit_voice_loop_set_stream_path(const char *path) {
  if (path == NULL || path[0] == '\0') return;
  if (strcmp(stream_path, path) == 0) return;
  (void)snprintf(stream_path, sizeof(stream_path), "%s", path);
  /*
   * The path is read once per mount — `streams.get(stream_path)` — so a
   * voicelab that is already up is holding the OLD conversation. Close it and
   * zero the generation: the standing remount arm sees the generations
   * disagree and rebuilds on the same connection at the new path within a
   * pass, exactly as the failed-with-a-ready-connection branch already does.
   * Before the first mount both conditions are already false and this is
   * nothing but the copy above.
   */
  if (runtime.voicelab.state != ITERATE_KIT_VOICELAB_IDLE &&
      runtime.voicelab.state != ITERATE_KIT_VOICELAB_CLOSED) {
    (void)iterate_kit_voicelab_close(&runtime.voicelab);
  }
  runtime.voicelab_generation = 0U;
}

void iterate_kit_voice_loop_set_turns(enum iterate_kit_voice_turns turns) {
  turn_policy = turns;
}
