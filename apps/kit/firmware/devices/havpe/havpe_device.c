/*
 * Home Assistant Voice Preview Edition — the Iterate voice device, on the
 * shared single-socket lane.
 *
 * ONE Cap'n Web WebSocket to /api carries everything, exactly like the
 * Waveshare port and the TypeScript voicelab client: authenticate ->
 * projects.get -> streams.get, then 50 Hz one-way appends of ephemeral
 * events.iterate.com/voice-agent/mic-frame events (the XMOS's echo-cancelled capture), and a
 * live openConnection callback delivering events.iterate.com/voice-agent/spk-frame events
 * (decoded to the speaker) plus grok-events (speech_started = barge-in
 * flush, response.done = end of answer).
 *
 * Turn taking is the PROVIDER'S: this board is genuinely full duplex, with
 * hardware echo cancellation in its XMOS DSP, so its microphone stays open
 * for the whole call and server VAD decides where turns end. The one
 * physical button therefore has one job — a tap starts or ends the call.
 *
 * It was push-to-talk until somebody tried to talk to it: the call came up,
 * the ring showed a call with nobody listening, and speaking did nothing,
 * because the microphone only opened while a finger held the button. PTT's
 * rationale (decision A2) is the echo story on boards WITHOUT echo
 * cancellation, and this is the one board that has it in silicon.
 *
 * Structure and supervision deliberately rhyme with
 * devices/waveshare_s3_amoled/waveshare_device.c and the M5StickS3 port —
 * same portable modules, same watchdogs, same telemetry names — so a reader
 * of one can read the others. Divergences are the board's own: no screen
 * (a 12-pixel ring), one button, and an always-on speaker rail.
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
#include "esp_random.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "capnweb/capnweb.h"
#include "iterate/kit/audio_codec.h"
#include "iterate/kit/mount_watchdog.h"
#include "iterate/kit/capabilities/conversation.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/barge_in.h"
#include "iterate/kit/capabilities/arguments.h"
#include "iterate/kit/capabilities/speaker.h"
#include "iterate/kit/device_events.h"
#include "iterate/kit/audio_playout.h"
#include "iterate/kit/audio_processor.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voicelab_stream.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice_playback_clock.h"
#include "havpe_audio.h"
#include "havpe_ui.h"

static const char tag[] = "iterate-voicelab";

/* UTC as YYYY-MM-DD-HHMMSS, or false when the clock has not arrived. */
static bool clock_slug(char *out, size_t capacity);

/*
 * Throw away whatever speaker audio is queued, in the one safe order.
 * Declared here because the abandon sites are spread across the receive path
 * and the app loop; defined once, beside the runtime it acts on.
 */
static uint32_t abandon_speaker_audio(void);

enum {
  PENDING_CALL_CAPACITY = ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY,
  EXPORT_CAPACITY = ITERATE_KIT_VOICE_EXPORT_CAPACITY,
  IMPORT_CAPACITY = ITERATE_KIT_VOICE_IMPORT_CAPACITY,
  TOKEN_CAPACITY = ITERATE_KIT_VOICE_TOKEN_CAPACITY,
  OUTPUT_CAPACITY = ITERATE_KIT_VOICE_OUTPUT_CAPACITY,
  CONTROL_INBOX_SLOT_CAPACITY =
      ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY,
  CONTROL_OUTBOX_SLOT_CAPACITY =
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY,
  CONTROL_INBOX_SLOTS = ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS,
  CONTROL_OUTBOX_SLOTS = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS,
  MIC_OUTBOX_RESERVE = ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE,
  FRAME_MS = ITERATE_KIT_VOICE_FRAME_MS,
  FRAME_SAMPLES = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  /* One hardware ring of credited audio: the point an answer is under way. */
  DMA_RING_CREDIT_MS = 60,
  FRAME_BYTES = ITERATE_KIT_VOICE_FRAME_BYTES,
  MIC_QUEUE_DEPTH = ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH,
  MIC_FRAMES_PER_APPEND = ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND,
  SPEAKER_BUFFER_BYTES = ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES,
  /* Whole-frame queueing makes replacement atomic at frame boundaries. */
  SPEAKER_QUEUE_DEPTH = SPEAKER_BUFFER_BYTES / FRAME_BYTES,
  /*
   * How long the playback task waits for a frame before treating the source
   * as dry: two thirds of the 60 ms I2S TX DMA ring (6 descriptors x 480
   * frames at 48 kHz), so a late frame is absorbed by the hardware cushion
   * rather than concealed, while the remaining third still bounds how long
   * this task can sit before the ring genuinely empties.
   */
  SPEAKER_DRY_WAIT_MS = 40,
  SPEAKER_PREFILL_BYTES = ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES,
  SPEAKER_CONCEAL_LIMIT_MS = ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS,
  SPEAKER_HIGH_WATER_MS = ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS,
  SPEAKER_CATCHUP_EVERY = ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY,
  SPEAKER_IDLE_POWERDOWN_MS = ITERATE_KIT_VOICE_SPEAKER_IDLE_POWERDOWN_MS,
  BUTTON_POLL_MS = ITERATE_KIT_VOICE_CONTROL_POLL_MS,
  STATS_INTERVAL_MS = ITERATE_KIT_VOICE_STATS_INTERVAL_MS,
  UNHEALTHY_RESTART_MS = ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS,
  PING_INTERVAL_MS = ITERATE_KIT_VOICE_PING_INTERVAL_MS,
  PING_TIMEOUT_MS = ITERATE_KIT_VOICE_PING_TIMEOUT_MS,
  BRIDGE_SILENCE_MS = ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS,
  DOWNLINK_SILENCE_MS = ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS,
  NO_LIVENESS_RESTART_MS = ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS,
};

/* PSRAM-resident: this much .bss would crowd internal RAM out of TLS room. */
EXT_RAM_BSS_ATTR static uint8_t
    inbox_storage_psram[CONTROL_INBOX_SLOTS][CONTROL_INBOX_SLOT_CAPACITY];
EXT_RAM_BSS_ATTR static uint8_t
    outbox_storage_psram[CONTROL_OUTBOX_SLOTS][CONTROL_OUTBOX_SLOT_CAPACITY];

/*
 * The stream this device mounts. The path IS the conversation's identity, so
 * choosing it is choosing whether to continue or begin. Under /agents/voice/
 * because the conversation's stream IS its agent.
 */
#define STREAM_PATH_DEFAULT "/agents/voice/device"
static char stream_path[96] = STREAM_PATH_DEFAULT;
/* The path a setup call is preparing; adopted only when the server is ready. */
static char pending_stream_path[96];

/*
 * EVERY CALL GETS ITS OWN STREAM. A second call on the same path is a second
 * conversation wearing the first one's history. `stream_used` starts TRUE:
 * the boot path is either the default or one used before, and both have a
 * past. `awaiting_fresh_stream` stops the prepare-then-call handshake from
 * looping. See the Waveshare port for the measured history behind this.
 */
static bool stream_used = true;
static bool awaiting_fresh_stream;
/*
 * True when the stream being prepared was NOT asked for by a person.
 * See the eager prepare in the app loop: the adoption path must not
 * turn a speculative preparation into a call nobody wanted.
 */
static bool preparing_ahead;
#define CONVERSATION_ID "havpedev"
#define GREETING "Hi, I am your Iterate device. What can I do for you?"

/*
 * pdMS_TO_TICKS() truncates, so any wait shorter than one tick becomes zero —
 * and vTaskDelay(0) yields without blocking, which turns a short sleep into a
 * busy spin that can starve the idle task and trip the watchdog.
 */
#define DELAY_MS(ms) \
  vTaskDelay(pdMS_TO_TICKS(ms) > 0U ? pdMS_TO_TICKS(ms) : 1U)

struct mic_frame {
  int16_t samples[FRAME_SAMPLES];
};

/*
 * A generation is the answer epoch. The consumer can hold a frame while the
 * producer replaces the answer; tagging the copied frame makes that race an
 * exact comparison instead of a byte-count guess.
 */
struct speaker_frame {
  uint32_t generation;
  int16_t samples[FRAME_SAMPLES];
};

_Static_assert(
    SPEAKER_BUFFER_BYTES % FRAME_BYTES == 0U,
    "speaker capacity must contain whole PCM frames");

