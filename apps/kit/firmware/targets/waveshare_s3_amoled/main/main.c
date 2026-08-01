/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 — the Iterate voice device.
 *
 * The whole product is here: an on-screen Iterate UI (start call / hang up,
 * live transcript), a live capability at kit.waveshare so an agent can drive
 * the screen and the call, and the voice pipe itself.
 *
 * ONE Cap'n Web WebSocket to /api carries everything, exactly like the
 * TypeScript voicelab client: authenticate -> projects.get -> streams.get,
 * then 50 Hz one-way appends of ephemeral voicelab/mic-frame events (real
 * ES8311 microphone), and a live openConnection callback delivering
 * voicelab/spk-frame events (decoded to the speaker) plus grok-events
 * (speech_started = barge-in flush, response.done = end of answer,
 * transcript deltas to the screen).
 *
 * Nothing runs off-device: pressing "start call" calls the project's OWN
 * userspace worker (itx.worker.startCall) over that same socket, and the
 * worker holds the Grok session detached. No laptop bridge, no second
 * connection.
 *
 * Turn taking is MANUAL, like the M5StickS3: no VAD anywhere. BOOT toggles
 * the call, PWR is held while speaking. Nothing is sent from the microphone
 * unless PWR is down, which is also the whole echo story on a board with no
 * AEC reference — the speaker is never live into an open microphone, and
 * pressing PWR cancels an answer in flight instead of talking over it.
 *
 * Observability is the stream itself (durable voicelab/dev-stats every 5s);
 * opening the USB console resets the board.
 *
 * DELIBERATE DEPARTURE from the dual-WebSocket decision in
 * docs/fable-v2-plan/DECISIONS.md — this target is the single-socket
 * measurement that decision asked for.
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

#include "capnweb/capnweb.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voicelab_stream.h"
#include "waveshare_audio.h"
#include "waveshare_buttons.h"
#include "waveshare_display.h"
#include "waveshare_tools.h"

static const char tag[] = "iterate-voicelab";

/* PSRAM-resident: 256 KiB would crowd internal RAM out of TLS headroom. */
EXT_RAM_BSS_ATTR static uint8_t
    inbox_storage_psram[64][4096];

enum {
  PENDING_CALL_CAPACITY = 8,
  EXPORT_CAPACITY = 4,
  IMPORT_CAPACITY = 16,
  /*
   * Replies to pulled calls and inbound delivery batches both parse inside
   * this budget; exhaustion is a session-terminal abort, so it is sized for
   * the largest legitimate message (a 2-event capped delivery batch).
   */
  TOKEN_CAPACITY = 256,
  OUTPUT_CAPACITY = 128,
  /*
   * Inbox slots take one whole delivery batch each (the connection is opened
   * with maxDeliveryBytes 2600 + envelope); outbox slots take one ~1.05 KiB
   * mic-frame push. 4 KiB covers both with margin.
   */
  CONTROL_SLOT_CAPACITY = 4096,
  /*
   * The inbox rides PSRAM (256 KiB): speaker audio arrives as ~1.3 KiB
   * delivery batches and a paced answer still clumps at TCP granularity;
   * 64 slots absorb a full clump without tripping the terminal
   * message-loss path.
   */
  CONTROL_INBOX_SLOTS = 64,
  CONTROL_OUTBOX_SLOTS = 16,
  FRAME_MS = 20,
  FRAME_SAMPLES = WAVESHARE_AUDIO_FRAME_SAMPLES,
  FRAME_BYTES = FRAME_SAMPLES * 2,
  MIC_QUEUE_DEPTH = 32,
  /* 1 MiB of PSRAM speaker staging ≈ 32 s of audio — Grok bursts whole
   * answers; barge-in flushes this, underrun never should. */
  SPEAKER_BUFFER_BYTES = 1024 * 1024,
  STATS_INTERVAL_MS = 5000,
  PING_INTERVAL_MS = 5000,
};

#define STREAM_PATH "/voicelab/dev-waveshare"
#define CALL_ID "wsdev"
#define GREETING "Hi, I am your Iterate device. What can I do for you?"

