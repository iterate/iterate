#include "iterate/kit/devices/m5sticks3.h"

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
  EVENT_CAPACITY = 4,
  EVENT_SUBSCRIPTION_CAPACITY = 2,
  OBSERVED_CAPACITY = 8,
  CAPTURE_CAPACITY = 32,
  MESSAGE_CAPACITY = 1024,
};

struct fixture {
  struct capnweb_session session;
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  char captured[CAPTURE_CAPACITY][MESSAGE_CAPACITY];
  size_t captured_lengths[CAPTURE_CAPACITY];
  size_t captured_count;
  bool message_open;
  char screen_url[64];
  struct iterate_kit_metrics_subscription subscription;
  struct iterate_kit_device_event event_storage[EVENT_CAPACITY];
  struct iterate_kit_device_event_notification
      event_notifications[EVENT_CAPACITY];
  struct iterate_kit_device_event_subscription
      event_subscriptions[EVENT_SUBSCRIPTION_CAPACITY];
  struct iterate_kit_device_event observed[OBSERVED_CAPACITY];
  enum iterate_kit_status observed_results[OBSERVED_CAPACITY];
  size_t observed_count;
  size_t start_capture_count;
  size_t stop_capture_count;
  size_t prepare_playback_count;
  size_t capture_poll_count;
  size_t screen_colour_count;
  int last_screen_colour;
  struct iterate_kit_m5sticks3 device;
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
        fixture->captured_count >= CAPTURE_CAPACITY) {
      return CAPNWEB_E_STATE;
    }
    fixture->message_open = true;
    fixture->captured_lengths[fixture->captured_count] = 0U;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!fixture->message_open ||
        data == NULL ||
        length == 0U) {
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

static enum iterate_kit_status change_colour(
    void *context, enum iterate_kit_screen_colour colour) {
  struct fixture *fixture = context;
  ++fixture->screen_colour_count;
  fixture->last_screen_colour = colour;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status capture_screen(
    void *context, struct iterate_kit_captured_screen *capture) {
  static const uint8_t encoded_pixel = 0x89U;
  (void)context;
  if (capture == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *capture = (struct iterate_kit_captured_screen){
    &encoded_pixel, 1U, NULL, NULL};
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status sample_metrics(
    void *context, struct iterate_kit_metrics_sample *sample) {
  (void)context;
  memset(sample, 0, sizeof(*sample));
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status start_capture(void *context) {
  struct fixture *fixture = context;
  ++fixture->start_capture_count;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status stop_capture(void *context) {
  struct fixture *fixture = context;
  ++fixture->stop_capture_count;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status prepare_playback(void *context) {
  struct fixture *fixture = context;
  ++fixture->prepare_playback_count;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status audio_ok(void *context) {
  (void)context;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status send_audio_event(
    void *context, enum iterate_kit_audio_event event) {
  (void)context;
  (void)event;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status send_pcm(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    iterate_kit_audio_send_complete_fn complete,
    void *complete_context) {
  (void)context;
  (void)samples;
  (void)sample_count;
  (void)sample_rate_hz;
  (void)complete;
  (void)complete_context;
  return ITERATE_KIT_BACKPRESSURE;
}

static enum iterate_kit_status poll_capture(
    void *context,
    iterate_kit_audio_capture_submit_fn submit,
    void *submit_context) {
  struct fixture *fixture = context;
  (void)submit;
  (void)submit_context;
  ++fixture->capture_poll_count;
  return ITERATE_KIT_OK;
}

static void observe_event(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  struct fixture *fixture = context;
  assert(fixture->observed_count < OBSERVED_CAPACITY);
  fixture->observed[fixture->observed_count] = *event;
  fixture->observed_results[fixture->observed_count] = result;
  ++fixture->observed_count;
}

static void fixture_init(struct fixture *fixture) {
  struct iterate_kit_m5sticks3_options device_options;
  struct capnweb_session_options session_options;
  memset(fixture, 0, sizeof(*fixture));
  device_options = (struct iterate_kit_m5sticks3_options){
    .screen = {fixture, render_png, change_colour},
    .screen_url_scratch = fixture->screen_url,
    .screen_url_scratch_size = sizeof(fixture->screen_url),
    .screen_capture = {fixture, capture_screen},
    .maximum_screen_capture_bytes = 1U,
    .metrics = {
      &fixture->session,
      {fixture, sample_metrics},
      &fixture->subscription,
      1U,
      1000U,
      true,
      false,
      false,
      NULL,
      0U,
      NULL,
    },
    .audio = {
      ITERATE_KIT_AUDIO_PUSH_TO_TALK,
      {
        fixture,
        start_capture,
        stop_capture,
        audio_ok,
        audio_ok,
        prepare_playback,
      },
      {
        fixture,
        send_audio_event,
        send_pcm,
      },
      {
        fixture,
        poll_capture,
      },
    },
    .event_storage = fixture->event_storage,
    .event_capacity = EVENT_CAPACITY,
    .event_stream = {
      .session = &fixture->session,
      .storage = fixture->event_notifications,
      .capacity = EVENT_CAPACITY,
      .subscriptions = fixture->event_subscriptions,
      .subscription_count = EVENT_SUBSCRIPTION_CAPACITY,
      .callback_budget = NULL,
      .audio_mode = ITERATE_KIT_AUDIO_PUSH_TO_TALK,
    },
    .event_observer = {
      fixture,
      observe_event,
    },
    .maximum_in_flight_callbacks = 2U,
  };
  assert(
      iterate_kit_m5sticks3_init(
          &fixture->device, &device_options) == CAPNWEB_OK);
  session_options = (struct capnweb_session_options){
    iterate_kit_m5sticks3_capability(&fixture->device),
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

static void receive(struct fixture *fixture, const char *message) {
  assert(
      capnweb_session_receive(
          &fixture->session, message, strlen(message)) ==
      CAPNWEB_OK);
}

/*
 * `changeColour` is intentionally a tiny scalar capability: it proves that a
 * production OS mount can invoke real hardware without involving image fetch,
 * heap allocation, or the high-volume PCM lane. Both accepted literals and a
 * rejected third value pin the public union instead of relying on a permissive
 * string-to-colour conversion in the display driver.
 */
static void changes_only_the_two_public_screen_colours(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"changeColour\"],[\"red\"]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(fixture.screen_colour_count == 1U);
  assert(fixture.last_screen_colour == 0);
  assert(strcmp(fixture.captured[0], "[\"resolve\",1,true]") == 0);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"changeColour\"],[\"green\"]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(fixture.screen_colour_count == 2U);
  assert(fixture.last_screen_colour == 1);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"changeColour\"],[\"blue\"]]]");
  receive(&fixture, "[\"pull\",3]");
  assert(fixture.screen_colour_count == 2U);
  assert(strstr(fixture.captured[2], "expected red or green") != NULL);

  capnweb_session_close(&fixture.session);
  iterate_kit_peer_session_ended(&fixture.device.peer);
  assert(
      iterate_kit_m5sticks3_close(&fixture.device).status ==
      ITERATE_KIT_POLL_OK);
}

/*
 * `subscribeToEvents` is a public device capability, so a diagnostic harness
 * and the production `/pcm` owner can legitimately observe it at the same
 * time. Replacing the first callback merely because the second subscriber
 * arrived is not a harmless ownership handoff: a short-lived CLI inspection
 * then leaves the deployed Worker claiming `eventReady=true` while every
 * subsequent top/front-button edge is delivered to nobody.
 *
 * Keep this at the native protocol seam. A TypeScript fake with two callback
 * arrays cannot expose a C peer that emits `["release",-1,1]` behind the
 * Worker's back. Both imports must survive and receive independent snapshots;
 * later tests exercise bounded exhaustion and callback completion.
 */
static void independent_subscriber_cannot_disconnect_pcm_owner(void) {
  struct fixture fixture;
  size_t captured_before_delivery;
  fixture_init(&fixture);

  assert(
      iterate_kit_m5sticks3_publish_conversation(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(fixture.event_subscriptions[0].occupied);
  assert(fixture.event_subscriptions[0].callback.id == -1);
  assert(fixture.device.event_stream.queue_count == 1U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-2]]]]");
  receive(&fixture, "[\"pull\",2]");

  assert(fixture.captured_count == 2U);
  assert(strcmp(fixture.captured[0], "[\"resolve\",1,null]") == 0);
  assert(strcmp(fixture.captured[1], "[\"resolve\",2,null]") == 0);

  captured_before_delivery = fixture.captured_count;
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 1U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == captured_before_delivery + 2U);
  assert(
      strstr(
          fixture.captured[captured_before_delivery],
          "[\"pipeline\",-1,[]") != NULL);
  assert(
      strstr(
          fixture.captured[captured_before_delivery],
          "\"active\":false") != NULL);
  assert(
      strstr(
          fixture.captured[captured_before_delivery],
          "\"type\":\"pushToTalk.stopped\"") != NULL);
  assert(
      strstr(
          fixture.captured[captured_before_delivery],
          "\"snapshot\":true") != NULL);
  assert(
      strstr(
          fixture.captured[captured_before_delivery],
          "\"conversationActive\":true") != NULL);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 2U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == captured_before_delivery + 4U);
  assert(
      strstr(
          fixture.captured[captured_before_delivery + 2U],
          "[\"pipeline\",-2,[]") != NULL);

  receive(&fixture, "[\"release\",1,1]");
  receive(&fixture, "[\"resolve\",1,null]");
  receive(&fixture, "[\"release\",2,1]");
  receive(&fixture, "[\"resolve\",2,null]");
  captured_before_delivery = fixture.captured_count;

  assert(
      iterate_kit_m5sticks3_publish_push_to_talk(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 3U).status ==
      ITERATE_KIT_POLL_OK);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 4U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == captured_before_delivery + 4U);
  assert(
      strstr(
          fixture.captured[captured_before_delivery],
          "[\"pipeline\",-1,[]") != NULL);
  assert(
      strstr(
          fixture.captured[captured_before_delivery],
          "\"type\":\"pushToTalk.started\"") != NULL);
  assert(
      strstr(
          fixture.captured[captured_before_delivery + 2U],
          "[\"pipeline\",-2,[]") != NULL);
  assert(
      strstr(
          fixture.captured[captured_before_delivery + 2U],
          "\"type\":\"pushToTalk.started\"") != NULL);

  capnweb_session_close(&fixture.session);
  iterate_kit_peer_session_ended(&fixture.device.peer);
  assert(
      iterate_kit_m5sticks3_close(&fixture.device).status ==
      ITERATE_KIT_POLL_OK);
}

/*
 * Fanout remains a finite device resource. Once the production and diagnostic
 * slots are occupied, a third callback must be released and rejected without
 * mutating either existing slot—even when one delivery is in flight. This is
 * the bounded counterpart to the non-replacement test above: concurrency is
 * useful only if exhaustion remains explicit and leak-free.
 */
static void full_subscriber_table_rejects_without_replacement(void) {
  struct fixture fixture;
  size_t captured_before_exhaustion;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.event_subscriptions[0].call_in_flight);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-2]]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(fixture.event_subscriptions[1].occupied);
  assert(fixture.event_subscriptions[1].callback.id == -2);
  captured_before_exhaustion = fixture.captured_count;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-3]]]]");
  receive(&fixture, "[\"pull\",3]");

  assert(fixture.event_subscriptions[0].occupied);
  assert(fixture.event_subscriptions[0].call_in_flight);
  assert(fixture.event_subscriptions[0].callback.id == -1);
  assert(fixture.event_subscriptions[1].occupied);
  assert(fixture.event_subscriptions[1].callback.id == -2);
  assert(fixture.captured_count == captured_before_exhaustion + 2U);
  assert(
      strcmp(
          fixture.captured[captured_before_exhaustion],
          "[\"release\",-3,1]") == 0);
  assert(
      strstr(
          fixture.captured[captured_before_exhaustion + 1U],
          "device event subscription limit reached") != NULL);

  capnweb_session_close(&fixture.session);
  iterate_kit_peer_session_ended(&fixture.device.peer);
  assert(
      iterate_kit_m5sticks3_close(&fixture.device).status ==
      ITERATE_KIT_POLL_OK);
}