static struct {
  struct iterate_kit_audio_codec codec;
  struct iterate_kit_audio_processor processor;
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
  struct iterate_kit_esp_idf_itx_transport transport;
  struct iterate_kit_peer peer;
  /* Physical and remote edges share one bounded owner queue. */
  struct iterate_kit_device_event device_event_storage
      [ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY];
  struct iterate_kit_device_event_queue device_events;
  struct iterate_kit_conversation_control conversation_control;
  struct iterate_kit_voicelab voicelab;
  struct iterate_kit_playout playout;
  uint32_t voicelab_generation;
  uint32_t frame_sequence;
  /*
   * Generous on purpose: a stats line that outgrows this is silently NOT
   * sent, so the instrument would go dark exactly when someone added the
   * counter that explains a bug. The overflow is logged for the same reason.
   */
  char stats_buffer[2560];
  uint32_t stats_sequence;
  enum iterate_kit_esp_idf_itx_transport_state last_transport_state;
  enum iterate_kit_voicelab_state last_voicelab_state;
  /* Cross-task audio plumbing. */
  QueueHandle_t mic_queue;
  QueueHandle_t speaker_queue;
  atomic_uint speaker_generation;
  atomic_uint_fast64_t speaker_last_write_ms;
  uint32_t mic_frames_captured;
  uint32_t mic_frames_dropped;
  uint32_t mic_process_failures;
  /** Captured with no turn open: room noise, never sent, never queued. */
  uint32_t mic_frames_idle;
  /* Loudest sample in the newest frame, and the loudest ever seen. */
  atomic_uint mic_peak;
  atomic_uint mic_peak_max;
  struct iterate_kit_barge_in barge_in;
  uint32_t barge_in_rejected;
  uint32_t speaker_frames_played;
  /* Written by both the app producer and playback consumer. */
  atomic_uint speaker_overflow_drops;
  /* Queue-reset accounting is app-owned; in-flight rejection playback-owned. */
  atomic_uint speaker_discarded_frames;
  uint32_t speaker_waits_priming;
  uint32_t speaker_waits_dry;
  /*
   * A starve is only a DEFECT if the stream had more to say: promoted only
   * when audio resumes soon after, meaning the answer was still in progress.
   */
  uint32_t speaker_underruns;
  uint32_t speaker_conceal_frames;
  uint32_t speaker_catchup_frames;
  uint32_t speaker_debt_paid;
  uint32_t speaker_write_failures;
  uint32_t speaker_margin_max_ms;
  atomic_uint_fast64_t starve_at_ms;
  /*
   * Proving "no underruns" needs more than a count of holes: the minimum
   * margin over a call says how close the pipe ever came to running dry.
   */
  uint32_t speaker_margin_min_ms;
  uint32_t speaker_writes;
  uint32_t speaker_bad_frames;
  uint32_t barge_in_flushes;
  /* Transports torn down because a ping went unanswered. */
  uint32_t liveness_restarts;
  struct iterate_kit_mount_watchdog mount_watchdog;
  /* Calls abandoned because their bridge stopped proving it existed. */
  uint32_t bridge_losses;
  /* Connections replaced because nothing was being delivered on them. */
  uint32_t downlink_recycles;
  uint32_t downlink_recycles_running;
  /* Diagnostics for a frozen device: see the pulse in the app loop. */
  uint32_t loop_count;
  uint64_t last_pulse_ms;
  bool talking;
  /* Release pressed, but the capture queue is not yet on the wire. */
  atomic_bool speaker_reprime;
  /*
   * When the current answer's playout began, and how much of it has played.
   * Together these ARE the audio timeline; their gap versus the wall clock
   * is the only honest measure of "behind" — queue depth is not.
   */
  atomic_uint_fast64_t answer_started_ms;
  atomic_uint answer_emitted_ms;
  uint32_t speaker_lag_max_ms;
  atomic_bool speaker_answer_done;
  /*
   * The SENDER said this answer is complete, latched until the speaker
   * actually drains it — the difference between an answer that ended and an
   * answer that was cut off.
   */
  atomic_bool answer_declared_done;
  uint32_t turn_marker_failures;
} runtime;

static uint32_t speaker_queued_bytes(void) {
  if (runtime.speaker_queue == NULL) return 0U;
  return (uint32_t)uxQueueMessagesWaiting(runtime.speaker_queue) * FRAME_BYTES;
}

/*
 * THE ONLY DESCRIPTION A MODEL EVER SEES is `instructions`; peer_description
 * documents the device for people reading this file (the capability host
 * flattens this mount and reports children: {}).
 */
static const char instructions[] =
    "Home Assistant Voice Preview Edition voice endpoint. Hold the physical "
    "center button for push-to-talk; a short tap starts and ends the call; "
    "audio and lifecycle events share this stream connection.";
/*
 * WHAT THE MODEL IS TOLD IT CAN DO — and it matters more on this board than on
 * any other, because it has NO SCREEN. There is no glanceable state here at
 * all: if the methods are not named, the only way to find out what this device
 * can do is to read its firmware.
 */
static const char peer_description[] =
    "{\"instructions\":\"Home Assistant Voice PE voice endpoint. It has no "
    "screen: its LED ring is the only local feedback. Hold the centre button "
    "to talk; a short tap starts and ends the call. "
    "conversation.start() / conversation.end() begin and end a call. "
    "aec.setStage({channel,stage}) moves an XMOS output tap — stage 0 is the "
    "raw microphone, 1 AEC, 2 AEC+IC, 3 AEC+IC+NS, 4 with AGC — and health() "
    "reports echoRawPeak and echoCleanPeak accumulated while the speaker was "
    "running, which is how this board's cancellation is measured. "
    "There is no push-to-talk: this board has hardware echo cancellation in "
    "its XMOS DSP, so its microphone is open for the whole call and the "
    "provider's server VAD decides when you have finished speaking. "
    "speaker.setVolume({percent}) sets how loud it plays, 0-100; it clamps "
    "to a ceiling this board has a measured reason for and answers with "
    "{percent,ceiling}, which speaker.volume() also returns. "
    "health() returns the same diagnostics document the device pushes "
    "as dev-stats.\",\"children\":{}}";

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

static void on_speaker_pcm(
    void *context,
    const uint8_t *pcm,
    size_t pcm_length,
    const struct iterate_kit_playout_frame *identity) {
  static struct speaker_frame frame;
  enum iterate_kit_playout_action action;
  (void)context;
  /*
   * A frame goes in whole or not at all. A partial write splices the head of
   * one frame onto the next at an arbitrary phase, which is a click; an odd
   * length would shift the 16-bit sample grid permanently.
   */
  if (pcm_length != FRAME_BYTES || identity == NULL) {
    ++runtime.speaker_bad_frames;
    return;
  }
  action = iterate_kit_playout_classify(&runtime.playout, identity);
  if (action == ITERATE_KIT_PLAYOUT_IGNORE) return;
  if (action == ITERATE_KIT_PLAYOUT_REPLACE) {
    /* Ordering-safe: the watch comes off before the audio does. */
    (void)abandon_speaker_audio();
    /* A new answer is a new timeline: lag does not carry across answers. */
    atomic_store_explicit(
        &runtime.answer_started_ms, 0U, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_emitted_ms, 0U, memory_order_release);
  }
  if (uxQueueSpacesAvailable(runtime.speaker_queue) == 0U) {
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
    return;
  }
  /*
   * No amplifier gating on this board: the speaker rail stays on for the
   * life of the boot because the XMOS AEC's reference rides the always-
   * running TX stream — see havpe_audio_init().
   */
  atomic_store_explicit(
      &runtime.speaker_answer_done, false, memory_order_release);
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
    /* Only this task writes, but retain an exact signal if that drifts. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
  }
}

/*
 * ONE FUNNEL FOR THROWING QUEUED SPEAKER AUDIO AWAY.
 *
 * Barge-in, a superseded answer, a call accepted, the bridge hanging up, and
 * a new turn's flush all land here. The ordering is the correctness proof:
 * disarm -> note flush -> invalidate -> discard -> reprime. Invalidating
 * before disarming creates a window in which an intentional cut is counted
 * as listener-visible starvation. ESP-IDF 5.4.2's
 * FreeRTOS-Kernel-SMP/queue.c:xQueueGenericReset holds the queue lock and
 * leaves blocked receivers waiting when an existing queue is reset. A frame
 * copied before that lock was taken is rejected by generation.
 */
static uint32_t abandon_speaker_audio(void) {
  havpe_audio_watch(false);
  havpe_audio_note_flush();
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
  return bytes;
}

static void on_control(
    void *context, enum iterate_kit_voicelab_control control) {
  (void)context;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    /*
     * THE PROVIDER IS NOT THE ONLY WITNESS. Its VAD hears what this device
     * sends, which during an answer is the echo the canceller missed; six
     * barge-ins arrived across four answers with nobody in the room, and
     * more of the answer was thrown away than was ever played. The device
     * corroborates with its own microphone before flushing anything.
     */
    if (!iterate_kit_barge_in_admit(&runtime.barge_in, now_ms(NULL))) {
      ++runtime.barge_in_rejected;
      return;
    }
    (void)abandon_speaker_audio();
    iterate_kit_playout_interrupt(&runtime.playout);
    ++runtime.barge_in_flushes;
    havpe_ui_set_state(HAVPE_UI_LISTENING);
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    /*
     * The answer is finished, so a dry buffer from here is not a deficit.
     * It must NOT interrupt the playout: response.done is one small text
     * event racing hundreds of large audio events, and routinely wins.
     */
    atomic_store_explicit(
        &runtime.speaker_answer_done, true, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_declared_done, true, memory_order_release);
    havpe_ui_set_state(HAVPE_UI_IDLE);
    havpe_ui_set_status("hold the button to talk");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    /*
     * A NEW CALL IS A NEW SENDER. Answer and frame numbers restart with
     * every call, so the playout resets HERE, on the same serialized receive
     * path that classifies frames — provably before every frame of the call
     * it belongs to.
     */
    iterate_kit_playout_reset(&runtime.playout, 1U);
    (void)abandon_speaker_audio();
    atomic_store_explicit(
        &runtime.speaker_answer_done, false, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_declared_done, false, memory_order_release);
    ESP_LOGI(tag, "new call accepted: playout reset for a fresh sender");
    havpe_ui_set_call_active(true);
    havpe_ui_set_state(HAVPE_UI_IDLE);
    havpe_ui_set_status("hold the button to talk");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    /*
     * Drop whatever is still queued — the ring holds thirty seconds, and a
     * call that ends mid-answer would otherwise play the dead conversation
     * out. The BELIEF ends here; the INTENT does not: only a person changes
     * intent, so a provider-side call end reconnects instead of waiting for
     * another press.
     */
    (void)abandon_speaker_audio();
    havpe_ui_set_call_active(false);
    havpe_ui_set_state(HAVPE_UI_IDLE);
    havpe_ui_set_status(
        havpe_ui_call_requested() ? "reconnecting" : "call ended");
  }
}