struct mic_frame {
  int16_t samples[FRAME_SAMPLES];
};

static struct {
  struct iterate_kit_configuration configuration;
  struct iterate_kit_itx_connection connection;
  struct capnweb_pending_call pending_calls[PENDING_CALL_CAPACITY];
  struct capnweb_export exports[EXPORT_CAPACITY];
  struct capnweb_import imports[IMPORT_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  struct iterate_kit_spsc_ring control_inbox;
  struct iterate_kit_spsc_ring control_outbox;
  uint8_t outbox_storage[CONTROL_OUTBOX_SLOTS][CONTROL_SLOT_CAPACITY];
  size_t inbox_lengths[CONTROL_INBOX_SLOTS];
  size_t outbox_lengths[CONTROL_OUTBOX_SLOTS];
  struct iterate_kit_esp_idf_itx_transport transport;
  struct iterate_kit_peer peer;
  struct iterate_kit_module modules[1];
  struct iterate_kit_voicelab voicelab;
  uint32_t voicelab_generation;
  uint32_t frame_sequence;
  char stats_buffer[640];
  uint32_t stats_sequence;
  enum iterate_kit_esp_idf_itx_transport_state last_transport_state;
  enum iterate_kit_voicelab_state last_voicelab_state;
  /* Cross-task audio plumbing. */
  QueueHandle_t mic_queue;
  StreamBufferHandle_t speaker_buffer;
  volatile uint32_t speaker_discard_bytes; /* barge-in: playback task skips */
  volatile uint64_t speaker_last_write_ms;
  uint32_t mic_frames_captured;
  uint32_t mic_frames_dropped;
  uint32_t mic_frames_gated;
  uint32_t speaker_frames_played;
  uint32_t speaker_overflow_drops;
  uint32_t barge_in_flushes;
  bool talking;
} runtime;

/* What `itx.kit.waveshare` looks like to whoever holds the capability. */
static const char peer_description[] =
    "{\"instructions\":\"An Iterate voice device: a 368x448 AMOLED showing "
    "the call state and live transcript, two physical buttons (BOOT toggles "
    "the call, PWR is held to speak), a microphone and a speaker. Turn "
    "taking is manual: hold to talk, release to get an answer.\","
    "\"children\":{"
    "\"setBackground\":\"Fill the screen background with a colour — hex "
    "(#1e293b) or a name (navy, teal, iterate).\","
    "\"takeScreenshot\":\"Capture the screen; returns {width,height,"
    "format,bytes,chunkSize,chunks} and readScreenshotChunk(i) returns each "
    "chunk as bytes.\","
    "\"readScreenshotChunk\":\"Read chunk i of the last takeScreenshot.\","
    "\"conversation\":{\"start\":\"Start a voice call — the same intent as "
    "the BOOT button.\","
    "\"hangUp\":\"End the current call.\"},"
    "\"pushToTalk\":{\"start\":\"Begin a spoken turn — the same intent as "
    "holding PWR. Cancels any answer in flight.\","
    "\"stop\":\"End the turn: commits what was said and asks for the "
    "answer.\"}}}";

/*
 * A Cap'n Web session's capability ids die with it. Appending through a
 * voicelab struct that outlived its session poisons the NEXT session with
 * unknown export ids, which the server correctly aborts — so the moment the
 * session ends, the voicelab machine is forced dead; the main loop restarts
 * it fresh for the next connection generation.
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

/* --- speaker path (voicelab callbacks run on the app task) ---------------- */

static void on_speaker_pcm(
    void *context, const uint8_t *pcm, size_t pcm_length, int64_t sequence) {
  (void)context;
  (void)sequence;
  if (xStreamBufferSend(runtime.speaker_buffer, pcm, pcm_length, 0) <
      pcm_length) {
    ++runtime.speaker_overflow_drops;
  }
}

static void on_control(
    void *context, enum iterate_kit_voicelab_control control) {
  (void)context;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    /* With manual turns this only fires if something re-enables VAD, but
     * flushing playback on it is still the right response. */
    /* Barge-in: tell the playback task to skip everything queued so far.
     * The buffer itself is only reset by its reader; a racing writer would
     * corrupt it. */
    runtime.speaker_discard_bytes =
        (uint32_t)xStreamBufferBytesAvailable(runtime.speaker_buffer);
    ++runtime.barge_in_flushes;
    waveshare_display_set_state(WAVESHARE_UI_LISTENING);
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    /* The answer is complete: back to waiting for the next turn. */
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("hold PWR to talk");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    /* The bridge hung up (its idle timeout, Grok closing, or our own
     * hangup echoing back) — the button must agree with reality. */
    waveshare_display_request_call(false);
    waveshare_display_set_call_active(false);
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("call ended");
  }
}

