/*
 * The shared ESP voice loop. One transport carries activation-tagged microphone
 * frames and speaker control/audio. Capture and playback run in dedicated tasks;
 * app-task callbacks coordinate their generations and presentation.
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
#ifdef ESP_PLATFORM
#include "esp_random.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "capnweb/capnweb.h"
#include "iterate/kit/audio_codec.h"
#include "iterate/kit/retry_gate.h"
#include "iterate/kit/platforms/esp_idf_reset_reason.h"
#include "iterate/kit/capabilities/system_update.h"
#include "iterate/kit/platforms/esp_idf_restart_note.h"
#include "iterate/kit/platforms/esp_idf_system_update.h"
#include "iterate/kit/capabilities/conversation.h"
#include "iterate/kit/capabilities/health.h"
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
#include "iterate/kit/microphone_flush.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voicelab_stream.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_playout.h"

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
  /* Token storage for a full inbound control batch. */
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
   * the screen sits on "listening". Measured: every opening turn died
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
  TERMINAL_PENDING_CAPACITY = 2U,
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
  /* One local activation gets one finite opening attempt. */
  OPENING_DEADLINE_MS = 20000U,
  MIC_QUEUE_DEPTH = ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH,
  /* Covers WakeNet plus board-poll handoff without retaining idle room audio. */
  MIC_PRE_ROLL_FRAMES = 25,
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
  /* Shared measured opening budget; capacity above is not a playback delay. */
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
  /* Longest a single spoken turn may run before it is closed regardless. */
  /* Control scan cadence; on one board each scan costs an I2C transaction. */
  CONTROL_POLL_MS = ITERATE_KIT_VOICE_CONTROL_POLL_MS,
  /* How long the transport may stay FAILED before the device reboots itself. */
  UNHEALTHY_RESTART_MS = ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS,
  /* No inbound traffic while a call is wanted means the delivery lane is stale. */
  DOWNLINK_SILENCE_MS = ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS,
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

/* Mutable paths used while mounting the board's stream. */
static char stream_path[96];
static char client_path[96];

enum opening_outcome {
  OPENING_IDLE = 0,
  OPENING_WAITING,
  OPENING_ACCEPTED,
  OPENING_TIMED_OUT,
};

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
  /** What the board's controls requested on this pass. */
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
  /* Remote control events share the local intent path. */
  struct iterate_kit_device_event device_event_storage
      [ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY];
  struct iterate_kit_device_event_queue device_events;
  struct iterate_kit_conversation_control conversation_control;
  struct iterate_kit_voicelab voicelab;
  /* Local answer epoch for the face timeline. */
  uint32_t answers_started;
  /** Answers that replaced speaker audio not yet heard. */
  uint32_t answers_superseded_midplay;
  /* Replacement controls observed, and the time of the latest one. */
  uint32_t speaker_drops;
  uint32_t last_drop_uptime_ms;
  uint32_t voicelab_generation;
  /* Health serialization must fit completely; truncation is not sent. */
  char stats_buffer[2816];
  uint32_t stats_sequence;
  enum iterate_kit_esp_idf_itx_transport_state last_transport_state;
  enum iterate_kit_voicelab_state last_voicelab_state;
  /* Cross-task audio plumbing. */
  QueueHandle_t mic_queue;
  QueueHandle_t speaker_queue;
  atomic_uint speaker_generation;
  atomic_uint_fast64_t speaker_last_write_ms;
  /* Written by accepted playout, read when the app task assembles the view. */
  atomic_uint speaker_peak;
  atomic_uint_fast64_t speaker_peak_at_ms;
  /*
   * The playback step's persistent state — the shared playout clock, its
   * counters and the last write — written only by the playback task. The
   * step itself is shared with the host CLI: iterate/kit/voice_playout.h.
   */
  struct iterate_kit_voice_playout playout;
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
   * A starve is only a DEFECT if the stream had more to say. The buffer
   * legitimately empties at the end of every answer, and counting that as an
   * underrun made the metric read one per answer no matter how healthy the
   * pipe was — which is exactly the sort of false positive that hides a real
   * one. A starve is promoted to an underrun only when audio resumes soon
   * after it, meaning the answer was still in progress.
   */
  uint32_t speaker_underruns;
  uint32_t speaker_bad_frames;
  /* Connections replaced because nothing was being delivered on them. */
  uint32_t downlink_recycles;
  /* How many of those in a row have not yet produced a batch. */
  uint32_t downlink_recycles_running;
  /* Diagnostics for a frozen device: see the pulse in the app loop. */
  uint32_t loop_count;
  uint64_t last_pulse_ms;
  uint64_t mic_flushed_at_ms;
  /* The app opens/closes capture; only the capture task mutates these queues. */
  atomic_bool capture_open;
  atomic_bool capture_muted;
  atomic_bool capture_discard_requested;
  atomic_uint capture_generation;
  uint32_t capture_generation_inflight;
  atomic_bool capture_activation_overflow;
  atomic_uint capture_activation_overflows;
  char activation[33];
  bool activation_live;
  struct {
    char activation[33];
    const char *reason;
  } pending_terminals[TERMINAL_PENDING_CAPACITY];
  size_t pending_terminal_head;
  size_t pending_terminal_count;
  /* Monotonic local time of the current/most recent activation. */
  uint64_t activation_started_at_ms;
  /* Zero until a microphone append was accepted for that activation. */
  uint64_t first_mic_append_at_ms;
  /* Nonzero while the current activation is opening. */
  uint64_t opening_started_at_ms;
  enum opening_outcome opening_outcome;
  uint32_t opening_timeouts;
  struct mic_frame mic_pre_roll[MIC_PRE_ROLL_FRAMES];
  size_t mic_pre_roll_next;
  size_t mic_pre_roll_count;
  /* Release pressed, but the capture queue is not yet on the wire. */
  atomic_bool speaker_reprime;
  /* The answer's playout timeline — when it began, how much has played, the
   * worst lag — is `playout.clock`'s, shared with the host CLI; see
   * iterate/kit/voice_playback_clock.h. */
  /* One atomic epoch notification: reprime cannot erase a newer short answer
   * terminal. UINT32_MAX means no pending terminal. */
  atomic_uint speaker_answer_done_generation;
  /*
   * The SENDER said this answer is complete, latched until the speaker actually
   * drains it. `speaker_answer_done_generation` is consumed by the playback clock the
   * moment it is seen, long before the buffer empties, so it cannot answer
   * "has this answer finished being heard?" — and that question is the whole
   * difference between an answer that ended and an answer that was cut off.
   */
  atomic_bool answer_declared_done;
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