/* Transcript drives the coarse screen state; no transcript is retained. */
static void on_transcript(
    void *context, bool from_user, const char *text, bool final) {
  (void)context;
  (void)text;
  (void)final;
  if (!from_user) {
    havpe_ui_set_state(HAVPE_UI_SPEAKING);
  }
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
   * flush before publishing speaker_reprime. This task owns only the
   * portable playout clock, so it resets that clock exactly once per epoch.
   */
  iterate_kit_voice_playback_clock_reprime(playout_clock);
  return true;
}

static void playback_task(void *argument) {
  static struct speaker_frame frame;
  /*
   * The writer NEVER stops while an answer is under way, and it never
   * conceals: when the source is dry, stop calling write — see the Waveshare
   * port for the measured history. This board is full duplex, so there is
   * no half-duplex fence here and no amplifier to gate.
   */
  struct iterate_kit_voice_playback_clock playout_clock;
  uint64_t last_write_ms = 0U;
  iterate_kit_voice_playback_clock_init(&playout_clock);
  (void)argument;
  for (;;) {
    size_t received;

    (void)playback_apply_reprime(&playout_clock);
    if (atomic_exchange_explicit(
            &runtime.speaker_answer_done, false, memory_order_acq_rel)) {
      iterate_kit_voice_playback_clock_answer_done(&playout_clock);
    }
    if (!iterate_kit_voice_playback_clock_ready(
            &playout_clock, speaker_queued_bytes())) {
      /*
       * NOT FEEDING, SO NOT WATCHING: leaving the watch armed across the
       * priming wait made the DAC's correct silence read as starvation at
       * every boundary that re-primes.
       */
      havpe_audio_watch(false);
      ++runtime.speaker_waits_priming;
      /* Idle, not starving: nothing is playing, so write nothing. */
      DELAY_MS(5);
      continue;
    }

    /*
     * ARMED ACROSS THE WAIT UNLESS THE ANSWER IS OVER. The one case where a
     * dry ring is legitimate is an answer that is over: `response.done`
     * arrived and the tail is draining.
     */
    if (atomic_load_explicit(
            &runtime.answer_declared_done, memory_order_acquire)) {
      havpe_audio_draining();
      havpe_audio_watch(false);
    }
    received = xQueueReceive(
                   runtime.speaker_queue,
                   &frame,
                   pdMS_TO_TICKS(SPEAKER_DRY_WAIT_MS)) == pdTRUE
        ? FRAME_BYTES
        : 0U;

    /*
     * A REPRIME REQUESTED WHILE WE WERE BLOCKED STILL COUNTS: a new answer's
     * first frame routinely arrives inside the wait. Put the whole tagged
     * frame back at the head so opening prefill includes it; a frame from a
     * raced older replacement is already stale by generation.
     */
    if (received > 0U && playback_apply_reprime(&playout_clock)) {
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
      continue;
    }

    if (received == 0U) {
      /*
       * DRY. WRITE NOTHING AND COME BACK. Silence written into the ring
       * occupies playout time and can never be taken back; an actually empty
       * ring already clocks out clean zeros.
       */
      havpe_audio_watch(false);
      /*
       * The answer has finished being HEARD — but only if the sender had
       * already declared it complete. A dry buffer mid-answer is starvation,
       * not an ending.
       */
      if (atomic_load_explicit(
              &runtime.answer_declared_done, memory_order_acquire)) {
        iterate_kit_playout_mark_drained(&runtime.playout);
      }
      ++runtime.speaker_waits_dry;
      if (iterate_kit_voice_playback_clock_empty(
              &playout_clock, now_ms(NULL)) ==
          ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) {
        /* Telemetry only: how often the source could not keep up. */
        ++runtime.speaker_conceal_frames;
        atomic_store_explicit(
            &runtime.starve_at_ms, now_ms(NULL), memory_order_release);
      }
      continue;
    }

    if (frame.generation != atomic_load_explicit(
                                &runtime.speaker_generation,
                                memory_order_acquire)) {
      /* A replacement raced this frame after it left the queue. */
      (void)atomic_fetch_add_explicit(
          &runtime.speaker_discarded_frames, 1U, memory_order_relaxed);
      havpe_audio_watch(false);
      continue;
    }

    /*
     * Flooded: skip a frame to catch up — the symmetric counterpart to
     * concealment, counted honestly. Lateness is measured against the audio
     * timeline, never queue depth.
     */
    {
      const enum iterate_kit_voice_playback_action action =
          iterate_kit_voice_playback_clock_frame(
              &playout_clock,
              speaker_queued_bytes(),
              runtime.speaker_frames_played,
              iterate_kit_voice_playout_lag_ms(
                  atomic_load_explicit(
                      &runtime.answer_started_ms, memory_order_acquire),
                  atomic_load_explicit(
                      &runtime.answer_emitted_ms, memory_order_acquire),
                  now_ms(NULL)),
              now_ms(NULL));
      if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP) {
        /*
         * A SKIPPED FRAME STILL SPENT ITS PLACE IN THE TIMELINE — advancing
         * here is what makes "skip until level" terminate.
         */
        ++runtime.speaker_catchup_frames;
        (void)atomic_fetch_add_explicit(
            &runtime.answer_emitted_ms,
            (uint32_t)(received / (FRAME_BYTES / FRAME_MS)),
            memory_order_acq_rel);
        continue;
      }
      /* Pay the debt: one frame concealed, one late frame dropped. */
      if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_DEBT) {
        ++runtime.speaker_debt_paid;
        continue;
      }
    }

    const uint64_t write_started_ms = now_ms(NULL);
    havpe_audio_watch(true);
#ifdef ITERATE_KIT_DIAGNOSTIC_STARVATION
    /*
     * FAULT INJECTION, and it must land where a real gap would: after the
     * arm, gated on a full ring already credited.
     */
    if (havpe_audio_starvation_pending() &&
        havpe_audio_written_ms() >= DMA_RING_CREDIT_MS) {
      const uint32_t starve_ms = havpe_audio_take_injected_starvation();
      ESP_LOGW(
          tag, "injecting %ums of starvation mid-answer",
          (unsigned)starve_ms);
      DELAY_MS(starve_ms);
    }
#endif
    /*
     * Admission is nonblocking. The hardware-owner task reserves the DMA
     * ledger immediately before its blocking write; this task waits at most
     * five frame periods for bounded queue headroom.
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
       * HOW FAR BEHIND REALTIME THIS ANSWER HAS FALLEN — stamped BEFORE the
       * write, so hardware pacing is not folded into the measurement.
       */
      {
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
    last_write_ms = now_ms(NULL);
    atomic_store_explicit(
        &runtime.speaker_last_write_ms, last_write_ms, memory_order_release);
  }
}

/* --- microphone path ------------------------------------------------------ */

