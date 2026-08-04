#include "iterate/kit/devices/stackchan.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

enum {
  TOKEN_CAPACITY = 128,
  CALL_CAPACITY = 8,
  OUTPUT_CAPACITY = 64,
  CAPTURED_MESSAGE_CAPACITY = 32,
  MESSAGE_CAPACITY = 1024,
  OBSERVED_EVENT_CAPACITY = 8,
};

struct fixture {
  struct capnweb_session session;
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  char captured[CAPTURED_MESSAGE_CAPACITY][MESSAGE_CAPACITY];
  size_t captured_lengths[CAPTURED_MESSAGE_CAPACITY];
  size_t captured_count;
  bool message_open;
  char screen_url[64];
  char avatar_slug[32];
  struct iterate_kit_metrics_subscription metrics_subscriptions[2];
  char diagnostics_expression
      [ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY];
  struct iterate_kit_device_event handled[OBSERVED_EVENT_CAPACITY];
  struct iterate_kit_device_event observed[OBSERVED_EVENT_CAPACITY];
  enum iterate_kit_status observed_results[OBSERVED_EVENT_CAPACITY];
  size_t handled_count;
  size_t observed_count;
  size_t sprite_set_count;
  size_t screen_capture_release_count;
  char last_sprite_set[32];
  size_t metrics_sample_count;
  uint32_t playback_interruption_requests;
  uint32_t playback_interruption_polls;
  uint32_t playback_interruption_token;
  enum iterate_kit_status playback_interruption_result;
  bool playback_interruption_complete;
  struct iterate_kit_aec_diagnostic_trace_capability aec_trace_capability;
  struct iterate_kit_stackchan device;
};

static enum capnweb_status capture_text(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct fixture *fixture = context;
  size_t *captured_length;
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (fixture->message_open ||
        fixture->captured_count >= CAPTURED_MESSAGE_CAPACITY) {
      return CAPNWEB_E_STATE;
    }
    fixture->message_open = true;
    fixture->captured_lengths[fixture->captured_count] = 0U;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!fixture->message_open || data == NULL || length == 0U) {
      return CAPNWEB_E_STATE;
    }
    captured_length =
        &fixture->captured_lengths[fixture->captured_count];
    if (length >= MESSAGE_CAPACITY ||
        *captured_length >= MESSAGE_CAPACITY - length) {
      return CAPNWEB_E_LIMIT;
    }
    memcpy(
        fixture->captured[fixture->captured_count] + *captured_length,
        data,
        length);
    *captured_length += length;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_END) {
    if (!fixture->message_open) {
      return CAPNWEB_E_STATE;
    }
    captured_length =
        &fixture->captured_lengths[fixture->captured_count];
    fixture->captured[fixture->captured_count][*captured_length] = '\0';
    ++fixture->captured_count;
    fixture->message_open = false;
    return CAPNWEB_OK;
  }
  return CAPNWEB_E_INVALID_ARGUMENT;
}

