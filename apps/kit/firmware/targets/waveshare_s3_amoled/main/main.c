/*
 * Waveshare ESP32-S3 Touch AMOLED — voicelab single-WebSocket probe.
 *
 * Measures whether realtime PCM can ride ONE Cap'n Web /api socket as
 * ephemeral stream events, exactly like the TypeScript voicelab client:
 * authenticate -> projects.get -> streams.get, then 50 Hz one-way appends of
 * voicelab/mic-frame events (base64 PCM16, 20 ms per event). No display, no
 * codec yet: the "microphone" is a synthesized 440 Hz tone so the transport
 * question is answered before any audio-hardware bring-up.
 *
 * Observability is the stream itself: a durable voicelab/dev-stats event
 * every 5 s carries frame counters, heap, RTT, and transport metrics —
 * opening the USB serial port would reset the board (see
 * firmware/docs/connected-device-inventory.md), so nothing depends on it.
 *
 * DELIBERATE DEPARTURE from the dual-WebSocket decision in
 * docs/fable-v2-plan/DECISIONS.md — this target is the measurement that
 * decision asked for ("worth finding out"), not a new product transport.
 */
#include <inttypes.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "capnweb/capnweb.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voicelab_stream.h"

static const char tag[] = "iterate-voicelab";

enum {
  PENDING_CALL_CAPACITY = 8,
  EXPORT_CAPACITY = 4,
  /*
   * One-way appends free their import before returning; pulled pings hold
   * one. 16 leaves generous room for mount stages plus concurrent probes.
   */
  IMPORT_CAPACITY = 16,
  /*
   * The stick's 64-token budget is a session-killing abort for any reply
   * larger than a trivial object (thermo review §token budget). The ping
   * append echoes a small committed event; 256 tokens ≈ 6 KiB of static
   * parser state and clears it with margin.
   */
  TOKEN_CAPACITY = 256,
  OUTPUT_CAPACITY = 128,
  CONTROL_SLOT_CAPACITY = ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY,
  CONTROL_INBOX_SLOTS = 8,
  /*
   * 50 frames/s -> 100 outbound messages/s (push + release each). The
   * network task drains 4 per 20 ms poll (200/s); 16 slots absorb a ~150 ms
   * scheduling hiccup before appends start failing and being counted.
   */
  CONTROL_OUTBOX_SLOTS = 16,
  FRAME_MS = 20,
  FRAME_SAMPLES = 320,
  STATS_INTERVAL_MS = 5000,
  PING_INTERVAL_MS = 5000,
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
  uint8_t inbox_storage[CONTROL_INBOX_SLOTS][CONTROL_SLOT_CAPACITY];
  uint8_t outbox_storage[CONTROL_OUTBOX_SLOTS][CONTROL_SLOT_CAPACITY];
  size_t inbox_lengths[CONTROL_INBOX_SLOTS];
  size_t outbox_lengths[CONTROL_OUTBOX_SLOTS];
  struct iterate_kit_esp_idf_itx_transport transport;
  struct iterate_kit_voicelab voicelab;
  uint32_t voicelab_generation;
  uint32_t frame_sequence;
  uint32_t tone_phase;
  int16_t frame_samples[FRAME_SAMPLES];
  char stats_buffer[512];
  uint32_t stats_sequence;
  enum iterate_kit_esp_idf_itx_transport_state last_transport_state;
  enum iterate_kit_voicelab_state last_voicelab_state;
} runtime;

/* The mount wants a device capability; this probe has no verbs to offer. */
static enum capnweb_status inert_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  return capnweb_reply_set_null(reply);
}

static uint64_t now_ms(void *context) {
  (void)context;
  return (uint64_t)(esp_timer_get_time() / 1000);
}