static void capture_task(void *argument) {
  static struct mic_frame near_frame;
  static struct mic_frame processed_frame;
  (void)argument;
  for (;;) {
    size_t sample_count = 0U;
    const enum iterate_kit_status read_status = iterate_kit_audio_codec_read(
        &runtime.codec,
        near_frame.samples,
        NULL,
        FRAME_SAMPLES,
        &sample_count);
    if (read_status == ITERATE_KIT_UNAVAILABLE) {
      DELAY_MS(1);
      continue;
    }
    if (read_status != ITERATE_KIT_OK || sample_count != FRAME_SAMPLES) {
      ++runtime.mic_process_failures;
      DELAY_MS(1);
      continue;
    }
    const struct iterate_kit_audio_processor_frame process_frame = {
      .near = near_frame.samples,
      .reference = NULL,
      .playout_activity = NULL,
      .output = processed_frame.samples,
      .sample_count = sample_count,
    };
    if (iterate_kit_audio_processor_process(
            &runtime.processor, &process_frame) != ITERATE_KIT_OK) {
      /* The wrapper silences output; fail closed and transmit nothing. */
      ++runtime.mic_process_failures;
      continue;
    }
    ++runtime.mic_frames_captured;
    /*
     * WHAT THE RING SHOWS WHILE SOMEBODY IS TALKING. Without this the
     * microphone sector could only say "open", never "hearing you", and a
     * board with no screen then looks identical whether it is listening or
     * deaf — which is exactly how it was reported. One pass over a 20 ms
     * frame, on the task that already owns these samples.
     */
    {
      int32_t peak = 0;
      for (size_t index = 0U; index < FRAME_SAMPLES; ++index) {
        const int32_t sample = processed_frame.samples[index];
        const int32_t magnitude = sample < 0 ? -sample : sample;
        if (magnitude > peak) peak = magnitude;
      }
      havpe_ui_set_microphone_peak((uint32_t)peak);
      /*
       * The same peak, kept as the evidence a barge-in has to point at. Taken
       * BEFORE the make-up gain: amplifying the residual first is exactly how
       * an echo gets mistaken for a voice.
       */
      iterate_kit_barge_in_observe(
          &runtime.barge_in, (uint32_t)peak, now_ms(NULL));
      /*
       * ...and keep it where health() can be asked, because the barge-in
       * threshold below has to be chosen from measured numbers rather than
       * from a plausible-looking constant.
       */
      atomic_store_explicit(
          &runtime.mic_peak, (unsigned int)peak, memory_order_relaxed);
      if ((unsigned int)peak > atomic_load_explicit(
                                   &runtime.mic_peak_max,
                                   memory_order_relaxed)) {
        atomic_store_explicit(
            &runtime.mic_peak_max, (unsigned int)peak, memory_order_relaxed);
      }
    }
    /*
     * NOBODY IS LISTENING, SO DO NOT QUEUE. Capture runs continuously on
     * this full-duplex board; frames outside an open turn are counted and
     * discarded here so the drop counter keeps meaning "speech somebody
     * said was lost".
     */
    if (!runtime.talking) {
      ++runtime.mic_frames_idle;
      continue;
    }
    if (xQueueSend(runtime.mic_queue, &processed_frame, 0) != pdTRUE) {
      /* Freshest wins: discard the OLDEST frame, keep this one. */
      struct mic_frame discarded;
      (void)xQueueReceive(runtime.mic_queue, &discarded, 0);
      (void)xQueueSend(runtime.mic_queue, &processed_frame, 0);
      ++runtime.mic_frames_dropped;
    }
  }
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

static enum iterate_kit_status handle_device_event(
    void *context, const struct iterate_kit_device_event *event) {
  (void)context;
  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      /*
       * Unreachable: this board does not mount push-to-talk, because its
       * microphone is open for the whole call. Answering "invalid" rather
       * than "ok" keeps that true if the module is ever mounted by mistake.
       */
      break;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
      havpe_ui_request_call(true);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      havpe_ui_request_call(false);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      break;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

/* Defined beside health_json, which it adapts; declared here for the mount. */
static size_t render_health(void *context, char *out, size_t capacity);


/* The one board-specific fact the portable speaker capability needs. */
static enum iterate_kit_status speaker_set_volume(
    void *context, uint8_t percent, uint8_t *applied) {
  (void)context;
  return havpe_audio_set_volume(percent, applied);
}

static uint8_t speaker_volume(void *context) {
  (void)context;
  return havpe_audio_volume();
}


/* --- the XMOS pipeline, as something a person can move and then measure ---- */

/*
 * BOARD-LOCAL ON PURPOSE. Every other device here mounts portable capability
 * modules, and this one is not portable: it is a handle on the XMOS taps that
 * only this board has. It exists because an echo canceller cannot be argued
 * about, only measured, and measuring it means putting the SAME microphone on
 * both output channels — one raw, one cancelled — which needs a knob rather
 * than a rebuild.
 */
static const char *const aec_set_stage_path[] = {"aec", "setStage"};

static enum capnweb_status aec_set_stage(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value object = {0};
  int64_t channel = 0;
  int64_t stage = 0;
  (void)context;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "channel", &channel) ||
      !iterate_kit_read_int_field(&object, "stage", &stage)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "aec.setStage needs {channel, stage}");
  }
  if (channel < 0 || channel > 1 || stage < 0 || stage > 4) {
    return capnweb_reply_set_error(
        reply,
        "RangeError",
        "channel is 0 or 1; stage is 0 none, 1 aec, 2 ic, 3 ns, 4 agc");
  }
  if (havpe_audio_set_pipeline_stage((uint8_t)channel, (uint8_t)stage) !=
      ITERATE_KIT_OK) {
    return capnweb_reply_set_error(
        reply, "Error", "the XMOS refused the pipeline change");
  }
  return capnweb_reply_set_boolean(reply, true);
}

static struct iterate_kit_module aec_module(void) {
  static const struct iterate_kit_method methods[] = {
    {aec_set_stage_path, 2U, aec_set_stage},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = NULL,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}

static bool initialise_connection(void) {
  static const char *const mount_path[] = {"kit", "homeAssistantVoicePreviewEdition"};
  static struct iterate_kit_module modules[5];
  static struct iterate_kit_speaker speaker;
  static struct iterate_kit_health health;
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
  modules[module_count++] = aec_module();
  /*
   * TURN IT UP. Every board here shipped at a volume somebody measured once
   * and nobody could change without a reflash, and all four were reported as
   * too quiet. The driver keeps its ceiling; the knob is now a call away.
   */
  {
    const struct iterate_kit_speaker_driver driver = {
      .context = NULL,
      .set_volume = speaker_set_volume,
      .volume = speaker_volume,
      .ceiling = 100,
    };
    if (iterate_kit_speaker_init(&speaker, &driver) == ITERATE_KIT_OK) {
      modules[module_count++] = iterate_kit_speaker_module(&speaker);
    }
  }
  /*
   * ASKABLE. The same document this device pushes as dev-stats, on demand,
   * because the pushed copy only reaches whoever was already listening — and
   * the other way to interrogate a quiet board is its console, which on this
   * hardware REBOOTS it.
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
  peer_options = (struct iterate_kit_peer_options){
    peer_description,
    sizeof(peer_description) - 1U,
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
  options.send_text_context = &runtime.transport;
  options.project_id = runtime.configuration.project_id;
  options.project_api_key = runtime.configuration.project_api_key;
  options.mount_path = mount_path;
  options.mount_path_count = sizeof(mount_path) / sizeof(mount_path[0]);
  options.capability = iterate_kit_peer_capability(&runtime.peer);
  options.instructions = instructions;
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
             &runtime.transport, &transport_options) == ITERATE_KIT_OK;
}

/*
 * ONE description of how the device is, used by both the telemetry it pushes
 * and any future pull. PURE: this serializes local statistics and records
 * nothing — reachability comes from inbound dispatches, which no amount of
 * outbound telemetry can inflate. A name is written next to the value it
 * names, and one loop emits the pairs, because two hand-aligned lists of
 * sixty drifted twice on the reference port.
 */
static size_t health_json(char *out, size_t capacity) {
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

  iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &metrics);
  iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox_metrics);

  /*
   * The gate every producer sits behind. Closed, the device answers RPCs and
   * does nothing else — which is exactly what a broken one looks like, so it
   * is reported rather than inferred.
   */
  const bool gate_open =
      (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY) &&
      runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
      runtime.voicelab_generation == runtime.connection.generation;