/* Transcript deltas land on screen as they arrive; the assistant's open line
 * is replaced until it is final. */
static void on_transcript(
    void *context, bool from_user, const char *text, bool final) {
  (void)context;
  waveshare_display_push_transcript(from_user ? "you" : "iterate", text, final);
  if (!from_user) {
    waveshare_display_set_state(WAVESHARE_UI_SPEAKING);
  }
}

static void playback_task(void *argument) {
  static int16_t chunk[FRAME_SAMPLES];
  (void)argument;
  for (;;) {
    const size_t received = xStreamBufferReceive(
        runtime.speaker_buffer, chunk, sizeof(chunk), pdMS_TO_TICKS(100));
    if (received == 0U) {
      continue;
    }
    if (runtime.speaker_discard_bytes > 0U) {
      const uint32_t discard = runtime.speaker_discard_bytes;
      runtime.speaker_discard_bytes =
          discard > received ? discard - (uint32_t)received : 0U;
      continue;
    }
    if (waveshare_audio_write(chunk, received / 2U)) {
      ++runtime.speaker_frames_played;
    }
    /*
     * Stamp the echo gate from PLAYBACK, not arrival: paced delivery can
     * finish arriving seconds before the speaker finishes, and a gate timed
     * from arrival reopens the microphone while the board is still talking.
     */
    runtime.speaker_last_write_ms = now_ms(NULL);
  }
}

/* --- microphone path ------------------------------------------------------ */

static void capture_task(void *argument) {
  static struct mic_frame frame;
  (void)argument;
  for (;;) {
    if (!waveshare_audio_read(frame.samples, FRAME_SAMPLES)) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    ++runtime.mic_frames_captured;
    if (runtime.mic_frames_captured % 250U == 1U) {
      /* Bring-up: is the codec giving us audio, or is corruption ours? */
      ESP_LOGI(
          tag,
          "raw mic samples: %d %d %d %d %d %d %d %d",
          frame.samples[0], frame.samples[1], frame.samples[2],
          frame.samples[3], frame.samples[4], frame.samples[5],
          frame.samples[6], frame.samples[7]);
    }
    if (xQueueSend(runtime.mic_queue, &frame, 0) != pdTRUE) {
      /* Freshest wins: discard the OLDEST frame, keep this one. Stale
       * speech after a network hiccup is worse than a gap. */
      struct mic_frame discarded;
      (void)xQueueReceive(runtime.mic_queue, &discarded, 0);
      (void)xQueueSend(runtime.mic_queue, &frame, 0);
      ++runtime.mic_frames_dropped;
    }
  }
}

/* --- boot wiring ----------------------------------------------------------- */

static bool initialise_rings(void) {
  return iterate_kit_spsc_ring_init(
             &runtime.control_inbox,
             inbox_storage_psram,
             CONTROL_SLOT_CAPACITY,
             CONTROL_INBOX_SLOTS,
             runtime.inbox_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &runtime.control_outbox,
             runtime.outbox_storage,
             CONTROL_SLOT_CAPACITY,
             CONTROL_OUTBOX_SLOTS,
             runtime.outbox_lengths) == ITERATE_KIT_OK;
}