static bool initialise_rings(void) {
  return iterate_kit_spsc_ring_init(
             &runtime.control_inbox,
             runtime.inbox_storage,
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
  /* Path segments must be identifier-shaped: the capability host rejects
   * hyphens ("invalid capability path segment"). */
  static const char *const mount_path[] = {"kit", "waveshare"};
  struct iterate_kit_itx_connection_options options;
  struct iterate_kit_esp_idf_itx_transport_options transport_options;

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
  options.capability = (struct capnweb_capability){
    inert_dispatch,
    NULL,
    NULL,
  };
  options.instructions = "Waveshare voicelab probe (uplink-only, no verbs)";
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

/* 440 Hz tone at 16 kHz — recognizably "audio-shaped" incompressible load. */
static void synthesize_frame(void) {
  size_t index;
  for (index = 0; index < FRAME_SAMPLES; ++index) {
    const float phase =
        (float)(runtime.tone_phase + index) * (2.0f * (float)M_PI * 440.0f) /
        16000.0f;
    runtime.frame_samples[index] = (int16_t)(sinf(phase) * 8000.0f);
  }
  runtime.tone_phase += FRAME_SAMPLES;
}

static void append_stats(uint64_t now) {
  struct iterate_kit_esp_idf_itx_transport_metrics metrics_storage;
  const struct iterate_kit_esp_idf_itx_transport_metrics *metrics =
      &metrics_storage;
  int length;
  iterate_kit_esp_idf_itx_transport_metrics(
      &runtime.transport, &metrics_storage);
  length = snprintf(
      runtime.stats_buffer,
      sizeof(runtime.stats_buffer),
      "[{\"type\":\"voicelab/dev-stats\",\"payload\":{"
      "\"seq\":%" PRIu32 ",\"t\":%" PRIu64
      ",\"framesSent\":%" PRIu32 ",\"frameFailures\":%" PRIu32
      ",\"rttMs\":%" PRIu32 ",\"pings\":%" PRIu32
      ",\"pingFailures\":%" PRIu32
      ",\"heapFree\":%" PRIu32 ",\"heapMin\":%" PRIu32
      ",\"wsSent\":%" PRIu32 ",\"wsDiscarded\":%" PRIu32
      ",\"outboxDiscarded\":%" PRIu32 ",\"generation\":%" PRIu32 "}}]",
      runtime.stats_sequence++,
      now,
      runtime.voicelab.frames_sent,
      runtime.voicelab.frame_send_failures,
      runtime.voicelab.last_rtt_ms,
      runtime.voicelab.ping_count,
      runtime.voicelab.ping_failures,
      (uint32_t)esp_get_free_heap_size(),
      (uint32_t)esp_get_minimum_free_heap_size(),
      metrics == NULL ? 0U : metrics->control_messages_sent,
      metrics == NULL ? 0U : metrics->control_messages_discarded,
      metrics == NULL ? 0U : metrics->control_outbox_discarded,
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
  ESP_LOGI(
      tag,
      "voicelab probe ready: static_bytes=%u stream=/voicelab/dev-waveshare",
      (unsigned int)sizeof(runtime));

  uint64_t next_frame_at = 0;
  uint64_t next_stats_at = 0;
  uint64_t next_ping_at = 0;

  for (;;) {
    (void)iterate_kit_esp_idf_itx_transport_poll(&runtime.transport, 4U);

    if (runtime.transport.state != runtime.last_transport_state) {
      ESP_LOGI(
          tag,
          "transport state=%s",
          iterate_kit_esp_idf_itx_transport_state_name(
              runtime.transport.state));
      if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_FAILED) {
        ESP_LOGE(
            tag,
            "mount diagnosis: connection=%d capnweb=%d mount=%s failure=%s "
            "mount_capnweb=%d transport_capnweb=%d platform=%ld",
            (int)runtime.connection.state,
            (int)runtime.connection.capnweb_status,
            iterate_kit_itx_mount_state_name(runtime.connection.mount.state),
            iterate_kit_itx_mount_failure_name(
                runtime.connection.mount.failure),
            (int)runtime.connection.mount.capnweb_status,
            (int)runtime.transport.last_capnweb_status,
            (long)runtime.transport.last_platform_error);
      }
      runtime.last_transport_state = runtime.transport.state;
    }

    const uint64_t now = now_ms(NULL);

    /* (Re)start the voicelab stream mount once per connection generation. */
    if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY &&
        runtime.voicelab_generation != runtime.connection.generation) {
      const struct iterate_kit_voicelab_options options = {
        &runtime.connection.session,
        runtime.configuration.project_id,
        runtime.configuration.project_api_key,
        "/voicelab/dev-waveshare",
        "wsdev",
        now_ms,
        NULL,
      };
      if (iterate_kit_voicelab_start(&runtime.voicelab, &options) ==
          CAPNWEB_OK) {
        runtime.voicelab_generation = runtime.connection.generation;
        runtime.frame_sequence = 0U;
        next_frame_at = 0U;
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
    }

    if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY) {
      if (next_frame_at == 0U) {
        next_frame_at = now;
        next_stats_at = now + STATS_INTERVAL_MS;
        next_ping_at = now + 1000U;
      }
      /* Catch-up pacing, bounded to one extra frame per pass so a stall
       * becomes counted drops rather than an outbox flood. */
      int budget = 2;
      while (now >= next_frame_at && budget-- > 0) {
        synthesize_frame();
        (void)iterate_kit_voicelab_append_frame(
            &runtime.voicelab,
            (const uint8_t *)runtime.frame_samples,
            sizeof(runtime.frame_samples),
            runtime.frame_sequence++,
            now);
        next_frame_at += FRAME_MS;
      }
      if (now >= next_frame_at + 10U * FRAME_MS) {
        /* Way behind (Wi-Fi hiccup): resynchronize instead of bursting. */
        next_frame_at = now;
      }
      if (now >= next_ping_at) {
        (void)iterate_kit_voicelab_ping(&runtime.voicelab);
        next_ping_at = now + PING_INTERVAL_MS;
      }
      if (now >= next_stats_at) {
        append_stats(now);
        next_stats_at = now + STATS_INTERVAL_MS;
      }
    }

    vTaskDelay(pdMS_TO_TICKS(5) == 0 ? 1 : pdMS_TO_TICKS(5));
  }
}
