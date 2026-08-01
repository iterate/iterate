#include "iterate/kit/devices/stackchan.h"

#include <string.h>

/*
 * StackChan is the first rich capability profile: metrics, screen, servos,
 * LEDs, camera, and voice-control intent are generic modules, while this file
 * records only the board/product-specific composition and safe geometry.
 * Hardware access stays behind injected drivers so the same capability
 * contract can run in the host rig and on ESP-IDF without preprocessor forks.
 *
 * PCM remains outside this capability profile: the target composes the shared
 * realtime lane and owns board-specific microphone/speaker processing. The
 * control handler is only an owner-task transition seam and never queues
 * samples. That separation lets this manifest truthfully advertise continuous
 * local AEC/server-VAD policy without importing the known-bad accumulating
 * StackChan WebSocket queue.
 */
static const char description[] =
    "{\"instructions\":\"An Iterate StackChan with health metrics, screen, "
    "head servos, RGB LEDs, camera, and full-duplex AEC voice. PCM "
    "media uses the target's separate realtime WebSocket lane.\",\"children\":{"
    "\"subscribeToMetrics\":\"Call a callback immediately and once per "
    "configured interval with bounded runtime metrics.\","
    "\"subscribeToAecMetrics\":\"Call a callback with the latest aligned "
    "near, speaker-reference, and clean AEC signal window plus bounded "
    "timing and failure counters.\","
    "\"subscribeToEvents\":\"Call one callback with the current push-to-talk "
    "snapshot and each later processed call or talk transition.\","
    "\"getDiagnostics\":\"Return one retained control-transport incident "
    "snapshot.\","
    "\"renderOnScreen\":\"Download and render a PNG from {url}.\","
    "\"changeColour\":\"Fill the screen with red or green.\","
    "\"conversation\":{\"start\":\"Open the PCM conversation intent.\","
    "\"hangUp\":\"End the current conversation intent.\","
    "\"interruptPlayback\":\"Purge assistant speech and acknowledge only "
    "after the physical speaker owner has reset.\"},"
    "\"servos\":\"Head servos; call servos.move(...).\","
    "\"leds\":\"RGB LEDs; call leds.set(...) or leds.fill(...).\","
    "\"takePhoto\":\"Capture and return one bounded image byte array.\"}}";

const struct iterate_kit_device_manifest iterate_kit_stackchan_manifest = {
  "stackchan",
  "M5Stack StackChan",
  ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC,
};

static enum iterate_kit_status handle_event(
    void *context,
    const struct iterate_kit_device_event *event) {
  struct iterate_kit_stackchan *device = context;
  enum iterate_kit_status status = ITERATE_KIT_OK;
  if (device == NULL || event == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      /* Grok server VAD, not a second device state machine, owns speech turns. */
      return ITERATE_KIT_STATE_ERROR;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      break;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
    default:
      return ITERATE_KIT_INVALID_ARGUMENT;
  }

  if (device->control_driver.handler.handle != NULL) {
    /*
     * The target adapter runs only here, on the cooperative owner. Calling it
     * from remote dispatch or a GPIO producer would create two hardware owners
     * and make source timing—not queue order—decide which transition wins.
     */
    status = device->control_driver.handler.handle(
        device->control_driver.handler.context, event);
    if (status != ITERATE_KIT_OK) {
      return status;
    }
  }

  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      return ITERATE_KIT_STATE_ERROR;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
      device->conversation_active = true;
      break;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      /*
       * Conversation teardown is the only microphone publication boundary;
       * server VAD deliberately creates no device-side held/released state.
       */
      device->conversation_active = false;
      break;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
    default:
      return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return ITERATE_KIT_OK;
}