static enum iterate_kit_status render_png(
    void *context, const char *url, size_t length) {
  (void)context;
  (void)url;
  (void)length;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status change_sprite_set(
    void *context, const char *slug, size_t slug_length) {
  struct fixture *fixture = context;
  if (slug == NULL ||
      slug_length != strlen("karakuri-brass") ||
      memcmp(slug, "karakuri-brass", slug_length) != 0 ||
      slug_length >= sizeof(fixture->last_sprite_set)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  ++fixture->sprite_set_count;
  memcpy(fixture->last_sprite_set, slug, slug_length);
  fixture->last_sprite_set[slug_length] = '\0';
  return ITERATE_KIT_OK;
}

static void release_screen_capture(void *context) {
  struct fixture *fixture = context;
  ++fixture->screen_capture_release_count;
}

static enum iterate_kit_status capture_screen(
    void *context, struct iterate_kit_captured_screen *capture) {
  static const uint8_t png_signature[] = {
      0x89U, 0x50U, 0x4eU, 0x47U, 0x0dU, 0x0aU, 0x1aU, 0x0aU,
  };
  if (capture == NULL) return ITERATE_KIT_INVALID_ARGUMENT;
  *capture = (struct iterate_kit_captured_screen){
      .data = png_signature,
      .size = sizeof(png_signature),
      .release = release_screen_capture,
      .release_context = context,
  };
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status move_servos(
    void *context,
    int32_t yaw_degrees,
    int32_t pitch_degrees,
    uint16_t speed) {
  (void)context;
  (void)yaw_degrees;
  (void)pitch_degrees;
  (void)speed;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status set_led(
    void *context,
    uint8_t index,
    uint8_t red,
    uint8_t green,
    uint8_t blue) {
  (void)context;
  (void)index;
  (void)red;
  (void)green;
  (void)blue;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status fill_leds(
    void *context, uint8_t red, uint8_t green, uint8_t blue) {
  (void)context;
  (void)red;
  (void)green;
  (void)blue;
  return ITERATE_KIT_OK;
}

static void release_photo(void *context) {
  (void)context;
}

static enum iterate_kit_status take_photo(
    void *context, struct iterate_kit_photo *photo) {
  static const uint8_t byte = 0U;
  if (photo == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *photo = (struct iterate_kit_photo){
    &byte,
    1U,
    release_photo,
    context,
  };
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status sample_metrics(
    void *context, struct iterate_kit_metrics_sample *sample) {
  struct fixture *fixture = context;
  ++fixture->metrics_sample_count;
  memset(sample, 0, sizeof(*sample));
  sample->uptime_ms = 123;
  sample->free_heap_bytes = 456U;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status request_playback_interruption(
    void *context, uint32_t *token) {
  struct fixture *fixture = context;
  if (token == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  ++fixture->playback_interruption_requests;
  fixture->playback_interruption_token =
      fixture->playback_interruption_requests;
  *token = fixture->playback_interruption_token;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status poll_playback_interruption(
    void *context, uint32_t token) {
  struct fixture *fixture = context;
  ++fixture->playback_interruption_polls;
  assert(token == fixture->playback_interruption_token);
  return fixture->playback_interruption_complete
      ? fixture->playback_interruption_result
      : ITERATE_KIT_UNAVAILABLE;
}

static enum iterate_kit_status handle_control_event(
    void *context,
    const struct iterate_kit_device_event *event) {
  struct fixture *fixture = context;
  assert(fixture->handled_count < OBSERVED_EVENT_CAPACITY);
  fixture->handled[fixture->handled_count++] = *event;
  return ITERATE_KIT_OK;
}

static void observe_control_event(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  struct fixture *fixture = context;
  assert(fixture->observed_count < OBSERVED_EVENT_CAPACITY);
  fixture->observed[fixture->observed_count] = *event;
  fixture->observed_results[fixture->observed_count] = result;
  ++fixture->observed_count;
}

static void fixture_init(struct fixture *fixture) {
  struct iterate_kit_stackchan_options device_options;
  struct iterate_kit_stackchan_control_driver control_driver;
  struct capnweb_session_options session_options;
  memset(fixture, 0, sizeof(*fixture));
  fixture->aec_trace_capability.initialized = 1U;
  fixture->playback_interruption_result = ITERATE_KIT_OK;
  device_options = (struct iterate_kit_stackchan_options){
    .screen = {fixture, render_png, NULL},
    .screen_url_scratch = fixture->screen_url,
    .screen_url_scratch_size = sizeof(fixture->screen_url),
    .avatar = {fixture, change_sprite_set},
    .avatar_slug_scratch = fixture->avatar_slug,
    .avatar_slug_scratch_size = sizeof(fixture->avatar_slug),
    .screen_capture = {fixture, capture_screen},
    .maximum_screen_capture_bytes = 8U,
    .servos = {fixture, move_servos},
    .leds = {fixture, set_led, fill_leds},
    .camera = {fixture, take_photo},
    .maximum_photo_bytes = 1U,
    .playback_interruption = {
      .context = fixture,
      .request = request_playback_interruption,
      .poll = poll_playback_interruption,
      .acknowledgement_timeout_ms = 50U,
    },
    .metrics = {
      &fixture->session,
      {fixture, sample_metrics},
      fixture->metrics_subscriptions,
      sizeof(fixture->metrics_subscriptions) /
          sizeof(fixture->metrics_subscriptions[0]),
      1000U,
      false,
      true,
      false,
      false,
      fixture->diagnostics_expression,
      sizeof(fixture->diagnostics_expression),
      NULL,
    },
    .aec_trace = &fixture->aec_trace_capability,
  };
  assert(
      iterate_kit_stackchan_init(
          &fixture->device, &device_options) == CAPNWEB_OK);
  control_driver = (struct iterate_kit_stackchan_control_driver){
    .handler = {
      fixture,
      handle_control_event,
    },
    .observer = {
      fixture,
      observe_control_event,
    },
  };
  assert(
      iterate_kit_stackchan_bind_control_driver(
          &fixture->device, &control_driver) == ITERATE_KIT_OK);
  session_options = (struct capnweb_session_options){
    iterate_kit_stackchan_capability(&fixture->device),
    capture_text,
    fixture,
    fixture->pending_calls,
    CALL_CAPACITY,
    fixture->exports,
    CALL_CAPACITY,
    fixture->imports,
    CALL_CAPACITY,
    fixture->tokens,
    TOKEN_CAPACITY,
    fixture->output_buffer,
    OUTPUT_CAPACITY,
  };
  assert(
      capnweb_session_init(
          &fixture->session, &session_options) == CAPNWEB_OK);
}

static void receive(struct fixture *fixture, const char *message);
static void fixture_close(struct fixture *fixture);
static bool captured_contains(
    const struct fixture *fixture, const char *substring);

/*
 * Grok's speech-start event races fresh response audio. Userspace therefore
 * holds that new downlink behind this exact Cap'n Web result. Returning true
 * when the control task merely requested a reset would release stale speaker
 * state; the capability must stay deferred until the audio-owner token is
 * complete, while normal device polling continues without blocking.
 */
static void playback_interruption_acknowledges_the_audio_owner(void) {
  struct fixture fixture;
  size_t before_completion;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"conversation\","
      "\"interruptPlayback\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(fixture.playback_interruption_requests == 1U);
  before_completion = fixture.captured_count;

  assert(
      iterate_kit_stackchan_poll(&fixture.device, 100U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.playback_interruption_polls == 1U);
  assert(fixture.captured_count == before_completion);

  fixture.playback_interruption_complete = true;
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 101U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.playback_interruption_polls == 2U);
  assert(fixture.captured_count == before_completion + 1U);
  assert(captured_contains(&fixture, "[\"resolve\",1,true]"));
  fixture_close(&fixture);
}

/*
 * Hardware silence must never be an unbounded promise. If the audio owner
 * misses its explicit deadline, userspace needs a classified rejection so it
 * can fail the PCM generation. The underlying purge remains owned and polled
 * after that rejection: abandoning it would wedge the one-slot barrier or let
 * a later request leapfrog samples whose fate is still unknown.
 */
static void playback_interruption_timeout_is_visible_and_drainable(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"conversation\","
      "\"interruptPlayback\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 200U).status ==
      ITERATE_KIT_POLL_OK);
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 249U).status ==
      ITERATE_KIT_POLL_OK);
  assert(!captured_contains(&fixture, "timed out"));
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 250U).status ==
      ITERATE_KIT_POLL_OK);
  assert(captured_contains(&fixture, "timed out"));

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"conversation\","
      "\"interruptPlayback\"],[]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(fixture.playback_interruption_requests == 1U);
  assert(captured_contains(&fixture, "interruption already pending"));

  fixture.playback_interruption_complete = true;
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 251U).status ==
      ITERATE_KIT_POLL_OK);
  fixture_close(&fixture);
}

static void receive(struct fixture *fixture, const char *message) {
  assert(
      capnweb_session_receive(
          &fixture->session, message, strlen(message)) ==
      CAPNWEB_OK);
}

static void fixture_close(struct fixture *fixture) {
  capnweb_session_close(&fixture->session);
  iterate_kit_peer_session_ended(&fixture->device.peer);
  assert(
      iterate_kit_stackchan_close(&fixture->device).status ==
      ITERATE_KIT_POLL_OK);
}

static bool captured_contains(
    const struct fixture *fixture, const char *substring) {
  for (size_t index = 0U; index < fixture->captured_count; ++index) {
    if (strstr(fixture->captured[index], substring) != NULL) {
      return true;
    }
  }
  return false;
}

/*
 * The physical button and userspace capability are two producers of one PCM
 * lifecycle, not independent ways to mutate hardware. If either path acts
 * inline, network dispatch or GPIO timing can reorder start/stop and the voice
 * Worker can receive a turn boundary that disagrees with the device. This
 * production-shaped scenario proves both sources merely publish, the bounded
 * owner poll establishes one order, and the outer audio adapter plus event
 * observer see the same processed transition and provenance exactly once.
 */
static void remote_and_physical_conversation_controls_share_one_owner_queue(
    void) {
  struct fixture fixture;
  struct iterate_kit_device_event_queue_metrics metrics;
  fixture_init(&fixture);

  assert(
      iterate_kit_stackchan_publish_conversation(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(!iterate_kit_stackchan_is_conversation_active(&fixture.device));
  assert(fixture.handled_count == 0U);
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_stackchan_is_conversation_active(&fixture.device));
  assert(fixture.handled_count == 1U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"conversation\",\"hangUp\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(iterate_kit_stackchan_is_conversation_active(&fixture.device));
  assert(fixture.handled_count == 1U);
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 1U).status ==
      ITERATE_KIT_POLL_OK);
  assert(!iterate_kit_stackchan_is_conversation_active(&fixture.device));
  assert(fixture.handled_count == 2U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"conversation\",\"start\"],[]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 2U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_stackchan_is_conversation_active(&fixture.device));

  assert(
      iterate_kit_stackchan_publish_conversation(
          &fixture.device,
          false,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 3U).status ==
      ITERATE_KIT_POLL_OK);
  assert(!iterate_kit_stackchan_is_conversation_active(&fixture.device));

  assert(fixture.handled_count == 4U);
  assert(fixture.observed_count == 4U);
  assert(
      fixture.handled[0].type ==
      ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED);
  assert(
      fixture.handled[0].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
  assert(
      fixture.handled[1].type ==
      ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED);
  assert(
      fixture.handled[1].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
  assert(
      fixture.handled[2].type ==
      ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED);
  assert(
      fixture.handled[2].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
  assert(
      fixture.handled[3].type ==
      ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED);
  assert(
      fixture.handled[3].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
  for (size_t index = 0U; index < fixture.observed_count; ++index) {
    assert(fixture.observed_results[index] == ITERATE_KIT_OK);
  }

  iterate_kit_stackchan_event_metrics(&fixture.device, &metrics);
  assert(metrics.events_published == 4U);
  assert(metrics.events_processed == 4U);
  assert(metrics.publisher_backpressure == 0U);
  assert(metrics.handler_failures == 0U);
  assert(metrics.current_events == 0U);
  fixture_close(&fixture);
}

/*
 * StackChan and Stick share stable sprite slugs even though their display-owner
 * scheduling differs. Exercise the real root dispatcher so profile growth
 * cannot silently omit the avatar module, and reject an unknown slug before a
 * caller can mistake model output for an applied character change.
 */
static void change_sprite_set_reaches_the_shared_avatar_driver(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"changeSpriteSet\"],[\"karakuri-brass\"]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(fixture.sprite_set_count == 1U);
  assert(strcmp(fixture.last_sprite_set, "karakuri-brass") == 0);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"changeSpriteSet\"],[\"unknown\"]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(fixture.sprite_set_count == 1U);
  assert(captured_contains(&fixture, "hardware rejected"));
  fixture_close(&fixture);
}

/*
 * `/pcm` carries only binary samples, so a userspace generation that attaches
 * after a physical press needs a Cap'n Web state snapshot before those frames
 * have turn meaning. At the same time, metrics must remain latest-state and
 * bounded rather than becoming a telemetry history. Subscribe to both real C
 * modules after establishing a held physical turn and prove one owner poll
 * emits the current event state plus one fresh metric through separate remote
 * callbacks. Holding both replies also exercises the profile-wide two-call
 * budget without inventing unbounded callback concurrency.
 */
static void event_and_metrics_subscriptions_share_bounded_profile_state(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  assert(
      iterate_kit_stackchan_publish_conversation(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_stackchan_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_stackchan_is_conversation_active(&fixture.device));

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-2]]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(fixture.metrics_sample_count == 0U);

  assert(
      iterate_kit_stackchan_poll(&fixture.device, 1U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.metrics_sample_count == 1U);
  assert(captured_contains(&fixture, "[\"pipeline\",-1,[]"));
  assert(captured_contains(&fixture, "\"snapshot\":true"));
  assert(
      captured_contains(
          &fixture, "\"type\":\"conversation.started\""));
  assert(captured_contains(&fixture, "\"conversationActive\":true"));
  assert(captured_contains(&fixture, "[\"pipeline\",-2,[]"));
  assert(captured_contains(&fixture, "\"uptimeMs\":123"));
  assert(captured_contains(&fixture, "\"freeHeapBytes\":456"));
  fixture_close(&fixture);
}

/*
 * A stray press before conversation establishment must remain visible as a
 * processed failure, but it must not call the target audio adapter or turn the
 * subscription snapshot into "held". Otherwise a button bounce during Wi-Fi
 * recovery can start capture with no peer and userspace may later treat stale
 * bytes as live speech. Release remains idempotent so hang-up/release ordering
 * cannot wedge the profile in a held state.
 */
static void full_duplex_profile_does_not_mount_push_to_talk(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"pushToTalk\",\"start\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(captured_contains(&fixture, "unknown device capability"));
  assert(fixture.handled_count == 0U);
  assert(fixture.observed_count == 0U);
  fixture_close(&fixture);
}

/*
 * A screenshot is useful only if it crosses the same mounted Cap'n Web peer
 * as the other device capabilities. Calling a test driver directly would miss
 * the exact regression this protects: adding a physical encoder but forgetting
 * the profile module. The release assertion also prevents every diagnostic
 * capture from retaining scarce image memory after serialization.
 */
static void capture_screen_is_mounted_and_releases_encoded_bytes(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"captureScreen\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  /* Cap'n Web byte values use unpadded base64url inside ["bytes", ...]. */
  assert(captured_contains(&fixture, "[\"bytes\",\"iVBORw0KGgo\"]"));
  assert(fixture.screen_capture_release_count == 1U);
  fixture_close(&fixture);
}

/*
 * The manifest is operational input, not decorative metadata: userspace and
 * flash tooling use it to decide whether the mounted device owns a manual PCM
 * turn. Leaving the earlier control-only placeholder here would make a fully
 * wired CoreS3 target advertise AUDIO_NONE and invite a second, target-local
 * interpretation of the same conversation/PTT capability. Pin the shared
 * contract before the physical target composition changes.
 */
static void manifest_advertises_the_shared_full_duplex_aec_contract(void) {
  assert(iterate_kit_stackchan_manifest.slug != NULL);
  assert(strcmp(iterate_kit_stackchan_manifest.slug, "stackchan") == 0);
  assert(
      iterate_kit_stackchan_manifest.audio_mode ==
      ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC);
}

int main(void) {
  playback_interruption_acknowledges_the_audio_owner();
  playback_interruption_timeout_is_visible_and_drainable();
  remote_and_physical_conversation_controls_share_one_owner_queue();
  change_sprite_set_reaches_the_shared_avatar_driver();
  event_and_metrics_subscriptions_share_bounded_profile_state();
  full_duplex_profile_does_not_mount_push_to_talk();
  capture_screen_is_mounted_and_releases_encoded_bytes();
  manifest_advertises_the_shared_full_duplex_aec_contract();
  return 0;
}