static bool initialise_connection(void) {
  static const char *const mount_path[] = {"kit", "waveshare"};
  struct iterate_kit_itx_connection_options options;
  struct iterate_kit_esp_idf_itx_transport_options transport_options;
  struct iterate_kit_peer_options peer_options;

  runtime.modules[0] = waveshare_tools_module();
  peer_options = (struct iterate_kit_peer_options){
    peer_description,
    sizeof(peer_description) - 1U,
    runtime.modules,
    sizeof(runtime.modules) / sizeof(runtime.modules[0]),
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
  options.instructions = "Iterate voice device (Waveshare ESP32-S3 AMOLED)";
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

static void append_stats(uint64_t now) {
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  int length;
  iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &metrics);
  length = snprintf(
      runtime.stats_buffer,
      sizeof(runtime.stats_buffer),
      "[{\"type\":\"voicelab/dev-stats\",\"payload\":{"
      "\"seq\":%" PRIu32 ",\"t\":%" PRIu64
      ",\"framesSent\":%" PRIu32 ",\"frameFailures\":%" PRIu32
      ",\"micCaptured\":%" PRIu32 ",\"micDropped\":%" PRIu32
      ",\"micGated\":%" PRIu32
      ",\"spkFrames\":%" PRIu32 ",\"spkPlayed\":%" PRIu32
      ",\"spkOverflow\":%" PRIu32 ",\"spkSeqGaps\":%" PRIu32
      ",\"spkDecodeFailures\":%" PRIu32 ",\"bargeIns\":%" PRIu32
      ",\"batches\":%" PRIu32 ",\"connGeneration\":%" PRIu32
      ",\"rttMs\":%" PRIu32 ",\"pings\":%" PRIu32
      ",\"heapFree\":%" PRIu32 ",\"heapMin\":%" PRIu32
      ",\"wsSent\":%" PRIu32 ",\"outboxDiscarded\":%" PRIu32
      ",\"inboxPublished\":%" PRIu32 ",\"inboxConsumed\":%" PRIu32
      ",\"inboxDiscarded\":%" PRIu32 ",\"inboxHighWater\":%" PRIu32
      ",\"sessionGeneration\":%" PRIu32 "}}]",
      runtime.stats_sequence++,
      now,
      runtime.voicelab.frames_sent,
      runtime.voicelab.frame_send_failures,
      runtime.mic_frames_captured,
      runtime.mic_frames_dropped,
      runtime.mic_frames_gated,
      runtime.voicelab.spk_frames_received,
      runtime.speaker_frames_played,
      runtime.speaker_overflow_drops,
      runtime.voicelab.spk_seq_gaps,
      runtime.voicelab.spk_decode_failures,
      runtime.barge_in_flushes,
      runtime.voicelab.batches_on_connection,
      runtime.voicelab.connection_generation,
      runtime.voicelab.last_rtt_ms,
      runtime.voicelab.ping_count,
      (uint32_t)esp_get_free_heap_size(),
      (uint32_t)esp_get_minimum_free_heap_size(),
      metrics.control_messages_sent,
      metrics.control_outbox_discarded,
      metrics.control_inbox.messages_published,
      metrics.control_inbox.messages_consumed,
      metrics.control_inbox_discarded,
      metrics.control_inbox.high_water_slots,
      runtime.connection.generation);
  if (length > 0 && (size_t)length < sizeof(runtime.stats_buffer)) {
    (void)iterate_kit_voicelab_append_raw(
        &runtime.voicelab, runtime.stats_buffer, (size_t)length);
  }
}

void app_main(void) {
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
   * Display first: its bring-up pulses the board's shared reset lines (the
   * panel, the touch controller and their neighbours hang off one TCA9554),
   * and doing that after the codec is configured would reset the codec.
   */
  if (!waveshare_display_init()) {
    ESP_LOGE(tag, "display bring-up failed");
    return;
  }
  if (!waveshare_audio_init()) {
    ESP_LOGE(tag, "audio bring-up failed");
    return;
  }
  (void)waveshare_buttons_init();
  waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
  waveshare_display_set_status("connecting to iterate");
  ESP_LOGI(
      tag,
      "heap after display: internal=%u dma=%u total=%u",
      (unsigned int)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
      (unsigned int)heap_caps_get_free_size(MALLOC_CAP_DMA),
      (unsigned int)esp_get_free_heap_size());
  runtime.mic_queue =
      xQueueCreate(MIC_QUEUE_DEPTH, sizeof(struct mic_frame));
  runtime.speaker_buffer = xStreamBufferCreateWithCaps(
      SPEAKER_BUFFER_BYTES, FRAME_BYTES, MALLOC_CAP_SPIRAM);
  if (runtime.mic_queue == NULL || runtime.speaker_buffer == NULL) {
    ESP_LOGE(tag, "audio buffer allocation failed");
    return;
  }
  if (!initialise_rings() || !initialise_connection()) {
    ESP_LOGE(tag, "bounded runtime initialization failed");
    return;
  }
  if (iterate_kit_esp_idf_itx_transport_start(&runtime.transport) !=
      ITERATE_KIT_OK) {
    ESP_LOGE(
        tag,
        "transport start failed: platform=%ld",
        (long)runtime.transport.last_platform_error);
    return;
  }
  (void)xTaskCreatePinnedToCore(
      capture_task, "vl-capture", 4096, NULL, 10, NULL, 1);
  (void)xTaskCreatePinnedToCore(
      playback_task, "vl-playback", 4096, NULL, 12, NULL, 1);
  ESP_LOGI(
      tag,
      "voicelab voice client ready: static_bytes=%u stream=/voicelab/dev-waveshare",
      (unsigned int)sizeof(runtime));

  uint64_t next_stats_at = 0;
  uint64_t next_ping_at = 0;

  for (;;) {
    (void)iterate_kit_esp_idf_itx_transport_poll(&runtime.transport, 4U);
    waveshare_buttons_poll();
    if (waveshare_buttons_take_call_press()) {
      waveshare_display_request_call(!waveshare_display_call_requested());
    }

    if (runtime.transport.state != runtime.last_transport_state) {
      ESP_LOGI(
          tag,
          "transport state=%s",
          iterate_kit_esp_idf_itx_transport_state_name(
              runtime.transport.state));
      if (runtime.last_transport_state == ITERATE_KIT_ESP_IDF_ITX_READY) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &metrics);
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
      if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_FAILED) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &metrics);
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

    if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY &&
        runtime.voicelab_generation != runtime.connection.generation) {
      const struct iterate_kit_voicelab_options options = {
        &runtime.connection.session,
        runtime.configuration.project_id,
        runtime.configuration.project_api_key,
        STREAM_PATH,
        CALL_ID,
        now_ms,
        NULL,
        on_speaker_pcm,
        on_control,
        on_transcript,
        NULL,
      };
      if (iterate_kit_voicelab_start(&runtime.voicelab, &options) ==
          CAPNWEB_OK) {
        runtime.voicelab_generation = runtime.connection.generation;
        runtime.frame_sequence = 0U;
        (void)xQueueReset(runtime.mic_queue); /* drop pre-session stale audio */
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
        waveshare_display_set_state(WAVESHARE_UI_IDLE);
        waveshare_display_set_status(STREAM_PATH);
      } else if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED) {
        /* A dead session takes the call with it; the button starts over. */
        waveshare_display_request_call(false);
        waveshare_display_set_call_active(false);
        waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
        waveshare_display_set_status(
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      }
    }

    if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
        runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
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
      static struct mic_frame frame_storage[4];
      static uint64_t drain_window_at;
      static uint64_t next_call_attempt_at;
      static bool call_active_shown;

      /*
       * One intent path for both sources: a physical button edge and an RPC
       * call land on the same two flags, so remote and local control cannot
       * disagree about what the device is doing (the M5StickS3 does the same
       * through its device-event queue).
       */
      const bool wants_call = waveshare_display_call_requested();
      const bool wants_talk = wants_call &&
          (waveshare_buttons_talk_held() || waveshare_display_talk_held());

      if (wants_call && !runtime.voicelab.call_active &&
          !runtime.voicelab.call_pending && outbox_free >= 5U &&
          now >= next_call_attempt_at) {
        next_call_attempt_at = now + 8000U; /* a start takes ~1-3s; don't spam */
        if (iterate_kit_voicelab_start_call(&runtime.voicelab, GREETING) ==
            CAPNWEB_OK) {
          waveshare_display_set_status("starting call");
        }
      }
      if (!wants_call && runtime.voicelab.call_active && outbox_free >= 5U) {
        (void)iterate_kit_voicelab_end_call(&runtime.voicelab, "button");
        waveshare_display_set_status("call ended");
        waveshare_display_set_state(WAVESHARE_UI_IDLE);
      }
      if (runtime.voicelab.call_active != call_active_shown) {
        call_active_shown = runtime.voicelab.call_active;
        waveshare_display_set_call_active(call_active_shown);
        if (call_active_shown) {
          waveshare_display_set_state(WAVESHARE_UI_IDLE);
          waveshare_display_set_status("hold PWR to talk");
        }
      }

      /*
       * Turn edges. Pressing talk cancels whatever is playing — locally by
       * dropping the queued speaker audio, and at the bridge by asking it to
       * cancel the response — so the microphone never opens into a live
       * speaker. Releasing commits the turn and asks for the answer.
       */
      if (wants_talk != runtime.talking && runtime.voicelab.call_active &&
          outbox_free >= 5U) {
        runtime.talking = wants_talk;
        if (wants_talk) {
          runtime.speaker_discard_bytes =
              (uint32_t)xStreamBufferBytesAvailable(runtime.speaker_buffer);
          (void)xQueueReset(runtime.mic_queue); /* drop pre-press room noise */
          runtime.frame_sequence = 0U;
          (void)iterate_kit_voicelab_mark_turn(
              &runtime.voicelab, ITERATE_KIT_VOICELAB_TURN_START);
          waveshare_display_set_state(WAVESHARE_UI_LISTENING);
          waveshare_display_set_status("listening");
        } else {
          (void)iterate_kit_voicelab_mark_turn(
              &runtime.voicelab, ITERATE_KIT_VOICELAB_TURN_COMMIT);
          waveshare_display_set_state(WAVESHARE_UI_SPEAKING);
          waveshare_display_set_status("thinking");
        }
      }

      /* The microphone is only on the wire while the talk button is down. */
      if (runtime.talking && now >= drain_window_at &&
          uxQueueMessagesWaiting(runtime.mic_queue) >= 4U) {
        drain_window_at =
            (drain_window_at == 0U || now - drain_window_at > 400U)
            ? now + 4U * FRAME_MS
            : drain_window_at + 4U * FRAME_MS;
        if (outbox_free >= 5U) {
          size_t index;
          const uint8_t *frame_pointers[4];
          for (index = 0U; index < 4U; ++index) {
            (void)xQueueReceive(runtime.mic_queue, &frame_storage[index], 0);
            frame_pointers[index] =
                (const uint8_t *)frame_storage[index].samples;
          }
          (void)iterate_kit_voicelab_append_frames(
              &runtime.voicelab,
              frame_pointers,
              4U,
              sizeof(frame_storage[0].samples),
              runtime.frame_sequence,
              now);
          runtime.frame_sequence += 4U;
        }
      }
      if (outbox_free >= 7U &&
          iterate_kit_voicelab_needs_recycle(&runtime.voicelab)) {
        (void)iterate_kit_voicelab_recycle_connection(&runtime.voicelab);
      }
      if (next_ping_at == 0U) {
        next_ping_at = now + 1000U;
        next_stats_at = now + STATS_INTERVAL_MS;
      }
      if (now >= next_ping_at && outbox_free >= 5U) {
        (void)iterate_kit_voicelab_ping(&runtime.voicelab);
        next_ping_at = now + PING_INTERVAL_MS;
      }
      if (now >= next_stats_at && outbox_free >= 5U) {
        append_stats(now);
        next_stats_at = now + STATS_INTERVAL_MS;
      }
    }

    vTaskDelay(pdMS_TO_TICKS(5) == 0 ? 1 : pdMS_TO_TICKS(5));
  }
}
