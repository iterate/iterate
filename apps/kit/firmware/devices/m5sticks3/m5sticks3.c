#include "iterate/kit/devices/m5sticks3.h"

#include <string.h>

/*
 * This file is a composition root, not an M5 hardware driver. It chooses which
 * reusable capabilities describe an M5StickS3 and funnels both the main button
 * and remote push-to-talk calls through one bounded event queue. The actual
 * GPIO/I2S/display/network implementation stays in the platform layer, where
 * task priority and board revisions can differ without forking the capability
 * contract.
 *
 * Audio remains a separate PCM connection; the Cap'n Web modules here carry
 * state transitions and diagnostics only. That split prevents a large control
 * reply or callback from becoming head-of-line blocking for microphone/speaker
 * frames.
 */
static const char description[] =
    "{\"instructions\":\"An Iterate M5StickS3 with health metrics, a small "
    "screen, push-to-talk button, microphone, and speaker. Hold the main "
    "button to send audio on the separate bounded PCM socket.\",\"children\":{"
    "\"subscribeToMetrics\":\"Call a callback immediately and once per "
    "configured interval with bounded runtime metrics.\","
    "\"subscribeToPlaybackMetrics\":\"Call a callback immediately and once "
    "per configured interval with raw playback timing, loss, buffer, stack, "
    "heap, and CPU evidence for endurance diagnostics.\","
    "\"renderOnScreen\":\"Download and render a PNG from {url}.\","
    "\"pushToTalk\":{\"start\":\"Queue a push-to-talk start event.\","
    "\"stop\":\"Queue a push-to-talk stop event.\"}}}";

const struct iterate_kit_device_manifest iterate_kit_m5sticks3_manifest = {
  "m5sticks3",
  "M5Stack M5StickS3",
  ITERATE_KIT_AUDIO_PUSH_TO_TALK,
};

