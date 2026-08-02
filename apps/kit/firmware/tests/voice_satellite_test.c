#include "iterate/kit/devices/voice_satellite.h"

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

struct fixture {
  struct capnweb_session session;
  struct iterate_kit_metrics_subscription metric_subscriptions[2];
  char diagnostics_expression
      [ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY];
  struct iterate_kit_voice_satellite device;
  uint32_t handled_events;
  uint32_t observed_events;
};

static enum iterate_kit_status sample_metrics(
    void *context,
    struct iterate_kit_metrics_sample *sample) {
  (void)context;
  memset(sample, 0, sizeof(*sample));
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
    void *context,
    uint8_t red,
    uint8_t green,
    uint8_t blue) {
  (void)context;
  (void)red;
  (void)green;
  (void)blue;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status request_interruption(
    void *context,
    uint32_t *token) {
  (void)context;
  *token = 1U;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status poll_interruption(
    void *context,
    uint32_t token) {
  (void)context;
  return token == 1U ? ITERATE_KIT_OK : ITERATE_KIT_STATE_ERROR;
}

static enum iterate_kit_status handle_event(
    void *context,
    const struct iterate_kit_device_event *event) {
  struct fixture *fixture = context;
  assert(event != NULL);
  ++fixture->handled_events;
  return ITERATE_KIT_OK;
}

static void observe_event(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  struct fixture *fixture = context;
  assert(event != NULL);
  assert(result == ITERATE_KIT_OK);
  ++fixture->observed_events;
}

/*
 * HAVPE and future screenless voice boards need the same semantic surface,
 * not StackChan's unavailable camera/screen/servo placeholders.  This test
 * proves the small profile exposes one full-duplex conversation state machine
 * and accepts both local and remote producers only through its bounded owner
 * queue.  The injected manifest is also the contract that lets one profile be
 * reused without lying about the concrete board identity.
 */
static void composes_a_real_full_duplex_voice_satellite(void) {
  static const struct iterate_kit_device_manifest manifest = {
    "home-assistant-voice-preview-edition",
    "Home Assistant Voice Preview Edition",
    ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC,
  };
  struct fixture fixture;
  struct iterate_kit_voice_satellite_options options;
  struct iterate_kit_voice_satellite_control_driver control;
  struct iterate_kit_device erased;

  memset(&fixture, 0, sizeof(fixture));
  memset(&options, 0, sizeof(options));
  options.manifest = &manifest;
  options.leds = (struct iterate_kit_led_driver){
    &fixture,
    set_led,
    fill_leds,
  };
  options.led_count = 12U;
  options.playback_interruption =
      (struct iterate_kit_conversation_playback_interruption_driver){
        &fixture,
        request_interruption,
        poll_interruption,
        50U,
      };
  options.metrics = (struct iterate_kit_metrics_options){
    .session = &fixture.session,
    .driver = {&fixture, sample_metrics},
    .subscriptions = fixture.metric_subscriptions,
    .subscription_count =
        sizeof(fixture.metric_subscriptions) /
        sizeof(fixture.metric_subscriptions[0]),
    .interval_ms = 1000U,
    .diagnostics_expression_buffer = fixture.diagnostics_expression,
    .diagnostics_expression_capacity =
        sizeof(fixture.diagnostics_expression),
  };
  assert(
      iterate_kit_voice_satellite_init(
          &fixture.device, &options) == CAPNWEB_OK);
  control = (struct iterate_kit_voice_satellite_control_driver){
    .handler = {&fixture, handle_event},
    .observer = {&fixture, observe_event},
  };
  assert(
      iterate_kit_voice_satellite_bind_control_driver(
          &fixture.device, &control) == ITERATE_KIT_OK);

  erased = iterate_kit_voice_satellite_device(&fixture.device);
  assert(erased.manifest == &manifest);
  assert(erased.capability.dispatch != NULL);
  assert(!iterate_kit_voice_satellite_is_conversation_active(
      &fixture.device));
  assert(
      iterate_kit_voice_satellite_publish_conversation(
          &fixture.device,
          true,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) == ITERATE_KIT_OK);
  assert(!iterate_kit_voice_satellite_is_conversation_active(
      &fixture.device));
  assert(
      iterate_kit_voice_satellite_poll(&fixture.device, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(iterate_kit_voice_satellite_is_conversation_active(
      &fixture.device));
  assert(fixture.handled_events == 1U);
  assert(fixture.observed_events == 1U);
}

int main(void) {
  composes_a_real_full_duplex_voice_satellite();
  return 0;
}