static void board_playout(const int16_t *pcm, size_t samples) {
  if (runtime.board->observe_playout != NULL) {
    runtime.board->observe_playout(runtime.board_context, pcm, samples);
  }
}

static uint32_t pcm_peak(const int16_t *samples, size_t sample_count) {
  int32_t peak = 0;
  for (size_t index = 0U; index < sample_count; ++index) {
    const int32_t sample = samples[index];
    const int32_t magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
  }
  return (uint32_t)peak;
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


/* --- speaker path (voicelab callbacks run on the app task) ---------------- */

/* Admit one paced speaker frame to the local playout queue. */
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
      &runtime.speaker_answer_done_generation, UINT32_MAX, memory_order_release);
  /* Speaker state follows admitted audio. */
  runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_SPEAKING;
  /*
   * Audio arriving within a second of a starve means the answer was still
   * going: the pipe genuinely ran dry mid-speech, and that is audible. The
   * rule is the clock's, shared with the host CLI.
   */
  if (iterate_kit_voice_playback_clock_audio_arrived(
          &runtime.playout.clock, now_ms(NULL))) {
    ++runtime.speaker_underruns;
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

/* Assemble arbitrary wire chunks into fixed-size speaker queue frames. */
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
  atomic_store_explicit(&runtime.speaker_peak, 0U, memory_order_relaxed);
  atomic_store_explicit(&runtime.speaker_peak_at_ms, 0U, memory_order_release);
  /*
   * AND THE ANSWER'S CLOCK GOES WITH ITS AUDIO — carried by the reprime the
   * playback task applies before its next frame: the playout clock owns the
   * answer's timeline, and `iterate_kit_voice_playback_clock_reprime` starts
   * it from zero. It used to be reset here by hand, in the funnel rather than
   * at the flush sites, because it had first been written at ONE of the four
   * and a new CALL then kept the last call's clock — 34 frames skipped with
   * `spkLagMaxMs` at 117,083 on the StackChan. Now neither a site nor a
   * funnel can forget it: whatever primes the clock resets the timeline.
   */
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

static void end_local_activation(const char *reason, const char *status);
static void end_authoritative_activation(const char *status);

static void on_control(
    void *context, enum iterate_kit_voicelab_control control) {
  (void)context;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    /* Replacement precedes its new audio. Abandoning resets the playout clock
     * and disarms its starvation accounting on this task. */
    if (abandon_speaker_audio() > 0U) ++runtime.answers_superseded_midplay;
    ++runtime.answers_started;
    /* Timestamp the local observation for health diagnostics. */
    ++runtime.speaker_drops;
    runtime.last_drop_uptime_ms = (uint32_t)(esp_timer_get_time() / 1000);
    atomic_store_explicit(
        &runtime.answer_declared_done, false, memory_order_release);
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
        &runtime.speaker_answer_done_generation,
        atomic_load_explicit(&runtime.speaker_generation, memory_order_acquire),
        memory_order_release);
    atomic_store_explicit(
        &runtime.answer_declared_done, true, memory_order_release);
    /* The terminal control follows the final frame; let queued audio drain. */
    /* The answer is complete: back to waiting for the next turn. */
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
    runtime.view.status = "ready";
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    /* A newly accepted call must not inherit prior speaker audio. */
    (void)abandon_speaker_audio();
    atomic_store_explicit(
        &runtime.speaker_answer_done_generation, UINT32_MAX, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_declared_done, false, memory_order_release);
    ESP_LOGI(tag, "new call accepted: speaker queue emptied for a fresh sender");
    runtime.view.call_active = (true);
    runtime.opening_started_at_ms = 0U;
    runtime.opening_outcome = OPENING_ACCEPTED;
    /* The viseme lane owns the mouth for the duration of the call. */
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
    runtime.view.status = "ready";
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    /* An authoritative end abandons queued audio and its accounting. */
    (void)abandon_speaker_audio();
    end_authoritative_activation("call ended");
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
  /*
   * The done flags go with the OLD answer only. A `last` that already
   * arrived for the answer this reprime opens (same generation) is the new
   * answer's end, and wiping it would leave a short answer priming forever —
   * see `speaker_answer_done_generation`.
   */
  /*
   * abandon_speaker_audio() already disarmed and accounted for the hardware
   * flush before publishing speaker_reprime. This task owns only the portable
   * playout clock, so it resets that clock exactly once for the new epoch.
   */
  iterate_kit_voice_playback_clock_reprime(playout_clock);
  return true;
}