  const struct field fields[] = {
    {"connectionState", (uint32_t)runtime.connection.state},
    {"seq", runtime.stats_sequence++},
    {"framesSent", runtime.voicelab.frames_sent},
    {"frameFailures", runtime.voicelab.frame_send_failures},
    {"micCaptured", runtime.mic_frames_captured},
    {"micDropped", runtime.mic_frames_dropped},
    {"micProcessFailures", runtime.mic_process_failures},
    {"codecCaptureOverruns", havpe_audio_capture_overruns()},
    {"codecCaptureFailures", havpe_audio_capture_driver_failures()},
    {"micIdle", runtime.mic_frames_idle},
    {"micPeak",
     atomic_load_explicit(&runtime.mic_peak, memory_order_relaxed)},
    {"micPeakMax",
     atomic_load_explicit(&runtime.mic_peak_max, memory_order_relaxed)},

    {"spkFrames", runtime.voicelab.spk_frames_received},
    {"spkPlayed", runtime.speaker_frames_played},
    {"spkOverflow",
     atomic_load_explicit(
         &runtime.speaker_overflow_drops, memory_order_relaxed)},
    /* Audio arriving just after a software-dry tick. Same signal, one on. */
    {"spkSoftDryRefills", runtime.speaker_underruns},
    /* The task-side starvation measure: ms the ring was empty, how often. */
    {"spkStarvedMs", havpe_audio_starved_ms()},
    {"spkStarveEvents", havpe_audio_starve_events()},
    /*
     * SOFTWARE-BUFFER LATENESS, absorbed by the hardware ring — not an
     * audible gap, and named so nobody gates on it. spkStarvedMs is the
     * audible-failure gate.
     */
    {"spkSoftDryTicks", runtime.speaker_conceal_frames},
    {"spkCatchup", runtime.speaker_catchup_frames},
    {"spkDebtPaid", runtime.speaker_debt_paid},
    {"spkWriteFailures", runtime.speaker_write_failures},
    {"codecPlaybackFailures", havpe_audio_playback_driver_failures()},
    {"captureGainClipped", havpe_audio_capture_gain_clipped()},
    /* The AEC oracle: cleanPeak/rawPeak while speaking IS the cancellation. */
    {"captureGain", havpe_audio_capture_gain()},
    {"micRawPeak", havpe_audio_capture_raw_peak()},
    {"micCleanPeak", havpe_audio_capture_clean_peak()},
    {"speakerPlaying", havpe_audio_speaker_is_playing() ? 1U : 0U},
    {"aecUplinkStage", havpe_audio_pipeline_stage(0U)},
    {"aecDiagnosticStage", havpe_audio_pipeline_stage(1U)},
    {"echoRawPeak", havpe_audio_capture_echo_raw_peak()},
    {"echoCleanPeak", havpe_audio_capture_echo_clean_peak()},
    /* Driver-level DMA overflows: the slave buses' own loss signals. */
    {"captureQueueOverflows", havpe_audio_capture_queue_overflows()},
    {"playbackQueueOverflows", havpe_audio_playback_queue_overflows()},
    {"spkMarginMaxMs", runtime.speaker_margin_max_ms},
    {"spkLagMaxMs", runtime.speaker_lag_max_ms},
    {"spkMarginMinMs", runtime.speaker_margin_min_ms},
    {"spkWrites", runtime.speaker_writes},
    {"spkBadFrames", runtime.speaker_bad_frames},
    {"spkSeqGaps", runtime.playout.gaps},
    {"spkDecodeFailures", runtime.voicelab.spk_decode_failures},
    {"spkDiscarded",
     atomic_load_explicit(
         &runtime.speaker_discarded_frames, memory_order_relaxed)},
    /*
     * The playout's own census: the four refusals the classifier decides.
     * Without them a refused frame leaves no trace at all.
     */
    {"spkIgnoredCall", runtime.playout.ignored_other_call},
    {"spkIgnoredStale", runtime.playout.ignored_stale_answer},
    {"spkIgnoredDup", runtime.playout.ignored_duplicate},
    /* NORMAL TRANSITIONS, named so nobody tiers them as faults again. */
    {"spkAnswerStarts", runtime.playout.replaced},
    {"spkSupersededMidplay", runtime.playout.superseded_midplay},
    {"spkWaitPriming", runtime.speaker_waits_priming},
    {"spkAnswerDrains", runtime.speaker_waits_dry},
    {"bargeIns", runtime.barge_in_flushes},
    /* Refused for want of evidence: high here means the room, not a person. */
    {"bargeInsRejected", runtime.barge_in_rejected},
    /* Echo this device declined to send the provider; the self-cancel fix. */
    {"echoFramesMuted", havpe_audio_echo_frames_muted()},
    {"turnMarkerFailures", runtime.turn_marker_failures},
    {"batches", runtime.voicelab.batches_on_connection},
    {"connGeneration", runtime.voicelab.connection_generation},
    {"rttMs", runtime.voicelab.last_rtt_ms},
    {"pings", runtime.voicelab.ping_count},
    {"pingFailures", runtime.voicelab.ping_failures},
    {"livenessRestarts", runtime.liveness_restarts},
    {"idleRemounts", runtime.mount_watchdog.remounts},
    /* Inbound capability dispatches served: the liveness proof. */
    {"servedDispatches", iterate_kit_peer_served_dispatches(&runtime.peer)},
    {"bridgeLosses", runtime.bridge_losses},
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
    {"resetReason", (uint32_t)esp_reset_reason()},
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
    {"psramFree", (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM)},
    {"dmaLargest",
     (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_DMA)},
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

  char clock[20];
  if (!clock_slug(clock, sizeof(clock))) clock[0] = '\0';

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
      "\"callActive\":%s,\"callPending\":%s,\"wantsCall\":%s,\"talking\":%s,"
      "\"gateOpen\":%s,\"t\":%" PRIu64 ",\"uptimeMs\":%" PRIu64,
      iterate_kit_esp_idf_itx_transport_state_name(runtime.transport.state),
      iterate_kit_voicelab_state_name(runtime.voicelab.state),
      iterate_kit_voicelab_failure_name(runtime.voicelab.failure),
      stream_path,
      clock,
      runtime.voicelab.call_active ? "true" : "false",
      runtime.voicelab.call_pending ? "true" : "false",
      havpe_ui_call_requested() ? "true" : "false",
      runtime.talking ? "true" : "false",
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
      /* Name the field that did not fit: the answer is always the same. */
      ESP_LOGE(
          tag, "health json full at \"%s\" (%u bytes)", fields[index].name,
          (unsigned int)capacity);
      return 0U;
    }
    used += (size_t)written;
  }
  if (used + 2U >= capacity) return 0U;
  out[used++] = '}';
  out[used] = '\0';
  return used;
}

/*
 * The health capability's driver, and nothing more than a shape adapter. The
 * document comes from the same function the pushed telemetry uses, so the pull
 * and the push cannot describe different devices.
 *
 * PURE, as its header demands: a renderer that also stamped liveness made a
 * device renew its own lease twelve times a minute on the reference port, so a
 * board that had stopped answering still looked reachable.
 */
static size_t render_health(void *context, char *out, size_t capacity) {
  (void)context;
  return health_json(out, capacity);
}


static void append_stats(uint64_t now) {
  static const char prefix[] =
      "[{\"type\":\"events.iterate.com/voice-agent/dev-stats\",\"ephemeral\":true,\"payload\":";
  const size_t prefix_length = sizeof(prefix) - 1U;
  size_t body;
  (void)now;
  memcpy(runtime.stats_buffer, prefix, prefix_length);
  body = health_json(
      runtime.stats_buffer + prefix_length,
      sizeof(runtime.stats_buffer) - prefix_length - 3U);
  if (body == 0U) {
    ESP_LOGE(tag, "stats line does not fit — telemetry is dark");
    return;
  }
  runtime.stats_buffer[prefix_length + body] = '}';
  runtime.stats_buffer[prefix_length + body + 1U] = ']';
  (void)iterate_kit_voicelab_append_raw(
      &runtime.voicelab, runtime.stats_buffer, prefix_length + body + 2U);
}

/*
 * A CLOCK, KEPT ONLY SO A CONVERSATION CAN BE NAMED AFTER WHEN IT HAPPENED.
 * Started once, and never waited for: a device with no clock names
 * conversations from the RNG.
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
   * 2023-11-14. Any timestamp before this is the system clock's power-on
   * value rather than the real time.
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
 * A conversation nobody has had before, named after the second it was
 * started. The RNG name remains for a clock that has not arrived.
 */
static void begin_new_conversation(void) {
  char candidate[sizeof(stream_path)];
  char when[20];

  if (clock_slug(when, sizeof(when))) {
    (void)snprintf(candidate, sizeof(candidate), "/agents/voice/%s", when);
  } else {
    (void)snprintf(
        candidate, sizeof(candidate), "/agents/voice/dev-%08lx%08lx",
        (unsigned long)esp_random(), (unsigned long)esp_random());
  }
  if (iterate_kit_voicelab_setup_conversation(&runtime.voicelab, candidate) !=
      CAPNWEB_OK) {
    havpe_ui_set_state(HAVPE_UI_IDLE);
    havpe_ui_set_status("could not ask the server");
    return;
  }
  (void)snprintf(
      pending_stream_path, sizeof(pending_stream_path), "%s", candidate);
  havpe_ui_set_state(HAVPE_UI_CONNECTING);
  havpe_ui_set_status("preparing a new conversation...");
}


/*
 * A START-UP FAULT MUST BE VISIBLE, NOT A REBOOT LOOP.
 *
 * Every failure path below this point used to `return`, and the task watchdog
 * had already been subscribed by then — so the main task simply stopped
 * feeding it and the board panicked twenty seconds later, over and over.
 * From across a room that is indistinguishable from a dead device.
 *
 * So park instead: keep the watchdog fed, keep the ring alive,
 * and let the fault sit where somebody can read it.
 */