static enum iterate_kit_status handle_event(
    void *context,
    const struct iterate_kit_device_event *event) {
  struct iterate_kit_m5sticks3 *device = context;
  if (device == NULL || event == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  switch ((enum iterate_kit_device_event_type)event->type) {
    /*
     * Source does not change audio semantics. Keeping it on the event is for
     * observers/diagnostics; remote and physical transitions must exercise the
     * exact same capture state machine.
     */
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
      return iterate_kit_audio_push_to_talk(&device->audio, true);
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      return iterate_kit_audio_push_to_talk(&device->audio, false);
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

enum capnweb_status iterate_kit_m5sticks3_init(
    struct iterate_kit_m5sticks3 *device,
    const struct iterate_kit_m5sticks3_options *options) {
  struct iterate_kit_peer_options peer_options;
  struct iterate_kit_device_event_queue_options event_options;
  if (device == NULL || options == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(device, 0, sizeof(*device));
  /*
   * Initialization is transactional at the composition boundary: no peer is
   * exposed until every required module accepts its borrowed storage/driver.
   * Individual hardware drivers are initialized by the platform before this
   * call, so this path performs no I/O and allocates nothing.
   */
  if (iterate_kit_screen_init(
          &device->screen,
          &options->screen,
          options->screen_url_scratch,
          options->screen_url_scratch_size) != ITERATE_KIT_OK ||
      iterate_kit_metrics_init(
          &device->metrics, &options->metrics) != ITERATE_KIT_OK ||
      iterate_kit_audio_controller_init(
          &device->audio, &options->audio) != ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  event_options = (struct iterate_kit_device_event_queue_options){
    .storage = options->event_storage,
    .capacity = options->event_capacity,
    .handler = {
      .context = device,
      .handle = handle_event,
    },
    .observer = options->event_observer,
  };
  if (iterate_kit_device_event_queue_init(
          &device->events, &event_options) != ITERATE_KIT_OK ||
      iterate_kit_push_to_talk_init(
          &device->push_to_talk, &device->events) != ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  device->modules[0] = iterate_kit_metrics_module(&device->metrics);
  device->modules[1] = iterate_kit_screen_module(&device->screen);
  device->modules[2] =
      iterate_kit_push_to_talk_module(&device->push_to_talk);
  device->modules[3] = iterate_kit_audio_module(&device->audio);
  /*
   * A flat module table is sufficient: modules themselves publish the desired
   * method paths (for example pushToTalk.start). Building a heap capability
   * tree per device would duplicate routing state and make profile RAM grow
   * with descriptive nesting.
   */
  peer_options = (struct iterate_kit_peer_options){
    description,
    sizeof(description) - 1U,
    device->modules,
    sizeof(device->modules) / sizeof(device->modules[0]),
  };
  return iterate_kit_peer_init(&device->peer, &peer_options);
}

struct capnweb_capability iterate_kit_m5sticks3_capability(
    struct iterate_kit_m5sticks3 *device) {
  return iterate_kit_peer_capability(&device->peer);
}

struct iterate_kit_poll_result iterate_kit_m5sticks3_poll(
    struct iterate_kit_m5sticks3 *device, uint64_t now_ms) {
  if (device == NULL ||
      iterate_kit_device_event_poll(
          &device->events,
          ITERATE_KIT_M5STICKS3_EVENTS_PER_POLL) !=
          ITERATE_KIT_OK) {
    const struct iterate_kit_poll_result result = {
      ITERATE_KIT_POLL_DRIVER_ERROR,
      CAPNWEB_OK,
    };
    return result;
  }
  /*
   * Drain only the profile budget before polling capability modules. Under a
   * noisy button/remote event burst this preserves bounded control-loop latency
   * instead of letting queue length postpone metrics/audio protocol progress.
   */
  return iterate_kit_peer_poll(&device->peer, now_ms);
}

struct iterate_kit_poll_result iterate_kit_m5sticks3_close(
    struct iterate_kit_m5sticks3 *device) {
  return iterate_kit_peer_close(&device->peer);
}

static struct iterate_kit_poll_result poll_device(
    void *context, uint64_t now_ms) {
  return iterate_kit_m5sticks3_poll(context, now_ms);
}

static struct iterate_kit_poll_result close_device(void *context) {
  return iterate_kit_m5sticks3_close(context);
}

struct iterate_kit_device iterate_kit_m5sticks3_device(
    struct iterate_kit_m5sticks3 *device) {
  const struct iterate_kit_device runtime = {
    &iterate_kit_m5sticks3_manifest,
    iterate_kit_m5sticks3_capability(device),
    device,
    poll_device,
    close_device,
  };
  return runtime;
}

enum iterate_kit_status iterate_kit_m5sticks3_publish_push_to_talk(
    struct iterate_kit_m5sticks3 *device,
    bool active,
    enum iterate_kit_device_event_source source) {
  if (device == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return iterate_kit_device_event_publish(
      &device->events,
      active
          ? ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED
          : ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED,
      source);
}

enum iterate_kit_status iterate_kit_m5sticks3_note_playback_started(
    struct iterate_kit_m5sticks3 *device) {
  if (device == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return iterate_kit_audio_note_playback_started(&device->audio);
}

enum iterate_kit_status iterate_kit_m5sticks3_submit_capture(
    struct iterate_kit_m5sticks3 *device,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz) {
  if (device == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return iterate_kit_audio_submit_capture(
      &device->audio, samples, sample_count, sample_rate_hz);
}

const struct iterate_kit_audio_metrics *
iterate_kit_m5sticks3_audio_metrics(
    const struct iterate_kit_m5sticks3 *device) {
  return device == NULL ? NULL : &device->audio.metrics;
}

bool iterate_kit_m5sticks3_is_capturing(
    const struct iterate_kit_m5sticks3 *device) {
  return device != NULL && device->audio.capture_active;
}

void iterate_kit_m5sticks3_event_metrics(
    const struct iterate_kit_m5sticks3 *device,
    struct iterate_kit_device_event_queue_metrics *metrics) {
  iterate_kit_device_event_queue_metrics(
      device == NULL ? NULL : &device->events, metrics);
}