/*
 * THE BOARD'S RING AND SINK, AS THE SHARED PLAYOUT STEP SEES THEM.
 *
 * The step — iterate/kit/voice_playout.h — is the sequence this board and the
 * host CLI both run: prime, take one frame, treat a dry ring as a hole or the
 * end, skip a late frame with backlog behind it, hand the rest to the
 * speaker, report what was played. It used to be written here and again in
 * the CLI, and the two drifted apart twice. What is below is only what is
 * the board's alone: the FreeRTOS queue with its generations and reprime
 * handshake, and the codec write with its bounded wait for DMA headroom.
 */

/* The frame in flight between the queue and the codec. File-scope so the
 * write callback sees the generation the read callback received it with. */
static struct speaker_frame playout_item;

static uint32_t playout_ring_queued_bytes(void *context) {
  (void)context;
  return speaker_queued_bytes();
}

static enum iterate_kit_voice_playout_read playout_ring_read(
    void *context, const uint8_t **frame, size_t *length) {
  (void)context;
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
   * A dry ring is legitimate only after its terminal control; then
   * `answer_declared_done` stays latched until the tail drains.
   *
   * Arming happens at the write. Between a write and the next one the watch is
   * on; past a declared end it is off; during priming, a reprime flush or a
   * fully skipped frame it is off because we are deliberately not feeding.
   */
  if (atomic_load_explicit(
          &runtime.answer_declared_done, memory_order_acquire)) {
    board_phase(ITERATE_KIT_VOICE_PHASE_DRAINING);
  }
  if (xQueueReceive(
          runtime.speaker_queue,
          &playout_item,
          pdMS_TO_TICKS(runtime.facts->speaker_dry_wait_ms)) != pdTRUE) {
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
     * Hence no `conceal` on this board's sink: the step counts the hole and
     * inserts nothing.
     *
     * "The answer has finished being HEARD" was once reported to the
     * classifier from here; that distinction is now measured where the audio
     * is actually thrown away (an abandon with bytes queued is a supersede,
     * with an empty queue the gap between turns).
     */
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    return ITERATE_KIT_VOICE_PLAYOUT_READ_DRY;
  }

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
  if (playback_apply_reprime(&runtime.playout.clock)) {
    /*
     * A replacement can wake the blocked receive with its first frame. Put
     * that whole tagged frame back at the head so opening prefill includes
     * it. If another replacement raced this one, its generation is already
     * stale and it must not be reintroduced after the newer queue reset.
     */
    if (playout_item.generation == atomic_load_explicit(
                                       &runtime.speaker_generation,
                                       memory_order_acquire)) {
      if (xQueueSendToFront(runtime.speaker_queue, &playout_item, 0) !=
          pdTRUE) {
        (void)atomic_fetch_add_explicit(
            &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
      }
    } else {
      (void)atomic_fetch_add_explicit(
          &runtime.speaker_discarded_frames, 1U, memory_order_relaxed);
    }
    return ITERATE_KIT_VOICE_PLAYOUT_READ_ABANDONED;
  }

  if (playout_item.generation != atomic_load_explicit(
                                     &runtime.speaker_generation,
                                     memory_order_acquire)) {
    /* A replacement raced this frame after it left the synchronized queue. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_discarded_frames, 1U, memory_order_relaxed);
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    return ITERATE_KIT_VOICE_PLAYOUT_READ_ABANDONED;
  }

  *frame = (const uint8_t *)playout_item.samples;
  *length = sizeof(playout_item.samples);
  return ITERATE_KIT_VOICE_PLAYOUT_READ_FRAME;
}

static uint64_t playout_sink_now_ms(void *context) {
  (void)context;
  return now_ms(NULL);
}

static enum iterate_kit_voice_playout_write playout_sink_write(
    void *context, const uint8_t *frame, size_t length) {
  enum iterate_kit_status write_status;
  const uint64_t write_deadline_ms = now_ms(NULL) + 100U;
  (void)context;
  (void)frame; /* it is playout_item.samples; the generation rides with it */
  board_phase(ITERATE_KIT_VOICE_PHASE_FEEDING);
  /*
   * Admission is nonblocking. The hardware-owner task reserves the DMA
   * ledger immediately before its blocking write; this task waits at most
   * five frame periods for bounded queue headroom and keeps running the
   * stream protocol independently of the codec driver's pacing.
   */
  do {
    if (atomic_load_explicit(
            &runtime.speaker_reprime, memory_order_acquire) ||
        playout_item.generation != atomic_load_explicit(
                                       &runtime.speaker_generation,
                                       memory_order_acquire)) {
      /* A replacement answer arrived while this stale frame waited. */
      write_status = ITERATE_KIT_UNAVAILABLE;
      break;
    }
    write_status = iterate_kit_audio_codec_write(
        &runtime.codec, playout_item.samples, length / 2U);
    if (write_status == ITERATE_KIT_BACKPRESSURE) {
      DELAY_MS(1);
    }
  } while (write_status == ITERATE_KIT_BACKPRESSURE &&
           now_ms(NULL) < write_deadline_ms);

  if (write_status == ITERATE_KIT_OK) {
    /*
     * The meter and mouth observe audio admitted to the codec, never merely
     * received from the network. It may still sit in DMA before it is heard,
     * which is why this is a local playout signal rather than an acoustic one.
     */
    atomic_store_explicit(
        &runtime.speaker_peak,
        pcm_peak(playout_item.samples, length / sizeof(playout_item.samples[0])),
        memory_order_relaxed);
    atomic_store_explicit(
        &runtime.speaker_peak_at_ms, now_ms(NULL), memory_order_release);
    board_playout(playout_item.samples, length / sizeof(playout_item.samples[0]));
    return ITERATE_KIT_VOICE_PLAYOUT_WRITE_OK;
  }
  if (write_status == ITERATE_KIT_UNAVAILABLE &&
      atomic_load_explicit(&runtime.speaker_reprime, memory_order_acquire)) {
    /* Intentional replacement, not a codec failure. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_discarded_frames,
        (uint32_t)(length / (FRAME_SAMPLES * sizeof(int16_t))),
        memory_order_relaxed);
    return ITERATE_KIT_VOICE_PLAYOUT_WRITE_ABANDONED;
  }
  /* The bounded hardware path did not admit this frame. */
  return ITERATE_KIT_VOICE_PLAYOUT_WRITE_FAILED;
}

static const struct iterate_kit_voice_playout_ring playout_ring = {
  .context = NULL,
  .queued_bytes = playout_ring_queued_bytes,
  .read = playout_ring_read,
};

static const struct iterate_kit_voice_playout_sink playout_sink = {
  .context = NULL,
  .now_ms = playout_sink_now_ms,
  .write = playout_sink_write,
  .conceal = NULL, /* the DAC clocks out its own zeros; see the dry read */
};

/*
 * ONE PASS OF THE SPEAKER, so that it is a function rather than a `for(;;)`.
 *
 * A step can be called, and therefore tested, and therefore driven by a host
 * that has one thread where a board has three. The pass itself is the shared
 * step; what is here is the board's handshake around it and the board's
 * response to what it decided.
 */
void iterate_kit_voice_loop_playback_step(void) {
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
   * rather than concealed — see the read callback above.
   */

  (void)playback_apply_reprime(&runtime.playout.clock);
  if (atomic_exchange_explicit(
          &runtime.speaker_answer_done_generation, UINT32_MAX,
          memory_order_acq_rel) ==
      atomic_load_explicit(&runtime.speaker_generation, memory_order_acquire)) {
    iterate_kit_voice_playback_clock_answer_done(&runtime.playout.clock);
  }

  switch (iterate_kit_voice_playout_step(
      &runtime.playout, &playout_ring, &playout_sink)) {
  case ITERATE_KIT_VOICE_PLAYOUT_PRIMING:
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
    /* Idle, not starving: nothing is playing, so write nothing. */
    if (runtime.playout.last_write_ms != 0U &&
        iterate_kit_voice_elapsed_ms(now_ms(NULL), runtime.playout.last_write_ms) >
            SPEAKER_IDLE_POWERDOWN_MS) {
      board_phase(ITERATE_KIT_VOICE_PHASE_QUIET);
    }
    DELAY_MS(5);
    return;
  case ITERATE_KIT_VOICE_PLAYOUT_STARVED:
    /*
     * A hole mid-answer. The step counted it (`spkSoftDryTicks`: how often
     * the source could not keep up; it no longer costs the listener anything)
     * and the clock stamped it, so the admit path promotes it to an underrun
     * if audio resumes within a second — a hole in an answer still going.
     */
    return;
  case ITERATE_KIT_VOICE_PLAYOUT_SETTLED:
    /*
     * SETTLED BACK TO PRIMING, which is this device's own proof that no
     * answer is in flight — and the clock forgot the answer's timeline on
     * that same WAIT, so nothing is late. That reset needs no cooperation
     * from the sender: `drop` covers the answer that replaces a LIVE one;
     * this covers every ordinary turn, including the ones where `drop`
     * arrives a few chunks late — measured on the StackChan, where 800 ms of
     * a new answer was delivered ahead of the clear that was supposed to
     * precede it.
     */
    return;
  case ITERATE_KIT_VOICE_PLAYOUT_ABANDONED:
  case ITERATE_KIT_VOICE_PLAYOUT_SKIPPED:
    return;
  case ITERATE_KIT_VOICE_PLAYOUT_PLAYED:
  case ITERATE_KIT_VOICE_PLAYOUT_REPLACED:
  case ITERATE_KIT_VOICE_PLAYOUT_REFUSED:
    atomic_store_explicit(
        &runtime.speaker_last_write_ms, runtime.playout.last_write_ms,
        memory_order_release);
    return;
  }
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

/* Capture owns both the rolling wake history and the activation FIFO. */
static void capture_reset_audio(void) {
  (void)xQueueReset(runtime.mic_queue);
  runtime.mic_pre_roll_next = 0U;
  runtime.mic_pre_roll_count = 0U;
}

static void capture_remember(const int16_t *samples) {
  memcpy(
      runtime.mic_pre_roll[runtime.mic_pre_roll_next].samples, samples,
      sizeof(runtime.mic_pre_roll[0].samples));
  runtime.mic_pre_roll_next =
      (runtime.mic_pre_roll_next + 1U) % MIC_PRE_ROLL_FRAMES;
  if (runtime.mic_pre_roll_count < MIC_PRE_ROLL_FRAMES) {
    ++runtime.mic_pre_roll_count;
  }
}

static bool capture_open_activation(void) {
  const size_t first =
      (runtime.mic_pre_roll_next + MIC_PRE_ROLL_FRAMES -
       runtime.mic_pre_roll_count) % MIC_PRE_ROLL_FRAMES;
  for (size_t index = 0U; index < runtime.mic_pre_roll_count; ++index) {
    const size_t slot = (first + index) % MIC_PRE_ROLL_FRAMES;
    if (xQueueSend(runtime.mic_queue, &runtime.mic_pre_roll[slot], 0) != pdTRUE) {
      return false;
    }
  }
  runtime.mic_pre_roll_count = 0U;
  return true;
}

static uint32_t activation_random(void) {
#ifdef ESP_PLATFORM
  return esp_random();
#else
  static uint32_t state;
  if (state == 0U) state = (uint32_t)esp_timer_get_time() ^ 0x9e3779b9U;
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
#endif
}

static void begin_activation(uint64_t now) {
  const uint32_t first = activation_random();
  const uint32_t second = activation_random();
  const uint32_t third = activation_random();
  const uint32_t fourth = activation_random();
  (void)snprintf(
      runtime.activation, sizeof(runtime.activation), "%08" PRIx32 "%08" PRIx32
      "%08" PRIx32 "%08" PRIx32,
      first, second, third, fourth);
  runtime.activation_started_at_ms = now;
  runtime.activation_live = true;
  runtime.first_mic_append_at_ms = 0U;
  runtime.opening_started_at_ms = now;
  runtime.opening_outcome = OPENING_WAITING;
}

static bool queue_terminal(const char *reason) {
  size_t slot;
  if (runtime.activation[0] == '\0') return true;
  if (runtime.pending_terminal_count > 0U) {
    const size_t last =
        (runtime.pending_terminal_head + runtime.pending_terminal_count - 1U) %
        TERMINAL_PENDING_CAPACITY;
    if (strcmp(runtime.pending_terminals[last].activation, runtime.activation) ==
        0) {
      return true;
    }
  }
  if (runtime.pending_terminal_count == TERMINAL_PENDING_CAPACITY) return false;
  slot = (runtime.pending_terminal_head + runtime.pending_terminal_count) %
      TERMINAL_PENDING_CAPACITY;
  memcpy(
      runtime.pending_terminals[slot].activation,
      runtime.activation,
      sizeof(runtime.pending_terminals[slot].activation));
  runtime.pending_terminals[slot].reason = reason;
  ++runtime.pending_terminal_count;
  return true;
}

static void end_local_activation(const char *reason, const char *status) {
  bool queued;
  /* Every local end is immediately audible: discard the old answer before
   * fencing capture or waiting for its terminal to reach the stream. */
  (void)abandon_speaker_audio();
  /* A terminal is required only after this activation reached the stream. */
  queued = !runtime.activation_live ||
      runtime.first_mic_append_at_ms == 0U || queue_terminal(reason);
  /* `pending_terminals` owns the ID now. Do not let a delayed acceptance or
   * speaker frame match an activation the person has already ended. */
  runtime.activation[0] = '\0';
  runtime.activation_live = false;
  atomic_store_explicit(&runtime.speaker_peak, 0U, memory_order_relaxed);
  atomic_store_explicit(&runtime.speaker_peak_at_ms, 0U, memory_order_release);
  runtime.view.wants_call = false;
  runtime.view.listening = false;
  /* A queued terminal fences later microphone appends, so the old call must
   * stop governing new local intent immediately. */
  runtime.view.call_active = false;
  runtime.voicelab.call_active = false;
  runtime.voicelab.answer_open = false;
  runtime.voicelab.last_presence_at_ms = 0U;
  runtime.opening_started_at_ms = 0U;
  runtime.opening_outcome = OPENING_IDLE;
  atomic_fetch_add_explicit(
      &runtime.capture_generation, 1U, memory_order_acq_rel);
  atomic_store_explicit(&runtime.capture_open, false, memory_order_release);
  atomic_store_explicit(
      &runtime.capture_discard_requested, true, memory_order_release);
  runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
  runtime.view.status = queued ? status : "cancel backlog full";
  if (!queued) ESP_LOGE(tag, "terminal backlog full for activation");
}

/* The server has already accepted the terminal; fence only local audio. */
static void end_authoritative_activation(const char *status) {
  if (!runtime.activation_live) return;
  runtime.activation_live = false;
  atomic_store_explicit(&runtime.speaker_peak, 0U, memory_order_relaxed);
  atomic_store_explicit(&runtime.speaker_peak_at_ms, 0U, memory_order_release);
  runtime.view.wants_call = false;
  runtime.view.listening = false;
  runtime.view.call_active = false;
  runtime.voicelab.call_active = false;
  runtime.voicelab.answer_open = false;
  runtime.voicelab.last_presence_at_ms = 0U;
  runtime.opening_started_at_ms = 0U;
  runtime.opening_outcome = OPENING_IDLE;
  atomic_fetch_add_explicit(
      &runtime.capture_generation, 1U, memory_order_acq_rel);
  atomic_store_explicit(&runtime.capture_open, false, memory_order_release);
  atomic_store_explicit(
      &runtime.capture_discard_requested, true, memory_order_release);
  runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
  runtime.view.status = status;
}

static void flush_pending_terminal(size_t outbox_free) {
  enum capnweb_status status;
  const size_t slot = runtime.pending_terminal_head;
  if (runtime.pending_terminal_count == 0U) return;
  /* A full outbox makes a Cap'n Web append session-fatal. Keep the terminal
   * pending until its one control slot is available. */
  if (outbox_free == 0U) return;
  status = iterate_kit_voicelab_end_activation(
      &runtime.voicelab,
      runtime.pending_terminals[slot].activation,
      runtime.pending_terminals[slot].reason);
  if (status != CAPNWEB_OK) return;
  /* The pending terminal owns the old stream call. `runtime.activation` may
   * already name a new local capture, which has not appended while terminals
   * are pending. */
  runtime.voicelab.call_active = false;
  runtime.voicelab.answer_open = false;
  runtime.voicelab.last_presence_at_ms = 0U;
  runtime.pending_terminal_head =
      (runtime.pending_terminal_head + 1U) % TERMINAL_PENDING_CAPACITY;
  --runtime.pending_terminal_count;
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
  if (runtime.capture_generation_inflight !=
      atomic_load_explicit(&runtime.capture_generation, memory_order_acquire)) {
    capture_reset_audio();
    return ITERATE_KIT_OK;
  }
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
    const uint32_t peak = pcm_peak(samples, FRAME_SAMPLES);
    atomic_store_explicit(
        &runtime.mic_peak, peak, memory_order_relaxed);
    if (peak >
        atomic_load_explicit(&runtime.mic_peak_max, memory_order_relaxed)) {
      atomic_store_explicit(
          &runtime.mic_peak_max, peak, memory_order_relaxed);
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
  if (atomic_exchange_explicit(
          &runtime.capture_discard_requested, false, memory_order_acq_rel)) {
    capture_reset_audio();
    /* A new local activation may have followed end before this task ran. */
    if (!atomic_load_explicit(&runtime.capture_open, memory_order_acquire)) {
      return ITERATE_KIT_OK;
    }
  }
  if (!atomic_load_explicit(&runtime.capture_open, memory_order_acquire)) {
    if (atomic_load_explicit(&runtime.capture_muted, memory_order_acquire)) {
      return ITERATE_KIT_OK;
    }
    capture_remember(samples);
    ++runtime.mic_frames_idle;
    return ITERATE_KIT_OK;
  }
  if (!capture_open_activation()) {
    atomic_store_explicit(
        &runtime.capture_activation_overflow, true, memory_order_release);
    atomic_fetch_add_explicit(
        &runtime.capture_activation_overflows, 1U, memory_order_relaxed);
    return ITERATE_KIT_OK;
  }
  /*
   * Sent straight from the bridge's egress frame: `struct mic_frame` is
   * exactly FRAME_SAMPLES of PCM16 and xQueueSend copies, so a staging frame
   * here would be one memcpy and 640 bytes of .bss to say the same thing.
   */
  if (xQueueSend(runtime.mic_queue, samples, 0) == pdTRUE) return ITERATE_KIT_OK;
  {
    /* Twenty-one seconds is the declared bound: fail the activation, never trim it. */
    atomic_store_explicit(
        &runtime.capture_activation_overflow, true, memory_order_release);
    atomic_fetch_add_explicit(
        &runtime.capture_activation_overflows, 1U, memory_order_relaxed);
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
  runtime.capture_generation_inflight = atomic_load_explicit(
      &runtime.capture_generation, memory_order_acquire);
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
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
      if (!atomic_load_explicit(&runtime.capture_muted, memory_order_acquire) &&
          runtime.pending_terminal_count < TERMINAL_PENDING_CAPACITY) {
        runtime.view.wants_call = true;
      }
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      end_local_activation("button", "call ended");
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      break;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

/* Defined beside health_json, which it adapts. */
static size_t render_health(void *context, char *out, size_t capacity);

static bool initialise_connection(void) {
  /*
   * Four shared (conversation control, speaker, health,
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
        iterate_kit_conversation_control_init(
            &runtime.conversation_control, &runtime.device_events) !=
            ITERATE_KIT_OK) {
      return false;
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
    "{}",
    2U,
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
  options.client_path = client_path;
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
  options.description = "Voice device";
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
    {"openingTimeouts", runtime.opening_timeouts},
    {"openingAgeMs",
     runtime.opening_started_at_ms == 0U
         ? 0U
         : (uint32_t)iterate_kit_voice_elapsed_ms(
               now, runtime.opening_started_at_ms)},
    {"queuedPcmMs", runtime.mic_queue == NULL
         ? 0U
         : (uint32_t)(uxQueueMessagesWaiting(runtime.mic_queue) * FRAME_MS)},
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
    {"spkPlayed", runtime.playout.stats.frames_played},
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
    {"spkSoftDryTicks", runtime.playout.stats.conceal_frames},
    {"spkCatchup", runtime.playout.stats.catchup_frames},
    {"spkWriteFailures", runtime.playout.stats.write_failures},
    {"spkMarginMaxMs", runtime.playout.stats.margin_max_ms},
    {"spkLagMaxMs", runtime.playout.clock.lag_max_ms},
    {"spkMarginMinMs", runtime.playout.stats.margin_min_ms},
    {"spkWrites", runtime.playout.stats.writes},
    {"spkBadFrames", runtime.speaker_bad_frames},
    /*
     * A CHUNK THE DEVICE COULD NOT DECODE, which is now the only way audio
     * can fail to reach the speaker before it is queued.
     *
     * The old classifier's `spkIgnoredCall`/`spkIgnoredStale`/`spkIgnoredDup`
     * are gone with the classifier: the sender paces the answer and no frame
     * carries a call or an answer any more, so there is nothing for the
     * device to refuse.
     */
    {"spkDecodeFailures", runtime.voicelab.spk_decode_failures},
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
    {"spkWaitPriming", runtime.playout.stats.waits_priming},
    {"spkAnswerDrains", runtime.playout.stats.waits_dry},
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
      /* Current stream path. */
      "\"conversation\":\"%s\","
      "\"opening\":\"%s\","
      "\"clock\":\"%s\","
      /* WHY IT LAST RESTARTED. Uptime says one happened; only this
       * says whether it was a panic, a stall or somebody's thumb. */
      "\"resetReason\":\"%s\",\"restartNote\":\"%s\","
      "\"connection\":\"%s\","
      "\"callActive\":%s,\"wantsCall\":%s,"
      /* Opening inputs and capture-gate state. */
      "\"hasStreamCap\":%s,\"outboxFree\":%u,"
      "\"gateOpen\":%s,\"activationStartedMs\":%" PRIu64
      ",\"firstMicAppendOffsetMs\":%" PRId64 ",\"t\":%" PRIu64
      ",\"uptimeMs\":%" PRIu64,
      iterate_kit_esp_idf_itx_transport_state_name(transport.state),
      iterate_kit_voicelab_state_name(runtime.voicelab.state),
      iterate_kit_voicelab_failure_name(runtime.voicelab.failure),
      stream_path,
      runtime.opening_outcome == OPENING_WAITING ? "waiting"
      : runtime.opening_outcome == OPENING_ACCEPTED ? "accepted"
      : runtime.opening_outcome == OPENING_TIMED_OUT ? "timed-out" : "idle",
      clock,
      iterate_kit_esp_reset_reason_name(),
      iterate_kit_esp_last_restart_note(),
      iterate_kit_itx_connection_state_name(runtime.connection.state),
      runtime.voicelab.call_active ? "true" : "false",
      runtime.view.wants_call ? "true" : "false",
      runtime.voicelab.has_stream_capability ? "true" : "false",
      (unsigned)(CONTROL_OUTBOX_SLOTS - outbox_metrics.current_slots),
      gate_open ? "true" : "false",
      runtime.activation_started_at_ms,
      runtime.first_mic_append_at_ms == 0U ||
              runtime.activation_started_at_ms == 0U
          ? INT64_C(-1)
          : (int64_t)iterate_kit_voice_elapsed_ms(
                runtime.first_mic_append_at_ms, runtime.activation_started_at_ms),
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
 * other way round resets a configured codec.
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
  atomic_store_explicit(
      &runtime.speaker_answer_done_generation, UINT32_MAX, memory_order_release);
  runtime.board = ops;
  runtime.facts = facts;
  runtime.board_context = context;
  if (facts->device_name == NULL || facts->device_name[0] == '\0') {
    return false;
  }
  const int stream_path_length = snprintf(
      stream_path, sizeof(stream_path), "/agents/voice/v23/%s", facts->device_name);
  const int client_path_length = snprintf(
      client_path, sizeof(client_path), "/clients/%s", facts->device_name);
  if (stream_path_length < 0 ||
      (size_t)stream_path_length >= sizeof(stream_path) ||
      client_path_length < 0 ||
      (size_t)client_path_length >= sizeof(client_path)) {
    return false;
  }
  iterate_kit_voice_playout_init(&runtime.playout);
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
  if (!start_board()) {
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
    if (runtime.intent.microphone_muted &&
        !atomic_exchange_explicit(
            &runtime.capture_muted, true, memory_order_acq_rel)) {
      end_local_activation("microphone-muted", "microphone muted");
    } else if (!runtime.intent.microphone_muted) {
      atomic_store_explicit(&runtime.capture_muted, false, memory_order_release);
    }
    if (runtime.intent.end_call) {
      end_local_activation("button", "call ended");
      ESP_LOGI(tag, "control: ending call");
    }
    if (runtime.intent.start_call && !runtime.intent.microphone_muted &&
        !runtime.voicelab.call_active &&
        runtime.pending_terminal_count < TERMINAL_PENDING_CAPACITY) {
      runtime.view.wants_call = true;
      ESP_LOGI(tag, "control: starting call");
    }
    runtime.intent.start_call = false;
    runtime.intent.end_call = false;
    /* Capture starts at activation and remains open until an explicit end. */
    {
      if (runtime.view.wants_call && !runtime.activation_live) {
        begin_activation(now_ms(NULL));
      }
      if (atomic_exchange_explicit(
              &runtime.capture_activation_overflow, false,
              memory_order_acq_rel)) {
        end_local_activation(
            "activation-overflow", "opening speech exceeded 21s");
        ESP_LOGE(tag, "activation microphone FIFO overflow");
      } else if (atomic_load_explicit(
                     &runtime.capture_open, memory_order_acquire) !=
                 runtime.view.wants_call) {
        runtime.view.listening = runtime.view.wants_call;
        if (runtime.view.wants_call) {
          atomic_store_explicit(
              &runtime.capture_open, true, memory_order_release);
          (void)abandon_speaker_audio();
          runtime.mic_flushed_at_ms = 0U;
          runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_LISTENING;
          runtime.view.status = "listening";
        } else {
          atomic_store_explicit(
              &runtime.capture_open, false, memory_order_release);
          runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
          runtime.view.status = "ready";
        }
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

    /* Each activation has one bounded opening deadline and one capture FIFO. */
    if (runtime.opening_started_at_ms != 0U &&
        !runtime.voicelab.call_active &&
        iterate_kit_voice_elapsed_ms(now, runtime.opening_started_at_ms) >=
            OPENING_DEADLINE_MS) {
      end_local_activation("opening-timeout", "opening timed out");
      runtime.opening_outcome = OPENING_TIMED_OUT;
      ++runtime.opening_timeouts;
      ESP_LOGE(tag, "activation opening timed out before acceptance");
    }

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
        .activation = runtime.activation,
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
        /* A retry keeps the local activation and its FIFO intact. */
        runtime.view.call_active = (false);
        runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_CONNECTING;
        runtime.view.status = (iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      }
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
      size_t outbox_free =
          CONTROL_OUTBOX_SLOTS - outbox_metrics.current_slots;
      static struct mic_frame frame_storage[MIC_FRAMES_PER_APPEND];
      static int16_t pcm_storage[MIC_FRAMES_PER_APPEND][FRAME_SAMPLES];
      static bool call_active_shown;

      /* Terminals are ordered ahead of later activation audio. */
      flush_pending_terminal(outbox_free);
      /* A terminal append consumes the same ring as mic frames. Refresh the
       * headroom before deciding whether another producer may append. */
      iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox_metrics);
      outbox_free = CONTROL_OUTBOX_SLOTS - outbox_metrics.current_slots;
      const bool terminal_pending = runtime.pending_terminal_count != 0U;

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
       * Silence is only evidence when traffic is expected, and with GPT-Live
       * that is narrower than "a call is wanted": the facet drops idle
       * silence, so an accepted call with nothing owed delivers NOTHING while
       * the person thinks and the model listens. Read as a dead lane, that
       * recycled the connection every ten seconds of ordinary conversation
       * (18 times in a six-minute call, 2026-09-11), each one a TLS round
       * trip on this task. Traffic is owed while a wanted call has not been
       * accepted yet, or an answer has begun and its `last` has not come —
       * iterate_kit_voicelab_downlink_expected() — and ten seconds of
       * nothing in either state means the lane is dead, not quiet.
       * The cure is the recycle that already exists — make-before-break, one
       * round trip — and if three of those change nothing then it is not the
       * connection that is broken, it is the session under it.
       */
      if (wants_call && runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
          runtime.voicelab.has_connection_capability &&
          iterate_kit_voicelab_downlink_expected(&runtime.voicelab) &&
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

      if (!terminal_pending && wants_call && runtime.voicelab.call_active &&
          outbox_free >= 3U) {
        (void)iterate_kit_voicelab_keepalive_if_due(&runtime.voicelab);
      }
      if (runtime.voicelab.call_active &&
          runtime.voicelab.call_active != call_active_shown) {
        runtime.playout.stats.margin_min_ms = 0U;
        runtime.playout.stats.writes = 0U;
      }
      if (runtime.voicelab.call_active != call_active_shown) {
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
          runtime.view.status = "ready";
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

      {
        const size_t queued = uxQueueMessagesWaiting(runtime.mic_queue);
        const bool discarding = atomic_load_explicit(
            &runtime.capture_discard_requested, memory_order_acquire);
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
          const bool jammed = runtime.view.wants_call &&
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
         * THE FLUSH RUNS ON THE CLOCK (MIC_FLUSH_MS), NOT ON A FRAME COUNT.
         * Whatever has been captured since the last flush goes out as one
         * event the moment the interval is up — a count-based batch held the
         * first frame hostage to the last, 80 ms of mic latency at four
         * frames, and made the four-frame lump the unit of work the stream's
         * thread had to digest at once. A backlog (the outbox was short, the
         * cap is MIC_FRAMES_PER_APPEND frames per event) sends at once.
         */
        /*
         * Frames flow as soon as the stream is up. The first opens the call;
         * the facet holds later frames while it dials.
         */
        size_t take = iterate_kit_microphone_flush_frames(
            discarding || terminal_pending ? 0U : queued,
            runtime.view.wants_call,
            runtime.mic_flushed_at_ms, now);
        if (take != 0U &&
            runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
            outbox_free >= (size_t)MIC_OUTBOX_RESERVE) {
          /*
           * The stamp only advances on a flush that was actually sent, so a
           * moment of outbox backpressure delays the speech a beat instead of
           * dropping it — the mic queue is the right place to absorb this.
           */
          size_t index;
          for (index = 0U; index < take; ++index) {
            (void)xQueueReceive(runtime.mic_queue, &frame_storage[index], 0);
            memcpy(pcm_storage[index], frame_storage[index].samples,
                   sizeof(pcm_storage[index]));
          }
          /* `struct mic_frame` is exactly its samples, so the popped run is
           * one contiguous stretch of PCM. */
          if (iterate_kit_voicelab_append_frames(
              &runtime.voicelab,
              (const uint8_t *)pcm_storage,
              take,
              sizeof(frame_storage[0].samples),
              runtime.activation) == CAPNWEB_OK) {
            runtime.mic_flushed_at_ms = now;
            if (runtime.activation_started_at_ms != 0U &&
                runtime.first_mic_append_at_ms == 0U) {
                runtime.first_mic_append_at_ms = now;
            }
          } else {
            end_local_activation(
                "microphone-append-failed", "microphone append failed");
            ESP_LOGE(tag, "microphone append failed");
          }
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
       * The PROACTIVE connection recycle was here — a new TLS-backed
       * connection every 600 delivered batches, racing a per-connection
       * push budget the platform no longer has (see the note where
       * ITERATE_KIT_VOICELAB_RECYCLE_AFTER_BATCHES used to be declared). It
       * ran on this task, the one that decodes speaker PCM, and on an
       * open-mic call it fired every ~15 s. Reconnects are failure-driven
       * only: the downlink deadline above and the transport restart.
       */
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
      if (runtime.view.wants_call || runtime.voicelab.call_active ||
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
              runtime.playout.stats.frames_played,
              runtime.playout.stats.conceal_frames,
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
  {
    const uint64_t speaker_peak_at_ms = atomic_load_explicit(
        &runtime.speaker_peak_at_ms, memory_order_acquire);
    runtime.view.speaker_peak =
        speaker_peak_at_ms != 0U &&
            iterate_kit_voice_elapsed_ms(now_ms(NULL), speaker_peak_at_ms) < FRAME_MS
        ? atomic_load_explicit(&runtime.speaker_peak, memory_order_relaxed)
        : 0U;
  }
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

void iterate_kit_voice_view_lights(
    const struct iterate_kit_voice_view *view,
    struct iterate_kit_conversation_visual_state *out) {
  *out = (struct iterate_kit_conversation_visual_state){
    .network = view->link_ready ? ITERATE_KIT_NETWORK_CONNECTED
                                : ITERATE_KIT_NETWORK_CONNECTING,
    .reach = iterate_kit_reach_from(
        view->api_ready, view->stream_ready, view->call_active),
    .conversation_active = view->call_active,
    .media_ready = view->link_ready,
    .media_failed = view->fault,
    .microphone_listening = view->listening,
    .microphone_peak = view->microphone_peak,
    .speaker_peak = view->speaker_peak,
  };
  if (view->wants_call && !view->call_active) out->media_ready = false;
}