static void park_with_fault(const char *what) {
  ESP_LOGE(tag, "fatal: %s", what);
  havpe_ui_set_fault();
  havpe_ui_set_link_ready(false);
  havpe_ui_set_status(what);
  for (;;) {
    (void)esp_task_wdt_reset();
    havpe_ui_tick();
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

void iterate_kit_havpe_run(void) {
  TaskHandle_t capture_task_handle = NULL;
  /*
   * EQUAL to the network task (5), deliberately, so the two round-robin
   * instead of one starving the other. This task drains the inbox, decodes
   * speaker audio, answers every RPC, polls the buttons and sends the
   * microphone; the measured history of both wrong settings is in the
   * Waveshare port.
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
    return;
  }
  /*
   * Subscribe only after provisioning succeeds; an intentionally
   * unprovisioned board returns to its setup path. From here onward this
   * task owns every recovery path, so a stall must still reboot loudly.
   */
  (void)esp_task_wdt_add(NULL);
  if (!havpe_ui_init()) {
    ESP_LOGE(tag, "ring/button bring-up failed");
    return;
  }
  havpe_ui_set_state(HAVPE_UI_CONNECTING);
  havpe_ui_set_status("connecting to iterate");
  runtime.mic_queue = xQueueCreate(MIC_QUEUE_DEPTH, sizeof(struct mic_frame));
  /*
   * PSRAM, not internal. Each queue item is one indivisible 20 ms frame plus
   * its answer generation; FreeRTOS synchronizes reset with receive, and the
   * generation rejects a frame a consumer had already copied when reset ran.
   */
  runtime.speaker_queue = xQueueCreateWithCaps(
      SPEAKER_QUEUE_DEPTH, sizeof(struct speaker_frame), MALLOC_CAP_SPIRAM);
  if (runtime.mic_queue == NULL || runtime.speaker_queue == NULL) {
    park_with_fault("audio buffer allocation failed");
  }
  if (!initialise_rings() || !initialise_connection()) {
    park_with_fault("bounded runtime initialization failed");
  }
  iterate_kit_playout_reset(&runtime.playout, 1U);
  /*
   * THE RADIO GOES FIRST, AND THE AUDIO BOOTS WHILE IT ASSOCIATES.
   *
   * This board's audio bring-up is legitimately long — a 3 s XMOS boot plus
   * the AIC3204's 2.5 s analogue soft-start, 6.2 s measured — and it used to
   * run to completion BEFORE Wi-Fi was even started. Nothing in the transport
   * needs the codec; only the capture and playback tasks below do, and they
   * are created after both. So the two waits ran back to back for no reason,
   * and every later milestone inherited the delay: this board reached a ready
   * mount at ~14 s where the others managed ~8 s, and its first conversation
   * was prepared six seconds behind theirs.
   *
   * Wi-Fi association plus TLS plus the mount is itself ~6-8 s of waiting, so
   * overlapping the two is very nearly free.
   *
   * A RADIO THAT WILL NOT START IS NOT A FATAL FAULT, IT IS AN OFFLINE
   * DEVICE. This used to return, which — with the watchdog already
   * subscribed — turned a transient Wi-Fi start failure into a permanent
   * reboot loop. Keep trying, and keep the surface honest while trying.
   */
  while (iterate_kit_esp_idf_itx_transport_start(&runtime.transport) !=
         ITERATE_KIT_OK) {
    ESP_LOGE(
        tag,
        "transport start failed: platform=%ld — retrying",
        (long)runtime.transport.last_platform_error);
    havpe_ui_set_status("network start failed — retrying");
    for (int wait = 0; wait < 50; ++wait) {
      (void)esp_task_wdt_reset();
      havpe_ui_tick();
      vTaskDelay(pdMS_TO_TICKS(100));
    }
  }

  /*
   * ...and only now the codec, while the radio is off doing its own waiting.
   * Failing closed here still parks with the fault on the ring: a board whose
   * audio did not come up must not go on to accept a conversation.
   */
  if (!havpe_audio_init()) {
    park_with_fault("audio bring-up failed — failing closed");
  }
  runtime.codec = havpe_audio_codec();
  runtime.processor = iterate_kit_audio_processor_passthrough();
  if (iterate_kit_audio_codec_validate(&runtime.codec) != ITERATE_KIT_OK ||
      iterate_kit_audio_processor_validate(&runtime.processor) !=
          ITERATE_KIT_OK ||
      runtime.codec.properties->capture_sample_rate_hz !=
          runtime.processor.properties->sample_rate_hz ||
      runtime.processor.properties->frame_samples != FRAME_SAMPLES ||
      (runtime.processor.properties->requires_reference_channel &&
       !runtime.codec.properties->has_reference_channel) ||
      iterate_kit_audio_processor_reset(&runtime.processor) !=
          ITERATE_KIT_OK) {
    park_with_fault("incompatible codec and audio processor");
  }
  if (xTaskCreatePinnedToCore(
          capture_task,
          "vl-capture",
          4096,
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
      "voicelab voice client ready: static_bytes=%u",
      (unsigned int)sizeof(runtime));

  uint64_t next_stats_at = 0;
  uint64_t next_ping_at = 0;
  uint64_t next_button_poll_at = 0;

  for (;;) {
    (void)esp_task_wdt_reset();
    (void)iterate_kit_esp_idf_itx_transport_poll(&runtime.transport, 16U);
    if (now_ms(NULL) >= next_button_poll_at) {
      next_button_poll_at = now_ms(NULL) + BUTTON_POLL_MS;
      havpe_button_poll();
    }
    /*
     * Give the capability modules a turn: a deferred reply is only a promise
     * that something will come back to it; this is the something.
     */
    (void)iterate_kit_peer_poll(&runtime.peer, now_ms(NULL));
    (void)iterate_kit_device_event_poll(
        &runtime.device_events, ITERATE_KIT_VOICE_DEVICE_EVENT_POLL_BUDGET);
    /*
     * WHETHER THIS DEVICE CAN DO ANYTHING, published every time it changes:
     * the same gate every producer sits behind.
     */
    {
      static bool published_link_ready = true;
      const bool ready =
          runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
          runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
          runtime.voicelab_generation == runtime.connection.generation;
      if (ready != published_link_ready) {
        published_link_ready = ready;
        havpe_ui_set_link_ready(ready);
      }
    }
    havpe_ui_tick();
    if (havpe_button_take_tap()) {
      /* One button, one intent: a tap toggles whether a call is wanted. */
      const bool wanted = !havpe_ui_call_requested();
      havpe_ui_request_call(wanted);
      ESP_LOGI(tag, "tap: %s call", wanted ? "starting" : "ending");
    }
    /*
     * The hold gesture is retained by the button poller but no longer means
     * anything: with the microphone open for the whole call there is no turn
     * to hold. Holding is therefore harmless, and — importantly — a long
     * press is still NOT a tap, so leaning on the button cannot hang up.
     */

    if (runtime.transport.state != runtime.last_transport_state) {
      ESP_LOGI(
          tag,
          "transport state=%s",
          iterate_kit_esp_idf_itx_transport_state_name(
              runtime.transport.state));
      if (runtime.last_transport_state == ITERATE_KIT_ESP_IDF_ITX_READY) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        iterate_kit_esp_idf_itx_transport_metrics(
            &runtime.transport, &metrics);
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
      if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY) {
        /* The socket is up, so DNS and UDP work: ask what time it is. */
        start_clock_once();
      }
      if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_FAILED) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        havpe_ui_set_status(
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
        iterate_kit_esp_idf_itx_transport_metrics(
            &runtime.transport, &metrics);
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
      runtime.last_transport_state = runtime.transport.state;
    }

    const uint64_t now = now_ms(NULL);

    /*
     * The transport can latch a fatal state that nothing ever clears. A
     * human's remedy is the power button, so make that the device's remedy
     * too, bounded and loud.
     */
    {
      static uint64_t unhealthy_since;
      const bool healthy =
          runtime.transport.state != ITERATE_KIT_ESP_IDF_ITX_FAILED;
      if (healthy) {
        unhealthy_since = 0U;
      } else if (unhealthy_since == 0U) {
        unhealthy_since = now;
      } else if (
          iterate_kit_voice_elapsed_ms(now, unhealthy_since) >
          UNHEALTHY_RESTART_MS) {
        ESP_LOGE(
            tag,
            "transport unrecoverable for %us — restarting",
            (unsigned int)(UNHEALTHY_RESTART_MS / 1000U));
        esp_restart();
      }
    }

    /*
     * LIVENESS, not optimism: a half-open TCP connection is indistinguishable
     * from a quiet one from this end. The ping is the only pulled call on
     * this lane, so its resolution is the single proof the far end is still
     * processing. Two remedies, in order of violence: replace the transport,
     * and if even that has not restored a round trip, restart the chip.
     */
    {
      static uint64_t last_liveness_ms;
      static uint32_t last_ping_count;
      static uint64_t next_liveness_restart_at;
      if (last_liveness_ms == 0U) last_liveness_ms = now;
      if (runtime.voicelab.ping_count != last_ping_count) {
        last_ping_count = runtime.voicelab.ping_count;
        last_liveness_ms = now;
      }
      if (runtime.transport.state != ITERATE_KIT_ESP_IDF_ITX_READY) {
        last_liveness_ms = now;
      }
      if (runtime.voicelab.ping_pending &&
          iterate_kit_voice_elapsed_ms(
              now, runtime.voicelab.ping_started_ms) > PING_TIMEOUT_MS &&
          now >= next_liveness_restart_at) {
        next_liveness_restart_at = now + PING_TIMEOUT_MS;
        ++runtime.liveness_restarts;
        ESP_LOGE(
            tag,
            "no answer to a ping in %us — replacing the transport",
            (unsigned int)(PING_TIMEOUT_MS / 1000U));
        havpe_ui_set_status("reconnecting");
        iterate_kit_esp_idf_itx_transport_request_restart(&runtime.transport);
      }
      /*
       * A prepared conversation is adopted only once the server says it is
       * ready; swapping the path first would point the device at a stream
       * with no processor on it.
       */
      if (runtime.voicelab.setup_succeeded) {
        runtime.voicelab.setup_succeeded = false;
        (void)snprintf(
            stream_path, sizeof(stream_path), "%s", pending_stream_path);
        ESP_LOGI(tag, "new conversation ready: %s", stream_path);
        havpe_ui_set_status("new conversation ready");
        stream_used = false;
        awaiting_fresh_stream = false;
        /* Remount: the mount is bound to the path it was made with. */
        runtime.voicelab_generation = 0U;
        /*
         * A conversation prepared AHEAD of a tap must not place its
         * own call — it exists so that the tap, when it comes, is
         * cheap. Only a preparation somebody asked for starts one.
         */
        if (!preparing_ahead) {
          havpe_ui_request_call(true);
        }
        preparing_ahead = false;
      }
      if (runtime.voicelab.setup_failed) {
        runtime.voicelab.setup_failed = false;
        ESP_LOGE(tag, "could not prepare %s", pending_stream_path);
        awaiting_fresh_stream = false;
        preparing_ahead = false;
        havpe_ui_request_call(false);
        havpe_ui_set_state(HAVPE_UI_IDLE);
        havpe_ui_set_status("could not start a new conversation");
      }
      if (iterate_kit_voice_elapsed_ms(now, last_liveness_ms) >
          NO_LIVENESS_RESTART_MS) {
        ESP_LOGE(
            tag,
            "no round trip in %us despite a ready transport — restarting",
            (unsigned int)(NO_LIVENESS_RESTART_MS / 1000U));
        esp_restart();
      }
    }

    if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY &&
        runtime.voicelab_generation != runtime.connection.generation) {
      /* Designated on purpose: the voicelab options struct grows fields. */
      const struct iterate_kit_voicelab_options options = {
        .session = &runtime.connection.session,
        .project_id = runtime.configuration.project_id,
        .project_api_key = runtime.configuration.project_api_key,
        .stream_path = stream_path,
        .conversation_id = CONVERSATION_ID,
        /*
         * The provider segments turns, because nothing on this device does
         * any more. Requesting the default manual turns with no turn machine
         * produces an accepted call and a deaf assistant.
         */
        .turns = "vad",
        .now_ms = now_ms,
        .clock_context = NULL,
        .on_speaker = on_speaker_pcm,
        .on_control = on_control,
        .on_transcript = on_transcript,
        .on_viseme = NULL,
        .downlink_context = NULL,
      };
      const enum capnweb_status started =
          iterate_kit_voicelab_start(&runtime.voicelab, &options);
      if (started != CAPNWEB_OK) {
        /* Rate-limited, but never silent. */
        static uint64_t next_complaint_at;
        if (now >= next_complaint_at) {
          next_complaint_at = now + 5000U;
          ESP_LOGE(
              tag, "voicelab mount will not start (status %d)", (int)started);
        }
      }
      if (started == CAPNWEB_OK) {
        runtime.voicelab_generation = runtime.connection.generation;
        runtime.frame_sequence = 0U;
        (void)xQueueReset(runtime.mic_queue); /* drop pre-session stale audio */
        /*
         * AND FORGET WHICH ANSWER WE HAD REACHED: a restarted bridge numbers
         * its first answer 0, and the latch across a reconnect otherwise
         * silences the device for the rest of the boot.
         */
        iterate_kit_playout_reset(&runtime.playout, 1U);
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
        havpe_ui_set_state(HAVPE_UI_IDLE);
        /* Being empty is the honest steady state for the status line. */
        havpe_ui_set_status("");
      } else if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED) {
        /* A dead session takes the call with it; the button starts over. */
        havpe_ui_request_call(false);
        havpe_ui_set_call_active(false);
        havpe_ui_set_state(HAVPE_UI_CONNECTING);
        havpe_ui_set_status(
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      }
    }

    /*
     * The turn's UI state is settled OUTSIDE the session gate below: the
     * user's intent and what the screen says must never depend on the
     * network being up — only the appends do.
     */
    if (runtime.talking &&
        (runtime.voicelab.state != ITERATE_KIT_VOICELAB_READY ||
         !runtime.voicelab.call_active)) {
      ESP_LOGW(tag, "microphone closed: session or call went away");
      runtime.talking = false;
      havpe_ui_set_state(HAVPE_UI_IDLE);
      havpe_ui_set_status("connection lost — press side to call");
    }

    if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
        runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.voicelab_generation == runtime.connection.generation) {
      /*
       * EVERY producer gates on outbox headroom: exhaustion is SESSION-FATAL
       * in this peer, and the measured drain is only ~25-50 messages/s.
       */
      struct iterate_kit_spsc_ring_metrics outbox_metrics;
      iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox_metrics);
      const size_t outbox_free =
          CONTROL_OUTBOX_SLOTS - outbox_metrics.current_slots;
      static struct mic_frame frame_storage[MIC_FRAMES_PER_APPEND];
      static uint64_t drain_window_at;
      static uint64_t next_call_attempt_at;
      static uint64_t next_prepare_attempt_at;
      static uint64_t call_pending_since;
      static bool call_active_shown;

      const bool wants_call = havpe_ui_call_requested();
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
       * The bridge holds the call in a Durable Object this device cannot
       * see, and it can stop without appending the conversation-ended that would say
       * so. The call is believed only while its bridge keeps proving it is
       * there; losing the proof drops the BELIEF, never the INTENT.
       */
      if (runtime.voicelab.call_active &&
          runtime.voicelab.last_bridge_ms != 0U &&
          iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_bridge_ms) >
              BRIDGE_SILENCE_MS) {
        ++runtime.bridge_losses;
        ESP_LOGE(
            tag,
            "no word from the bridge in %us — that call is gone",
            (unsigned int)(BRIDGE_SILENCE_MS / 1000U));
        iterate_kit_voicelab_forget_call(&runtime.voicelab);
        runtime.talking = false;
        havpe_ui_set_state(HAVPE_UI_CONNECTING);
        havpe_ui_set_status(
            wants_call ? "call dropped — reconnecting" : "call dropped");
        next_call_attempt_at = 0U; /* reconnect now, not on the old backoff */
      }

      /*
       * THE DOWNLINK NEEDS ITS OWN PROOF: a device can ping happily while
       * the delivery lane is dead. Silence is only evidence when traffic is
       * expected — a live bridge pongs every ping, so ten seconds without a
       * single batch means the lane is dead, not quiet.
       */
      if (wants_call &&
          runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
          runtime.voicelab.has_connection_capability &&
          !runtime.voicelab.recycle_pending && outbox_free >= 4U &&
          runtime.voicelab.last_batch_ms != 0U &&
          iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_batch_ms) >
              DOWNLINK_SILENCE_MS) {
        ++runtime.downlink_recycles;
        if (runtime.downlink_recycles_running >= 3U) {
          ESP_LOGE(
              tag,
              "downlink still dead after 3 recycles — replacing the session");
          runtime.downlink_recycles_running = 0U;
          iterate_kit_esp_idf_itx_transport_request_restart(
              &runtime.transport);
        } else {
          ++runtime.downlink_recycles_running;
          ESP_LOGW(
              tag,
              "nothing delivered for %us with a call wanted — recycling the "
              "connection (%u)",
              (unsigned int)(DOWNLINK_SILENCE_MS / 1000U),
              (unsigned int)runtime.downlink_recycles_running);
          /* Stamp the deadline forward NOW: the recycle is asynchronous. */
          runtime.voicelab.last_batch_ms = now;
          (void)iterate_kit_voicelab_recycle_connection(&runtime.voicelab);
        }
      }
      /* Any delivery at all means the lane recovered. */
      if (runtime.downlink_recycles_running > 0U &&
          runtime.voicelab.batches_on_connection > 0U) {
        runtime.downlink_recycles_running = 0U;
      }

      /*
       * call_pending is a promise that something will answer, and promises
       * expire — a start whose reply is simply lost otherwise latches it
       * true forever.
       */
      if (runtime.voicelab.call_pending && call_pending_since != 0U &&
          iterate_kit_voice_elapsed_ms(now, call_pending_since) > 20000U) {
        ESP_LOGW(tag, "call start went unanswered for 20s — trying again");
        iterate_kit_voicelab_forget_call(&runtime.voicelab);
        call_pending_since = 0U;
        next_call_attempt_at = 0U;
      }
      if (!runtime.voicelab.call_pending) call_pending_since = 0U;

      /*
       * PREPARE THE NEXT CONVERSATION BEFORE ANYBODY ASKS FOR IT.
       *
       * Every call gets its own stream, and creating one costs about seven
       * seconds on the server. Paying that AFTER the tap is most of the wait
       * between touching this device and being able to speak to it — so it is
       * paid while the device is sitting there doing nothing instead. By the
       * time a person taps, `stream_used` is already false and the only thing
       * left to do is place the call.
       */
      if (!wants_call && stream_used && !awaiting_fresh_stream &&
          !runtime.voicelab.call_active && !runtime.voicelab.call_pending &&
          outbox_free >= 3U && now >= next_prepare_attempt_at) {
        awaiting_fresh_stream = true;
        preparing_ahead = true;
        /* Slow retry: nobody is waiting on this one. */
        next_prepare_attempt_at = now + 30000U;
        ESP_LOGI(tag, "idle: preparing the next conversation in advance");
        begin_new_conversation();
      }
      if (wants_call && !runtime.voicelab.call_active &&
          !runtime.voicelab.call_pending && outbox_free >= 3U) {
        /*
         * TWO STEPS, TWO SEPARATE BACKOFFS. Starting a call from a tap means
         * preparing a fresh stream and then placing the call on it, and a
         * single shared timer made the second step serve the first one's
         * eight-second retry deadline: the stream was ready in about a
         * second and the call still sat waiting for a countdown that existed
         * only in case the PREPARE went unanswered. That is most of what
         * "tapping the screen and getting to mic takes ages" was.
         */
        if (stream_used && !awaiting_fresh_stream) {
          /*
           * This stream has a past, so the call does not happen here:
           * carrying the last conversation into this one costs the person
           * an answer that makes no sense.
           */
          if (now >= next_prepare_attempt_at) {
            awaiting_fresh_stream = true;
            next_prepare_attempt_at = now + 8000U;
            ESP_LOGI(tag, "call asked for: preparing a fresh conversation");
            begin_new_conversation();
          }
        } else if (!awaiting_fresh_stream && now >= next_call_attempt_at) {
          call_pending_since = now;
          next_call_attempt_at = now + 8000U; /* a start takes ~1-3s */
          if (iterate_kit_voicelab_start_call(&runtime.voicelab, GREETING) ==
              CAPNWEB_OK) {
            havpe_ui_set_status("starting call");
          }
        }
      }
      if (!wants_call && runtime.voicelab.call_active && outbox_free >= 3U) {
        /*
         * ENDING A CALL ABANDONS WHATEVER WAS PLAYING: the ring drains while
         * the speaker task sits armed, and that gap is ours, intended, and
         * declared at the moment we cause it.
         */
        havpe_audio_watch(false);
        (void)iterate_kit_voicelab_end_call(&runtime.voicelab, "button");
        havpe_ui_set_status("call ended");
        havpe_ui_set_state(HAVPE_UI_IDLE);
      }
      if (runtime.voicelab.call_active &&
          runtime.voicelab.call_active != call_active_shown) {
        runtime.speaker_margin_min_ms = 0U;
        runtime.speaker_writes = 0U;
      }
      if (runtime.voicelab.call_active != call_active_shown) {
        call_active_shown = runtime.voicelab.call_active;
        havpe_ui_set_call_active(call_active_shown);
        if (call_active_shown) {
          /* Marked on the ACCEPTED edge: a call that never connected left
           * no history. */
          stream_used = true;
          havpe_ui_set_state(HAVPE_UI_IDLE);
          havpe_ui_set_status("hold the button to talk");
        }
      }

      /*
       * Turn edges. Holding to talk cancels whatever is playing by dropping
       * the queued speaker audio; releasing commits the turn. The XMOS AEC
       * keeps the live speaker out of the microphone, so unlike the other
       * boards the hardware keeps running through the whole turn.
       *
       * A turn is bounded no matter what: a wedged turn is worse than a
       * truncated one because nothing is ever sent for an answer.
       */
      /*
       * NO TURN MACHINE ON THIS BOARD, AND THIS IS THE BOARD THAT DESERVES IT
       * LEAST OF ALL. It carries a dedicated XMOS DSP doing hardware echo
       * cancellation — `capture_is_echo_cancelled` is true here and false on
       * every other board — and it was nevertheless the one gated behind a
       * held button, while the StackChan, whose AEC is software, ran open-mic
       * on the provider's server VAD.
       *
       * That was backwards, and it presented as a broken device: tapping the
       * button opened a call, the ring showed one dim blue pixel meaning "call
       * up, nobody listening", and speaking into it did nothing at all,
       * because the microphone only opened while a finger was on the button.
       *
       * So the microphone rides the open call, exactly as it does on the
       * StackChan: the provider's server VAD segments turns and barge-in
       * arrives as speech_started. PTT's rationale was always the echo story
       * on boards WITHOUT echo cancellation, which is now the Stick and the
       * Waveshare and never this one.
       */
      if (runtime.talking != runtime.voicelab.call_active) {
        runtime.talking = runtime.voicelab.call_active;
        if (runtime.talking) {
          (void)xQueueReset(runtime.mic_queue); /* drop pre-call room noise */
          runtime.frame_sequence = 0U;
          havpe_ui_set_state(HAVPE_UI_LISTENING);
          havpe_ui_set_status("listening");
        }
      }

      /*
       * One shared answer to "has anything called me lately", tested on the
       * host. See mount_watchdog.h for why a device cannot tell an
       * unreachable mount from a quiet afternoon.
       */
      if (iterate_kit_mount_watchdog_due(
              &runtime.mount_watchdog,
              iterate_kit_peer_served_dispatches(&runtime.peer),
              !wants_call && !runtime.voicelab.call_active &&
                  !runtime.voicelab.call_pending,
              now)) {
        ESP_LOGW(tag, "nothing has called this device in a while — re-registering");
        havpe_ui_set_status("re-registering");
        iterate_kit_esp_idf_itx_transport_request_restart(&runtime.transport);
      }

      /* The microphone is only on the wire while a call is open. */
      {
        const size_t queued = uxQueueMessagesWaiting(runtime.mic_queue);
        const size_t needed = (size_t)MIC_FRAMES_PER_APPEND;
        /*
         * The window paces the uplink at exactly capture rate, so any
         * backlog is permanent: when one exists, send immediately instead
         * of waiting for the window.
         */
        const bool behind = queued >= (size_t)(MIC_FRAMES_PER_APPEND * 2U);
        if (runtime.talking && (behind || now >= drain_window_at) &&
            queued >= needed && outbox_free >= (size_t)MIC_OUTBOX_RESERVE) {
          const size_t take = queued < (size_t)MIC_FRAMES_PER_APPEND
              ? queued
              : (size_t)MIC_FRAMES_PER_APPEND;
          /* The window only advances on a batch that was actually sent. */
          const uint8_t *frame_pointers[MIC_FRAMES_PER_APPEND];
          size_t index;
          drain_window_at =
              (drain_window_at == 0U ||
               iterate_kit_voice_elapsed_ms(now, drain_window_at) >
                   MIC_FRAMES_PER_APPEND * FRAME_MS * 4U)
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
        }
      }
      /*
       * Recycling opens a NEW connection inline on this task — the same
       * task that decodes speaker PCM — so it waits for a quiet moment.
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
      if (next_ping_at == 0U) {
        next_ping_at = now + 1000U;
        next_stats_at = now + STATS_INTERVAL_MS;
      }
      if (now >= next_ping_at && outbox_free >= 3U) {
        (void)iterate_kit_voicelab_ping(&runtime.voicelab);
        next_ping_at = now + PING_INTERVAL_MS;
      }
      /*
       * A one-second pulse while a turn or answer is live: when the device
       * freezes mid-turn nothing else can be read out of it, so this is the
       * only way to tell a stalled APP task from a stalled TRANSPORT.
       */
      if (runtime.talking || runtime.voicelab.call_active ||
          iterate_kit_voice_elapsed_ms(now, runtime.last_pulse_ms) < 3000U) {
        if (iterate_kit_voice_elapsed_ms(now, runtime.last_pulse_ms) >=
            1000U) {
          struct iterate_kit_esp_idf_itx_transport_metrics pulse;
          iterate_kit_esp_idf_itx_transport_metrics(
              &runtime.transport, &pulse);
          runtime.last_pulse_ms = now;
          ESP_LOGI(
              tag,
              "pulse loops=%" PRIu32 " outbox=%u/%u inPub=%" PRIu32
              " inCon=%" PRIu32 " sent=%" PRIu32 " frames=%" PRIu32
              " | batches=%" PRIu32 " rx=%" PRIu32 " gaps=%" PRIu32
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
              runtime.voicelab.spk_seq_gaps,
              runtime.speaker_frames_played,
              runtime.speaker_conceal_frames,
              runtime.speaker_underruns,
              (unsigned int)(speaker_queued_bytes() / 32U));
        }
      }
      if (now >= next_stats_at && outbox_free >= 3U) {
        append_stats(now);
        next_stats_at = now + STATS_INTERVAL_MS;
      }
    }

    ++runtime.loop_count;
    DELAY_MS(5);
  }
}
