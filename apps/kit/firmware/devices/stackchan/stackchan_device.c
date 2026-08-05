/*
 * StackChan (M5Stack CoreS3) — the Iterate voice device with a face, a
 * body, and its own tuned echo canceller, on the shared single-socket lane.
 *
 * ONE Cap'n Web WebSocket to /api carries everything, exactly like the
 * Waveshare port: authenticate -> projects.get -> streams.get, 50 Hz
 * ephemeral voice-agent/mic-frame appends, and a live openConnection
 * delivering voice-agent/spk-frame events plus grok-events.
 *
 * Unlike the push-to-talk boards, the microphone rides the open call: the
 * donor's proven full-duplex model, where the ported ESP-SR VOIP AEC (fed
 * by the analogue divider reference the board wires onto ES7210 slot 1)
 * keeps the live speaker out of the uplink and the provider's server VAD
 * segments turns. Touching the screen anywhere toggles the call. The face
 * is the avatar engine on the 320x240 panel; the body MCU drives twelve
 * LEDs and the two head servos, exposed remotely as servos.move.
 *
 * Structure and supervision deliberately rhyme with the other device
 * compositions — same portable modules, same watchdogs, same telemetry
 * names — so a reader of one can read the others.
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
#include "iterate/kit/aec_capture_bridge.h"
#include "iterate/kit/capabilities/conversation.h"
#include "iterate/kit/capabilities/servos.h"
#include "iterate/kit/device_events.h"
#include "iterate/kit/conversation_lights.h"
#include "stackchan_audio.h"
#include "stackchan_avatar.h"
#include "stackchan_body.h"
#include "stackchan_processor.h"

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
  DMA_RING_CREDIT_MS = 40,
  FRAME_BYTES = ITERATE_KIT_VOICE_FRAME_BYTES,
  MIC_QUEUE_DEPTH = ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH,
  MIC_FRAMES_PER_APPEND = ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND,
  SPEAKER_BUFFER_BYTES = ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES,
  /* Whole-frame queueing makes replacement atomic at frame boundaries. */
  SPEAKER_QUEUE_DEPTH = SPEAKER_BUFFER_BYTES / FRAME_BYTES,
  /*
   * How long the playback task waits for a frame before treating the source
   * as dry: just over half of the 40 ms I2S TX DMA ring (5 descriptors x 128
   * frames at 16 kHz — the BSP patch's geometry), so a late frame is
   * absorbed by the hardware cushion rather than concealed.
   */
  SPEAKER_DRY_WAIT_MS = 25,
  SPEAKER_PREFILL_BYTES = ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES,
  SPEAKER_CONCEAL_LIMIT_MS = ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS,
  SPEAKER_HIGH_WATER_MS = ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS,
  SPEAKER_CATCHUP_EVERY = ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY,
  SPEAKER_IDLE_POWERDOWN_MS = ITERATE_KIT_VOICE_SPEAKER_IDLE_POWERDOWN_MS,
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
#define CALL_ID "scdev"
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

EXT_RAM_BSS_ATTR static struct {
  struct iterate_kit_audio_codec codec;
  struct iterate_kit_audio_processor processor;
  struct iterate_kit_aec_capture_bridge capture_bridge;
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
  /* Physical (touch) and remote call edges share one bounded owner queue. */
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
  /* Calls abandoned because their bridge stopped proving it existed. */
  uint32_t bridge_losses;
  /* Connections replaced because nothing was being delivered on them. */
  uint32_t downlink_recycles;
  uint32_t downlink_recycles_running;
  /* Diagnostics for a frozen device: see the pulse in the app loop. */
  uint32_t loop_count;
  uint64_t last_pulse_ms;
  bool talking;
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
} runtime;

/*
 * Deliberately NOT inside the PSRAM-resident runtime struct: the transport
 * embeds its network task's TCB and stack, and FreeRTOS requires static task
 * memory to live in internal RAM (xPortCheckValidTCBMem asserts on a PSRAM
 * address, which reboot-loops the board about two seconds after boot).
 */
static struct iterate_kit_esp_idf_itx_transport transport;

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
    "StackChan voice robot. Touching its screen starts and ends the call; "
    "the microphone stays open during a call (it cancels its own speaker). "
    "servos.move({yawDegrees,pitchDegrees,speed}) turns its head; audio and "
    "lifecycle events share this stream connection.";
static const char peer_description[] =
    "{\"instructions\":\"StackChan voice robot\",\"children\":{}}";

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

/* --- presentation: the face, the status rail, and the body LEDs ----------- */