static void observe_event(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  struct iterate_kit_stackchan *device = context;
  enum iterate_kit_status stream_status;
  if (device == NULL || event == NULL) {
    return;
  }
  /*
   * Local state and the target adapter have already completed. A saturated or
   * slow remote callback must never roll either back; the event stream retains
   * bounded newest-state evidence and exposes any coalescing by sequence.
   */
  stream_status = iterate_kit_device_event_stream_observe(
      &device->event_stream, event, result);
  (void)stream_status;
  if (device->control_driver.observer.observe != NULL) {
    device->control_driver.observer.observe(
        device->control_driver.observer.context, event, result);
  }
}

enum capnweb_status iterate_kit_stackchan_init(
    struct iterate_kit_stackchan *device,
    const struct iterate_kit_stackchan_options *options) {
  static const struct iterate_kit_servo_limits servo_limits = {
    -128,
    128,
    0,
    90,
    1000U,
  };
  /*
   * These are StackChan mechanical/speed limits, not universal servo ranges.
   * Keeping them here prevents the generic servo capability from baking one
   * enclosure's geometry into every future device.
   */
  struct iterate_kit_peer_options peer_options;
  struct iterate_kit_metrics_options metrics_options;
  struct iterate_kit_device_event_stream_options event_stream_options;
  struct iterate_kit_device_event_queue_options event_options;
  if (device == NULL || options == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(device, 0, sizeof(*device));
  if (iterate_kit_callback_budget_init(
          &device->callback_budget,
          ITERATE_KIT_STACKCHAN_MAXIMUM_IN_FLIGHT_CALLBACKS) !=
      ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  metrics_options = options->metrics;
  metrics_options.callback_budget = &device->callback_budget;
  event_stream_options =
      (struct iterate_kit_device_event_stream_options){
        .session = options->metrics.session,
        .storage = device->event_notifications,
        .capacity = ITERATE_KIT_STACKCHAN_EVENT_NOTIFICATION_CAPACITY,
        .callback_budget = &device->callback_budget,
        .audio_mode = iterate_kit_stackchan_manifest.audio_mode,
      };
  /*
   * Do not expose a partially assembled peer. Every module validates its
   * driver and fixed resource budget first; failure leaves the profile
   * unreachable and gives the platform one deterministic boot error.
   */
  if (iterate_kit_screen_init(
          &device->screen,
          &options->screen,
          options->screen_url_scratch,
          options->screen_url_scratch_size) != ITERATE_KIT_OK ||
      iterate_kit_servos_init(
          &device->servos,
          &options->servos,
          &servo_limits) != ITERATE_KIT_OK ||
      iterate_kit_leds_init(
          &device->leds, &options->leds, 12U) != ITERATE_KIT_OK ||
      iterate_kit_camera_init(
          &device->camera,
          &options->camera,
          options->maximum_photo_bytes) != ITERATE_KIT_OK ||
      iterate_kit_metrics_init(
          &device->metrics, &metrics_options) != ITERATE_KIT_OK ||
      iterate_kit_device_event_stream_init(
          &device->event_stream,
          &event_stream_options) != ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  event_options = (struct iterate_kit_device_event_queue_options){
    .storage = device->event_storage,
    .capacity = ITERATE_KIT_STACKCHAN_EVENT_CAPACITY,
    .handler = {
      .context = device,
      .handle = handle_event,
    },
    .observer = {
      .context = device,
      .observe = observe_event,
    },
  };
  if (iterate_kit_device_event_queue_init(
          &device->events, &event_options) != ITERATE_KIT_OK ||
      iterate_kit_conversation_init(
          &device->conversation, &device->events) != ITERATE_KIT_OK ||
      iterate_kit_conversation_bind_playback_interruption(
          &device->conversation,
          &options->playback_interruption) != ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  /*
   * Event state is latency-sensitive control for the separate PCM lane.
   * Polling it before metrics means a physical edge claims a shared callback
   * slot first; metrics skip a busy interval instead of delaying voice state
   * or building stale history.
   */
  device->modules[0] =
      iterate_kit_device_event_stream_module(&device->event_stream);
  device->modules[1] = iterate_kit_metrics_module(&device->metrics);
  device->modules[2] = iterate_kit_screen_module(&device->screen);
  device->modules[3] =
      iterate_kit_conversation_module(&device->conversation);
  device->modules[4] = iterate_kit_servos_module(&device->servos);
  device->modules[5] = iterate_kit_leds_module(&device->leds);
  device->modules[6] = iterate_kit_camera_module(&device->camera);
  /*
   * Routing remains one fixed table even though the public description is
   * nested. Each generic module owns its method path, avoiding a per-profile
   * dynamic capability tree and its RAM/lifetime complexity.
   */
  peer_options = (struct iterate_kit_peer_options){
    description,
    sizeof(description) - 1U,
    device->modules,
    sizeof(device->modules) / sizeof(device->modules[0]),
  };
  return iterate_kit_peer_init(&device->peer, &peer_options);
}

enum iterate_kit_status iterate_kit_stackchan_bind_control_driver(
    struct iterate_kit_stackchan *device,
    const struct iterate_kit_stackchan_control_driver *driver) {
  if (device == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!device->peer.initialized || !device->events.initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  /*
   * Copying two tiny callback descriptors avoids another borrowed options
   * lifetime and makes unbinding deterministic. The caller still owns the
   * callback context, exactly like every other profile driver.
   */
  if (driver == NULL) {
    memset(&device->control_driver, 0, sizeof(device->control_driver));
  } else {
    device->control_driver = *driver;
  }
  return ITERATE_KIT_OK;
}

struct capnweb_capability iterate_kit_stackchan_capability(
    struct iterate_kit_stackchan *device) {
  return iterate_kit_peer_capability(&device->peer);
}

struct iterate_kit_poll_result iterate_kit_stackchan_poll(
    struct iterate_kit_stackchan *device, uint64_t now_ms) {
  if (device == NULL ||
      iterate_kit_device_event_poll(
          &device->events,
          ITERATE_KIT_STACKCHAN_EVENTS_PER_POLL) != ITERATE_KIT_OK) {
    const struct iterate_kit_poll_result result = {
      ITERATE_KIT_POLL_DRIVER_ERROR,
      CAPNWEB_OK,
    };
    return result;
  }
  /*
   * A fixed drain budget keeps a remote or physical edge burst from turning
   * one cooperative poll into unbounded actuator work. Accepted remainder
   * stays in the explicit queue and its depth/high-water remain diagnostic.
   */
  return iterate_kit_peer_poll(&device->peer, now_ms);
}

struct iterate_kit_poll_result iterate_kit_stackchan_close(
    struct iterate_kit_stackchan *device) {
  return iterate_kit_peer_close(&device->peer);
}

static struct iterate_kit_poll_result poll_device(
    void *context, uint64_t now_ms) {
  return iterate_kit_stackchan_poll(context, now_ms);
}

static struct iterate_kit_poll_result close_device(void *context) {
  return iterate_kit_stackchan_close(context);
}

struct iterate_kit_device iterate_kit_stackchan_device(
    struct iterate_kit_stackchan *device) {
  const struct iterate_kit_device runtime = {
    &iterate_kit_stackchan_manifest,
    iterate_kit_stackchan_capability(device),
    device,
    poll_device,
    close_device,
  };
  return runtime;
}

enum iterate_kit_status iterate_kit_stackchan_publish_conversation(
    struct iterate_kit_stackchan *device,
    bool active,
    enum iterate_kit_device_event_source source) {
  if (device == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return iterate_kit_device_event_publish(
      &device->events,
      active
          ? ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED
          : ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED,
      source);
}

bool iterate_kit_stackchan_is_conversation_active(
    const struct iterate_kit_stackchan *device) {
  return device != NULL && device->conversation_active;
}

void iterate_kit_stackchan_event_metrics(
    const struct iterate_kit_stackchan *device,
    struct iterate_kit_device_event_queue_metrics *metrics) {
  iterate_kit_device_event_queue_metrics(
      device == NULL ? NULL : &device->events, metrics);
}