/*
 * `/pcm` and Cap'n Web are intentionally independent sockets. A transient
 * PCM reconnect must therefore not consume another permanent event observer
 * on the still-live control session. Production reached exactly that state:
 * the Stick stayed online with good Wi-Fi, but every replacement userspace
 * generation failed with `device event subscription limit reached`, leaving
 * the physical buttons unable to drive the new bridge.
 *
 * An optional stable owner key is the narrow lifecycle contract. It does not
 * make ordinary diagnostic subscribers replace one another; only a caller
 * presenting the same non-empty key may supersede its own idle callback. The
 * old Cap'n Web import must be released before the slot is rebound, and an
 * unrelated observer must survive untouched. This models Worker eviction and
 * PCM generation replacement without a lease timer, heap allocation, or an
 * event-silence watchdog (silence is normal while nobody presses a button).
 */
static void stable_owner_key_replaces_only_its_stale_event_callback(void) {
  struct fixture fixture;
  size_t captured_before_replacement;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-1],\"iterate-kit-voice-pcm-v1\"]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);
  receive(&fixture, "[\"release\",1,1]");
  receive(&fixture, "[\"resolve\",1,null]");

  /* The second slot represents an independent, unkeyed diagnostic observer. */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-2]]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(fixture.event_subscriptions[1].callback.id == -2);
  captured_before_replacement = fixture.captured_count;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToEvents\"],"
      "[[\"export\",-3],\"iterate-kit-voice-pcm-v1\"]]]");
  receive(&fixture, "[\"pull\",3]");

  assert(fixture.event_subscriptions[0].callback.id == -3);
  assert(fixture.event_subscriptions[1].callback.id == -2);
  assert(fixture.captured_count == captured_before_replacement + 2U);
  assert(
      strcmp(
          fixture.captured[captured_before_replacement],
          "[\"release\",-1,1]") == 0);
  assert(
      strcmp(
          fixture.captured[captured_before_replacement + 1U],
          "[\"resolve\",3,null]") == 0);

  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 1U).status ==
      ITERATE_KIT_POLL_OK);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 2U).status ==
      ITERATE_KIT_POLL_OK);
  assert(
      strstr(
          fixture.captured[captured_before_replacement + 4U],
          "[\"pipeline\",-3,[]") != NULL);

  capnweb_session_close(&fixture.session);
  iterate_kit_peer_session_ended(&fixture.device.peer);
  assert(
      iterate_kit_m5sticks3_close(&fixture.device).status ==
      ITERATE_KIT_POLL_OK);
}