/*
 * StackChan has no text screen: its whole display is the avatar owner (face
 * plus a 13-pixel status rail) and the body's 12-pixel LED run. Both consume
 * the same semantic conversation snapshot, so the state the app loop settles
 * here is published once per change (throttled inside the avatar) and
 * mirrored to the body at a 1 Hz ceiling. Status STRINGS go to the console
 * log, where the person debugging actually reads them.
 */
enum stackchan_ui_state {
  STACKCHAN_UI_IDLE = 0,
  STACKCHAN_UI_CONNECTING,
  STACKCHAN_UI_LISTENING,
  STACKCHAN_UI_SPEAKING,
};

static struct {
  enum stackchan_ui_state state;
  bool call_active;
  bool link_ready;
  bool call_requested;
  bool dirty;
  uint64_t last_body_write_ms;
  struct iterate_kit_stackchan_body *body;
} ui;

static void stackchan_ui_set_state(enum stackchan_ui_state state) {
  if (ui.state == state) return;
  ui.state = state;
  ui.dirty = true;
}

static void stackchan_ui_set_status(const char *status) {
  if (status != NULL && status[0] != '\0') {
    ESP_LOGI(tag, "status: %s", status);
  }
}

static void stackchan_ui_set_call_active(bool active) {
  if (ui.call_active == active) return;
  ui.call_active = active;
  ui.dirty = true;
}

static void stackchan_ui_set_link_ready(bool ready) {
  if (ui.link_ready == ready) return;
  ui.link_ready = ready;
  ui.dirty = true;
}

static void stackchan_ui_request_call(bool wanted) {
  ui.call_requested = wanted;
}

static bool stackchan_ui_call_requested(void) {
  return ui.call_requested;
}

static void stackchan_ui_tick(void) {
  static struct iterate_kit_conversation_visual_state shown;
  static bool shown_valid;
  const uint64_t now = now_ms(NULL);
  const bool body_due = ui.body != NULL &&
      iterate_kit_voice_elapsed_ms(now, ui.last_body_write_ms) >= 1000U;
  if (!ui.dirty && !body_due) return;
  const struct iterate_kit_conversation_visual_state visual = {
    .network = ui.link_ready ? ITERATE_KIT_NETWORK_CONNECTED
                             : ITERATE_KIT_NETWORK_CONNECTING,
    .has_wifi_rssi = false,
    .wifi_rssi_dbm = 0,
    .conversation_active = ui.call_active,
    .media_ready = ui.link_ready,
    .media_failed = false,
    .microphone_listening = runtime.talking,
    .microphone_peak = 0U,
    /* The one hardware-owned "is it speaking" fact both surfaces share. */
    .speaker_peak = iterate_kit_stackchan_avatar_speaker_status_peak(),
    .restart_armed = false,
  };
  /*
   * PUBLISH ONLY ON CHANGE — the equality helper exists for exactly this.
   * Republishing an equal snapshot every second forced the display path to
   * repaint at 1 Hz, which a person sees as the face cutting to black.
   */
  if (!shown_valid ||
      !iterate_kit_conversation_lights_equal(&visual, &shown)) {
    (void)iterate_kit_stackchan_avatar_request_status(&visual);
    if (ui.body != NULL) {
      struct iterate_kit_rgb8 pixels[ITERATE_KIT_STACKCHAN_LED_COUNT];
      uint16_t rgb565[ITERATE_KIT_STACKCHAN_LED_COUNT];
      iterate_kit_conversation_lights_render(&visual, pixels);
      for (size_t index = 0U; index < ITERATE_KIT_STACKCHAN_LED_COUNT;
           ++index) {
        rgb565[index] = (uint16_t)(((pixels[index].red >> 3) << 11) |
                                   ((pixels[index].green >> 2) << 5) |
                                   (pixels[index].blue >> 3));
      }
      (void)iterate_kit_stackchan_body_write_leds(
          ui.body, rgb565, ITERATE_KIT_STACKCHAN_LED_COUNT);
    }
    shown = visual;
    shown_valid = true;
  }
  ui.last_body_write_ms = now;
  ui.dirty = false;
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
   * running TX stream — see stackchan_audio_init().
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
  stackchan_audio_watch(false);
  stackchan_audio_note_flush();
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
    /* Barge-in: atomically invalidate and reset every queued frame. */
    (void)abandon_speaker_audio();
    iterate_kit_playout_interrupt(&runtime.playout);
    ++runtime.barge_in_flushes;
    stackchan_ui_set_state(STACKCHAN_UI_LISTENING);
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
    stackchan_ui_set_state(STACKCHAN_UI_IDLE);
    stackchan_ui_set_status("speak whenever you like");
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
    stackchan_ui_set_call_active(true);
    stackchan_ui_set_state(STACKCHAN_UI_IDLE);
    stackchan_ui_set_status("speak whenever you like");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    /*
     * Drop whatever is still queued — the ring holds thirty seconds, and a
     * call that ends mid-answer would otherwise play the dead conversation
     * out. The BELIEF ends here; the INTENT does not: only a person changes
     * intent, so a provider-side call end reconnects instead of waiting for
     * another press.
     */
    (void)abandon_speaker_audio();
    stackchan_ui_set_call_active(false);
    stackchan_ui_set_state(STACKCHAN_UI_IDLE);
    stackchan_ui_set_status(
        stackchan_ui_call_requested() ? "reconnecting" : "call ended");
  }
}

