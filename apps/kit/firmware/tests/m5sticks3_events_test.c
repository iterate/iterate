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
  OBSERVED_CAPACITY = 8,
};

struct fixture {
  struct capnweb_session session;
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  char screen_url[64];
  struct iterate_kit_metrics_subscription subscription;
  struct iterate_kit_device_event event_storage[EVENT_CAPACITY];
  struct iterate_kit_device_event observed[OBSERVED_CAPACITY];
  enum iterate_kit_status observed_results[OBSERVED_CAPACITY];
  size_t observed_count;
  size_t start_capture_count;
  size_t stop_capture_count;
  size_t capture_poll_count;
  struct iterate_kit_m5sticks3 device;
};

static enum capnweb_status discard_text(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  (void)context;
  (void)kind;
  (void)data;
  (void)length;
  return CAPNWEB_OK;
}

static enum iterate_kit_status render_png(
    void *context, const char *url, size_t length) {
  (void)context;
  (void)url;
  (void)length;
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
    .screen = {fixture, render_png},
    .screen_url_scratch = fixture->screen_url,
    .screen_url_scratch_size = sizeof(fixture->screen_url),
    .metrics = {
      &fixture->session,
      {fixture, sample_metrics},
      &fixture->subscription,
      1U,
      1000U,
      NULL,
      0U,
    },
    .audio = {
      ITERATE_KIT_AUDIO_PUSH_TO_TALK,
      {
        fixture,
        start_capture,
        stop_capture,
        audio_ok,
        audio_ok,
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
    .event_observer = {
      fixture,
      observe_event,
    },
  };
  assert(
      iterate_kit_m5sticks3_init(
          &fixture->device, &device_options) == CAPNWEB_OK);
  session_options = (struct capnweb_session_options){
    iterate_kit_m5sticks3_capability(&fixture->device),
    discard_text,
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
 * A button edge and a remote Cap'n Web call must mean the same thing without
 * either callback touching the microphone driver inline. Direct work in the
 * GPIO/dispatch path was rejected because driver latency or reentrancy would
 * block the event loop and steal time from PCM. This proves both sources only
 * publish, the device owner applies transitions during poll, provenance is
 * retained for diagnostics, and explicit close—not session loss—owns teardown.
 */
static void remote_and_physical_inputs_share_one_deferred_event_path(void) {
  struct fixture fixture;
  struct iterate_kit_device_event_queue_metrics metrics;
  fixture_init(&fixture);

  assert(
      iterate_kit_m5sticks3_publish_push_to_talk(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 0U);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 1U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"pushToTalk\",\"stop\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.stop_capture_count == 0U);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 1U).status ==
      ITERATE_KIT_POLL_OK);
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.stop_capture_count == 1U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"pushToTalk\",\"start\"],[]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 2U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.start_capture_count == 2U);

  assert(
      iterate_kit_m5sticks3_publish_push_to_talk(
          &fixture.device,
          false,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_m5sticks3_poll(&fixture.device, 3U).status ==
      ITERATE_KIT_POLL_OK);
  assert(!iterate_kit_m5sticks3_is_capturing(&fixture.device));
  assert(fixture.stop_capture_count == 2U);

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

int main(void) {
  remote_and_physical_inputs_share_one_deferred_event_path();
  return 0;
}