/*
 * A button edge and a remote Cap'n Web call must mean the same thing without
 * either callback touching the microphone driver inline. Direct work in the
 * GPIO/dispatch path was rejected because driver latency or reentrancy would
 * block the event loop and steal time from PCM. This proves both sources only
 * publish, the device owner applies transitions during poll, provenance is
 * retained for diagnostics, and explicit close—not session loss—owns teardown.
 */
static void remote_and_physical_conversation_controls_share_one_event_path(void) {
  struct fixture fixture;
  struct iterate_kit_device_event_queue_metrics metrics;
  fixture_init(&fixture);

  assert(
      iterate_kit_m5sticks3_publish_conversation(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 0U);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 0U);
  assert(fixture.prepare_playback_count == 1U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"conversation\",\"hangUp\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.stop_capture_count == 0U);
  assert(fixture.prepare_playback_count == 1U);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 1U).status ==
      ITERATE_KIT_POLL_OK);
  assert(!iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.stop_capture_count == 0U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"conversation\",\"start\"],[]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 2U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 0U);
  assert(fixture.prepare_playback_count == 2U);

  assert(
      iterate_kit_m5sticks3_publish_conversation(
          &fixture.device,
          false,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 3U).status ==
      ITERATE_KIT_POLL_OK);
  assert(!iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.stop_capture_count == 0U);

  assert(fixture.observed_count == 4U);
  assert(
      fixture.observed[0].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
  assert(
      fixture.observed[1].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
  assert(
      fixture.observed[2].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
  assert(
      fixture.observed[3].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
  for (size_t index = 0U; index < fixture.observed_count; ++index) {
    assert(fixture.observed_results[index] == ITERATE_KIT_OK);
  }

  iterate_kit_m5sticks3_event_metrics(&fixture.device, &metrics);
  assert(metrics.events_published == 4U);
  assert(metrics.events_processed == 4U);
  assert(metrics.publisher_backpressure == 0U);
  assert(metrics.handler_failures == 0U);
  assert(metrics.high_water_events == 1U);
  assert(metrics.current_events == 0U);

  capnweb_session_close(&fixture.session);
  iterate_kit_peer_session_ended(&fixture.device.peer);
  assert(
      iterate_kit_m5sticks3_close(&fixture.device).status ==
      ITERATE_KIT_POLL_OK);
}

/*
 * OS deliberately represents a flattened live mount as one
 * `invokeCapability({path,args})` call. This is not an alternate device API:
 * it is the adapter that prevents the host from awaiting an intermediate
 * Cap'n Web path proxy and accidentally calling `conversation` without
 * `start`.
 * Keep this production-shaped frame in the native suite because the direct
 * simulator path `device.conversation.start()` cannot expose that integration
 * mismatch. The adapter must still feed the same deferred event path; doing
 * microphone work inline here would violate the PCM-priority design.
 */
static void flattened_host_invocation_reaches_the_static_method_table(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"invokeCapability\"],"
      "[{\"args\":[[]],\"flattenNestedPath\":true,"
      "\"path\":[[\"conversation\",\"start\"]]}]]]");
  receive(&fixture, "[\"pull\",1]");

  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 0U);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 0U);
  assert(fixture.prepare_playback_count == 1U);
  assert(fixture.observed_count == 1U);
  assert(
      fixture.observed[0].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);

  capnweb_session_close(&fixture.session);
  iterate_kit_peer_session_ended(&fixture.device.peer);
  assert(
      iterate_kit_m5sticks3_close(&fixture.device).status ==
      ITERATE_KIT_POLL_OK);
}

/*
 * A call and a microphone turn are deliberately different state machines.
 * The top button (or conversation capability) owns the disposable provider
 * lifetime in userspace, while the front button (or pushToTalk capability)
 * alone owns the microphone. The target keeps its `/pcm` transport warm, but
 * this device profile deliberately knows nothing about that transport.
 * Collapsing call and PTT states previously turned provider VAD on and made
 * every call capture continuously, violating the product decision and making
 * echo handling unavoidable.
 *
 * This test also pins the awkward but safety-critical edges: a PTT press
 * outside a call is rejected without opening the mic, and hanging up while the
 * front button is held must synchronously stop capture before the socket owner
 * is allowed to tear the conversation down.
 */
static void conversation_lifetime_contains_manual_push_to_talk_turns(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  assert(
      iterate_kit_m5sticks3_publish_push_to_talk(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_DRIVER_ERROR);
  assert(!iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));

  assert(
      iterate_kit_m5sticks3_publish_conversation(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 1U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 0U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"pushToTalk\",\"start\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 2U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 1U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"conversation\",\"hangUp\"],[]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 3U).status ==
      ITERATE_KIT_POLL_OK);
  assert(!iterate_kit_m5sticks3_is_conversation_active(&fixture.device));
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.stop_capture_count == 1U);

  capnweb_session_close(&fixture.session);
  iterate_kit_peer_session_ended(&fixture.device.peer);
  assert(
      iterate_kit_m5sticks3_close(&fixture.device).status ==
      ITERATE_KIT_POLL_OK);
}

int main(void) {
  changes_only_the_two_public_screen_colours();
  conversation_lifetime_contains_manual_push_to_talk_turns();
  remote_and_physical_conversation_controls_share_one_event_path();
  flattened_host_invocation_reaches_the_static_method_table();
  independent_subscriber_cannot_disconnect_pcm_owner();
  full_subscriber_table_rejects_without_replacement();
  stable_owner_key_replaces_only_its_stale_event_callback();
  return 0;
}