/* Transcript drives the coarse screen state; no transcript is retained. */
static void on_transcript(
    void *context, bool from_user, const char *text, bool final) {
  (void)context;
  (void)text;
  (void)final;
  if (!from_user) {
    stackchan_ui_set_state(STACKCHAN_UI_SPEAKING);
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
      stackchan_audio_watch(false);
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
      stackchan_audio_draining();
      stackchan_audio_watch(false);
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
      stackchan_audio_watch(false);
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
      stackchan_audio_watch(false);
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
    stackchan_audio_watch(true);
#ifdef ITERATE_KIT_DIAGNOSTIC_STARVATION
    /*
     * FAULT INJECTION, and it must land where a real gap would: after the
     * arm, gated on a full ring already credited.
     */
    if (stackchan_audio_starvation_pending() &&
        stackchan_audio_written_ms() >= DMA_RING_CREDIT_MS) {
      const uint32_t starve_ms = stackchan_audio_take_injected_starvation();
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

/*
 * StackChan's capture cadence is bridged, not one-to-one: the codec yields
 * raw 8 ms near/reference chunks, ESP-SR's VOIP engine wants 16 ms frames,
 * and the wire wants 20 ms. The adopted aec_capture_bridge owns that
 * conversion with exactly four DSP frames plus one wire frame of storage;
 * its process callback IS the shared processor seam, so the fail-closed
 * silence rule applies twice (seam wrapper and bridge) and raw microphone
 * can never leak around a failed canceller.
 */
static enum iterate_kit_status bridge_process(
    void *context,
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *playout_samples,
    int16_t *clean_samples,
    size_t sample_count) {
  (void)context;
  const struct iterate_kit_audio_processor_frame frame = {
    .near = near_samples,
    .reference = reference_samples,
    .playout_activity = playout_samples,
    .output = clean_samples,
    .sample_count = sample_count,
  };
  return iterate_kit_audio_processor_process(&runtime.processor, &frame);
}

static enum iterate_kit_status bridge_reset_processor(void *context) {
  (void)context;
  return iterate_kit_audio_processor_reset(&runtime.processor);
}

static enum iterate_kit_status bridge_copy_egress(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us) {
  (void)context;
  (void)sample_rate_hz;
  (void)captured_through_at_us;
  struct mic_frame frame;
  if (sample_count != FRAME_SAMPLES) {
    ++runtime.mic_process_failures;
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  ++runtime.mic_frames_captured;
  /*
   * NOBODY IS LISTENING, SO DO NOT QUEUE. The AEC upstream still saw every
   * sample — adaptation must continue through far-end-only audio — but
   * frames outside a live call are counted and discarded here so the drop
   * counter keeps meaning "speech somebody said was lost".
   */
  if (!runtime.talking) {
    ++runtime.mic_frames_idle;
    return ITERATE_KIT_OK;
  }
  memcpy(frame.samples, samples, sizeof(frame.samples));
  if (xQueueSend(runtime.mic_queue, &frame, 0) != pdTRUE) {
    /* Freshest wins: discard the OLDEST frame, keep this one. */
    struct mic_frame discarded;
    (void)xQueueReceive(runtime.mic_queue, &discarded, 0);
    (void)xQueueSend(runtime.mic_queue, &frame, 0);
    ++runtime.mic_frames_dropped;
  }
  return ITERATE_KIT_OK;
}

static void capture_task(void *argument) {
  static int16_t near_chunk[STACKCHAN_AUDIO_CHUNK_SAMPLES];
  static int16_t reference_chunk[STACKCHAN_AUDIO_CHUNK_SAMPLES];
  static int16_t activity_plane[STACKCHAN_AUDIO_CHUNK_SAMPLES];
  (void)argument;
  for (;;) {
    /*
     * A broken capture timeline (reserve overflow, DMA gap, IDF RX overflow)
     * poisons the reserve; the bridge and the adaptive filter must restart
     * on current audio before the next chunk is accepted.
     */
    if (stackchan_audio_take_epoch_reset()) {
      if (iterate_kit_aec_capture_bridge_reset(&runtime.capture_bridge) !=
          ITERATE_KIT_OK) {
        ++runtime.mic_process_failures;
      }
    }
    size_t sample_count = 0U;
    const enum iterate_kit_status read_status = iterate_kit_audio_codec_read(
        &runtime.codec,
        near_chunk,
        reference_chunk,
        STACKCHAN_AUDIO_CHUNK_SAMPLES,
        &sample_count);
    if (read_status == ITERATE_KIT_UNAVAILABLE) {
      DELAY_MS(1);
      continue;
    }
    if (read_status != ITERATE_KIT_OK ||
        sample_count != STACKCHAN_AUDIO_CHUNK_SAMPLES) {
      ++runtime.mic_process_failures;
      DELAY_MS(1);
      continue;
    }
    uint32_t sequence = 0U;
    uint64_t captured_us = 0U;
    bool content_active = false;
    stackchan_audio_last_chunk_meta(&sequence, &captured_us, &content_active);
    /*
     * The far-active plane is a policy signal sampled by the RX completion,
     * never the analogue reference: noise must not select an uplink branch.
     * The shipped constant-processed policy ignores it, but the bridge and
     * diagnostics carry it so the switched A/B policy stays measurable.
     */
    {
      const int16_t level = content_active ? 1 : 0;
      for (size_t index = 0U; index < STACKCHAN_AUDIO_CHUNK_SAMPLES;
           ++index) {
        activity_plane[index] = level;
      }
    }
    if (iterate_kit_aec_capture_bridge_push_aligned(
            &runtime.capture_bridge,
            sequence,
            captured_us,
            near_chunk,
            reference_chunk,
            activity_plane,
            STACKCHAN_AUDIO_CHUNK_SAMPLES) != ITERATE_KIT_OK) {
      ++runtime.mic_process_failures;
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

static enum iterate_kit_status servo_move(
    void *context, int32_t yaw_degrees, int32_t pitch_degrees,
    uint16_t speed) {
  struct iterate_kit_stackchan_body *body = context;
  if (body == NULL) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  return iterate_kit_stackchan_body_move_head(
      body, (int16_t)yaw_degrees, (int16_t)pitch_degrees, speed);
}

static enum iterate_kit_status handle_device_event(
    void *context, const struct iterate_kit_device_event *event) {
  (void)context;
  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
      stackchan_ui_request_call(true);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      stackchan_ui_request_call(false);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      /*
       * Deliberately refused, as the donor did: this board's microphone
       * rides the open call behind its own AEC, and a remote gate would
       * silently mute live audio.
       */
      return ITERATE_KIT_STATE_ERROR;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      break;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

static bool initialise_connection(void) {
  static const char *const mount_path[] = {"kit", "stackchan"};
  static struct iterate_kit_servos servos;
  static struct iterate_kit_module modules[2];
  size_t module_count = 0U;
  struct iterate_kit_itx_connection_options options;
  struct iterate_kit_esp_idf_itx_transport_options transport_options;
  struct iterate_kit_peer_options peer_options;

  if (ui.body != NULL) {
    /*
     * The donor envelope, enforced before any narrowing: enclosure linkage
     * and servo-horn installation define these, not the SCS0009 catalogue.
     */
    const struct iterate_kit_servo_driver driver = {
      .context = ui.body,
      .move = servo_move,
    };
    const struct iterate_kit_servo_limits limits = {
      .minimum_yaw_degrees = -128,
      .maximum_yaw_degrees = 128,
      .minimum_pitch_degrees = 0,
      .maximum_pitch_degrees = 90,
      .maximum_speed = 1000,
    };
    if (iterate_kit_servos_init(&servos, &driver, &limits) ==
        ITERATE_KIT_OK) {
      modules[module_count++] = iterate_kit_servos_module(&servos);
    }
  }
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
  options.send_text_context = &transport;
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
             &transport, &transport_options) == ITERATE_KIT_OK;
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
  struct iterate_kit_stackchan_avatar_metrics face_metrics;
  const uint64_t now = now_ms(NULL);
  size_t used;
  size_t index;
  int written;

  iterate_kit_esp_idf_itx_transport_metrics(&transport, &metrics);
  iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox_metrics);
  iterate_kit_stackchan_avatar_metrics_snapshot(&face_metrics);

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
    {"codecCaptureOverruns", stackchan_audio_capture_overruns()},
    {"codecCaptureFailures", stackchan_audio_capture_driver_failures()},
    {"micIdle", runtime.mic_frames_idle},
    {"spkFrames", runtime.voicelab.spk_frames_received},
    {"spkPlayed", runtime.speaker_frames_played},
    {"spkOverflow",
     atomic_load_explicit(
         &runtime.speaker_overflow_drops, memory_order_relaxed)},
    /* Audio arriving just after a software-dry tick. Same signal, one on. */
    {"spkSoftDryRefills", runtime.speaker_underruns},
    /* The task-side starvation measure: ms the ring was empty, how often. */
    {"spkStarvedMs", stackchan_audio_starved_ms()},
    {"spkStarveEvents", stackchan_audio_starve_events()},
    /*
     * SOFTWARE-BUFFER LATENESS, absorbed by the hardware ring — not an
     * audible gap, and named so nobody gates on it. spkStarvedMs is the
     * audible-failure gate.
     */
    {"spkSoftDryTicks", runtime.speaker_conceal_frames},
    {"spkCatchup", runtime.speaker_catchup_frames},
    {"spkDebtPaid", runtime.speaker_debt_paid},
    {"spkWriteFailures", runtime.speaker_write_failures},
    {"codecPlaybackFailures", stackchan_audio_playback_driver_failures()},
    /*
     * The AEC's own health: engine rebuilds mean the capture timeline broke;
     * clip counters catch abnormal board levels that would otherwise vanish
     * after the next metrics interval. The face's one liveness number is
     * faceFrames — a mouth that stopped moving is either that standing still
     * or the audio never arriving.
     */
    {"aecRecreates", stackchan_processor_recreates()},
    {"aecRecreateFailures", stackchan_processor_recreate_failures()},
    {"aecReferenceClipped",
     (uint32_t)stackchan_processor_reference_clipped_samples()},
    {"aecNearHighPassClipped",
     (uint32_t)stackchan_processor_near_high_pass_clipped_samples()},
    {"aecUplinkClipped",
     (uint32_t)stackchan_processor_uplink_clipped_samples()},
    {"captureEpochResets", stackchan_audio_epoch_resets()},
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
    {"faceFrames", face_metrics.analyzer_frames},
    {"faceRenderFails", face_metrics.render_failures},
    {"faceDroppedFrames", face_metrics.mailbox_overwrites},
    {"batches", runtime.voicelab.batches_on_connection},
    {"connGeneration", runtime.voicelab.connection_generation},
    {"rttMs", runtime.voicelab.last_rtt_ms},
    {"pings", runtime.voicelab.ping_count},
    {"pingFailures", runtime.voicelab.ping_failures},
    {"livenessRestarts", runtime.liveness_restarts},
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
      "\"clock\":\"%s\","
      "\"callActive\":%s,\"callPending\":%s,\"wantsCall\":%s,\"talking\":%s,"
      "\"gateOpen\":%s,\"t\":%" PRIu64 ",\"uptimeMs\":%" PRIu64,
      iterate_kit_esp_idf_itx_transport_state_name(transport.state),
      iterate_kit_voicelab_state_name(runtime.voicelab.state),
      iterate_kit_voicelab_failure_name(runtime.voicelab.failure),
      clock,
      runtime.voicelab.call_active ? "true" : "false",
      runtime.voicelab.call_pending ? "true" : "false",
      stackchan_ui_call_requested() ? "true" : "false",
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

static void append_stats(uint64_t now) {
  static const char prefix[] =
      "[{\"type\":\"voice-agent/dev-stats\",\"ephemeral\":true,\"payload\":";
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
    stackchan_ui_set_state(STACKCHAN_UI_IDLE);
    stackchan_ui_set_status("could not ask the server");
    return;
  }
  (void)snprintf(
      pending_stream_path, sizeof(pending_stream_path), "%s", candidate);
  stackchan_ui_set_state(STACKCHAN_UI_CONNECTING);
  stackchan_ui_set_status("preparing a new conversation...");
}

void iterate_kit_stackchan_run(void) {
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
  if (iterate_kit_stackchan_avatar_start() != ESP_OK) {
    ESP_LOGE(tag, "avatar/display bring-up failed");
    return;
  }
  /*
   * The body MCU is optional at boot: a head without its body still holds a
   * conversation, so a failed probe demotes the LEDs and servos rather than
   * bricking the voice endpoint.
   */
  static struct iterate_kit_stackchan_body body;
  if (iterate_kit_stackchan_body_start(&body) == ESP_OK) {
    ui.body = &body;
  } else {
    ESP_LOGW(tag, "body MCU absent: LEDs and servos disabled");
  }
  if (!stackchan_audio_init()) {
    ESP_LOGE(tag, "audio bring-up failed");
    return;
  }
  /*
   * The tuned VOIP AEC engine (PSRAM state) must exist before the capture
   * bridge accepts a chunk; failing closed here beats an uncancelled mic.
   */
  if (!stackchan_processor_init()) {
    ESP_LOGE(tag, "AEC bring-up failed — failing closed");
    return;
  }
  /* The mouth animates audio the hardware actually played. */
  stackchan_audio_set_playout_observer(
      iterate_kit_stackchan_avatar_observe_playout, NULL);
  runtime.codec = stackchan_audio_codec();
  runtime.processor = stackchan_processor();
  /*
   * This board's DSP frame (256 samples, fixed by ESP-SR) differs from the
   * wire frame; the adopted capture bridge owns the conversion, so the
   * composition checks the processor against the BRIDGE cadence rather than
   * FRAME_SAMPLES, and the codec's chunk grain against the bridge input.
   */
  if (iterate_kit_audio_codec_validate(&runtime.codec) != ITERATE_KIT_OK ||
      iterate_kit_audio_processor_validate(&runtime.processor) !=
          ITERATE_KIT_OK ||
      runtime.codec.properties->capture_sample_rate_hz !=
          runtime.processor.properties->sample_rate_hz ||
      runtime.processor.properties->frame_samples !=
          STACKCHAN_PROCESSOR_FRAME_SAMPLES ||
      (runtime.processor.properties->requires_reference_channel &&
       !runtime.codec.properties->has_reference_channel) ||
      iterate_kit_audio_processor_reset(&runtime.processor) !=
          ITERATE_KIT_OK) {
    ESP_LOGE(tag, "incompatible codec and audio processor");
    return;
  }
  {
    static int16_t bridge_near[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
    static int16_t bridge_reference[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
    static int16_t bridge_playout[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
    static int16_t bridge_clean[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
    static int16_t bridge_egress[FRAME_SAMPLES];
    const struct iterate_kit_aec_capture_bridge_options bridge_options = {
      .sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
      .processing_frame_samples = STACKCHAN_PROCESSOR_FRAME_SAMPLES,
      .egress_frame_samples = FRAME_SAMPLES,
      .near_frame = bridge_near,
      .reference_frame = bridge_reference,
      .playout_frame = bridge_playout,
      .clean_frame = bridge_clean,
      .processing_frame_capacity = STACKCHAN_PROCESSOR_FRAME_SAMPLES,
      .egress_frame = bridge_egress,
      .egress_frame_capacity = FRAME_SAMPLES,
      .processor_context = NULL,
      .process = bridge_process,
      .reset_processor = bridge_reset_processor,
      .egress_context = NULL,
      .copy_egress = bridge_copy_egress,
    };
    if (iterate_kit_aec_capture_bridge_init(
            &runtime.capture_bridge, &bridge_options) != ITERATE_KIT_OK) {
      ESP_LOGE(tag, "capture bridge initialization failed");
      return;
    }
  }
  stackchan_ui_set_state(STACKCHAN_UI_CONNECTING);
  stackchan_ui_set_status("connecting to iterate");
  runtime.mic_queue = xQueueCreateWithCaps(
      MIC_QUEUE_DEPTH, sizeof(struct mic_frame), MALLOC_CAP_SPIRAM);
  /*
   * PSRAM, not internal. Each queue item is one indivisible 20 ms frame plus
   * its answer generation; FreeRTOS synchronizes reset with receive, and the
   * generation rejects a frame a consumer had already copied when reset ran.
   */
  runtime.speaker_queue = xQueueCreateWithCaps(
      SPEAKER_QUEUE_DEPTH, sizeof(struct speaker_frame), MALLOC_CAP_SPIRAM);
  if (runtime.mic_queue == NULL || runtime.speaker_queue == NULL) {
    ESP_LOGE(tag, "audio buffer allocation failed");
    return;
  }
  if (!initialise_rings() || !initialise_connection()) {
    ESP_LOGE(tag, "bounded runtime initialization failed");
    return;
  }
  iterate_kit_playout_reset(&runtime.playout, 1U);
  if (iterate_kit_esp_idf_itx_transport_start(&transport) !=
      ITERATE_KIT_OK) {
    ESP_LOGE(
        tag,
        "transport start failed: platform=%ld",
        (long)transport.last_platform_error);
    return;
  }
  /*
   * The capture task runs the esp-sr AEC inline (bridge_process ->
   * aec_process), which is far deeper than the other boards' capture paths:
   * the proven donor gave aec_process a dedicated 6144-byte stack ON TOP of
   * a 4096-byte I/O task. 4096 here trips the stack canary the moment the
   * first frame is processed.
   */
  if (xTaskCreatePinnedToCore(
          capture_task,
          "vl-capture",
          8192,
          NULL,
          16,
          &capture_task_handle,
          1) != pdPASS ||
      xTaskCreatePinnedToCore(
          playback_task, "vl-playback", 4096, NULL, 17, NULL, 1) != pdPASS) {
    if (capture_task_handle != NULL) {
      vTaskDelete(capture_task_handle);
    }
    ESP_LOGE(tag, "portable audio task creation failed");
    return;
  }
  ESP_LOGI(
      tag,
      "voicelab voice client ready: static_bytes=%u",
      (unsigned int)sizeof(runtime));

  uint64_t next_stats_at = 0;
  uint64_t next_ping_at = 0;

  for (;;) {
    (void)esp_task_wdt_reset();
    (void)iterate_kit_esp_idf_itx_transport_poll(&transport, 16U);
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
          transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
          runtime.voicelab_generation == runtime.connection.generation;
      if (ready != published_link_ready) {
        published_link_ready = ready;
        stackchan_ui_set_link_ready(ready);
      }
    }
    stackchan_ui_tick();
    if (iterate_kit_stackchan_avatar_take_call_touch_tap()) {
      /* Any coherent whole-screen tap toggles whether a call is wanted. */
      const bool wanted = !stackchan_ui_call_requested();
      stackchan_ui_request_call(wanted);
      ESP_LOGI(tag, "touch: %s call", wanted ? "starting" : "ending");
    }

    if (transport.state != runtime.last_transport_state) {
      ESP_LOGI(
          tag,
          "transport state=%s",
          iterate_kit_esp_idf_itx_transport_state_name(
              transport.state));
      if (runtime.last_transport_state == ITERATE_KIT_ESP_IDF_ITX_READY) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        iterate_kit_esp_idf_itx_transport_metrics(
            &transport, &metrics);
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
        /* The socket is up, so DNS and UDP work: ask what time it is. */
        start_clock_once();
      }
      if (transport.state == ITERATE_KIT_ESP_IDF_ITX_FAILED) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        stackchan_ui_set_status(
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
        iterate_kit_esp_idf_itx_transport_metrics(
            &transport, &metrics);
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
     * The transport can latch a fatal state that nothing ever clears. A
     * human's remedy is the power button, so make that the device's remedy
     * too, bounded and loud.
     */
    {
      static uint64_t unhealthy_since;
      const bool healthy =
          transport.state != ITERATE_KIT_ESP_IDF_ITX_FAILED;
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
      if (transport.state != ITERATE_KIT_ESP_IDF_ITX_READY) {
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
        stackchan_ui_set_status("reconnecting");
        iterate_kit_esp_idf_itx_transport_request_restart(&transport);
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
        stackchan_ui_set_status("new conversation ready");
        stream_used = false;
        awaiting_fresh_stream = false;
        /* Remount: the mount is bound to the path it was made with. */
        runtime.voicelab_generation = 0U;
        stackchan_ui_request_call(true);
      }
      if (runtime.voicelab.setup_failed) {
        runtime.voicelab.setup_failed = false;
        ESP_LOGE(tag, "could not prepare %s", pending_stream_path);
        awaiting_fresh_stream = false;
        stackchan_ui_request_call(false);
        stackchan_ui_set_state(STACKCHAN_UI_IDLE);
        stackchan_ui_set_status("could not start a new conversation");
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

    if (transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY &&
        runtime.voicelab_generation != runtime.connection.generation) {
      /* Designated on purpose: the voicelab options struct grows fields. */
      const struct iterate_kit_voicelab_options options = {
        .session = &runtime.connection.session,
        .project_id = runtime.configuration.project_id,
        .project_api_key = runtime.configuration.project_api_key,
        .stream_path = stream_path,
        .call_id = CALL_ID,
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
        stackchan_ui_set_state(STACKCHAN_UI_IDLE);
        /* Being empty is the honest steady state for the status line. */
        stackchan_ui_set_status("");
      } else if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED) {
        /* A dead session takes the call with it; the button starts over. */
        stackchan_ui_request_call(false);
        stackchan_ui_set_call_active(false);
        stackchan_ui_set_state(STACKCHAN_UI_CONNECTING);
        stackchan_ui_set_status(
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      }
    }

    /*
     * The microphone's UI state is settled OUTSIDE the session gate below:
     * the user's intent and what the face says must never depend on the
     * network being up — only the appends do.
     */
    if (runtime.talking &&
        (runtime.voicelab.state != ITERATE_KIT_VOICELAB_READY ||
         !runtime.voicelab.call_active)) {
      ESP_LOGW(tag, "microphone closed: session or call went away");
      runtime.talking = false;
      stackchan_ui_set_state(STACKCHAN_UI_IDLE);
      stackchan_ui_set_status("connection lost — tap to call");
    }

    if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
        transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
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
      static uint64_t call_pending_since;
      static bool call_active_shown;

      const bool wants_call = stackchan_ui_call_requested();

      /*
       * The bridge holds the call in a Durable Object this device cannot
       * see, and it can stop without appending the call-ended that would say
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
        stackchan_ui_set_state(STACKCHAN_UI_CONNECTING);
        stackchan_ui_set_status(
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
              &transport);
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

      if (wants_call && !runtime.voicelab.call_active &&
          !runtime.voicelab.call_pending && outbox_free >= 3U &&
          now >= next_call_attempt_at) {
        if (stream_used && !awaiting_fresh_stream) {
          /*
           * This stream has a past, so the call does not happen here:
           * carrying the last conversation into this one costs the person
           * an answer that makes no sense.
           */
          awaiting_fresh_stream = true;
          next_call_attempt_at = now + 8000U;
          ESP_LOGI(tag, "call asked for: preparing a fresh conversation");
          begin_new_conversation();
        } else if (!awaiting_fresh_stream) {
          call_pending_since = now;
          next_call_attempt_at = now + 8000U; /* a start takes ~1-3s */
          if (iterate_kit_voicelab_start_call(&runtime.voicelab, GREETING) ==
              CAPNWEB_OK) {
            stackchan_ui_set_status("starting call");
          }
        }
      }
      if (!wants_call && runtime.voicelab.call_active && outbox_free >= 3U) {
        /*
         * ENDING A CALL ABANDONS WHATEVER WAS PLAYING: the ring drains while
         * the speaker task sits armed, and that gap is ours, intended, and
         * declared at the moment we cause it.
         */
        stackchan_audio_watch(false);
        (void)iterate_kit_voicelab_end_call(&runtime.voicelab, "button");
        stackchan_ui_set_status("call ended");
        stackchan_ui_set_state(STACKCHAN_UI_IDLE);
      }
      if (runtime.voicelab.call_active &&
          runtime.voicelab.call_active != call_active_shown) {
        runtime.speaker_margin_min_ms = 0U;
        runtime.speaker_writes = 0U;
      }
      if (runtime.voicelab.call_active != call_active_shown) {
        call_active_shown = runtime.voicelab.call_active;
        stackchan_ui_set_call_active(call_active_shown);
        if (call_active_shown) {
          /* Marked on the ACCEPTED edge: a call that never connected left
           * no history. */
          stream_used = true;
          stackchan_ui_set_state(STACKCHAN_UI_IDLE);
          stackchan_ui_set_status("speak whenever you like");
        }
      }

      /*
       * NO TURN MACHINE ON THIS BOARD. The microphone rides the open call:
       * the XMOS-free StackChan carries its own tuned AEC, the provider's
       * server VAD segments turns, and barge-in arrives as speech_started —
       * the donor's proven full-duplex interaction model. This is a recorded
       * divergence from decision A2: PTT's rationale is the echo story on
       * boards WITHOUT echo cancellation, and gating this microphone would
       * defeat the ported AEC's entire purpose.
       */
      if (runtime.talking != runtime.voicelab.call_active) {
        runtime.talking = runtime.voicelab.call_active;
        if (runtime.talking) {
          (void)xQueueReset(runtime.mic_queue); /* drop pre-call room noise */
          runtime.frame_sequence = 0U;
          stackchan_ui_set_state(STACKCHAN_UI_LISTENING);
          stackchan_ui_set_status("listening");
        }
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
              &transport, &pulse);
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
