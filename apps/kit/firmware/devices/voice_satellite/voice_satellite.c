#include "iterate/kit/devices/voice_satellite.h"

#include <string.h>

/*
 * This description deliberately omits screen/camera/servo methods. A generic
 * profile is useful only while it remains truthful: a remote agent must not
 * discover placeholder actions that can never succeed on the concrete board.
 * Audio media also stays absent because its dedicated binary WebSocket has a
 * different scheduling and failure contract from Cap'n Web control traffic.
 */
static const char description[] =
    "{\"instructions\":\"A full-duplex Iterate voice satellite with local "
    "AEC, provider-side VAD, health metrics, lifecycle events, and RGB LEDs. "
    "PCM media uses a separate realtime WebSocket lane.\",\"children\":{"
    "\"subscribeToMetrics\":\"Call a callback immediately and once per "
    "configured interval with bounded runtime metrics.\","
    "\"subscribeToAecMetrics\":\"Call a callback with the latest aligned "
    "near, speaker-reference, and clean AEC window.\","
    "\"subscribeToEvents\":\"Call a callback with the current conversation "
    "snapshot and each later lifecycle transition.\","
    "\"getDiagnostics\":\"Return the latest retained transport incident "
    "snapshot.\","
    "\"conversation\":{\"start\":\"Open the PCM conversation intent.\","
    "\"hangUp\":\"End the PCM conversation intent.\","
    "\"interruptPlayback\":\"Purge assistant speech and acknowledge only "
    "after the physical speaker owner has reset.\"},"
    "\"leds\":\"RGB LEDs; call leds.set(...) or leds.fill(...).\"}}";

static enum iterate_kit_status handle_event(
    void *context,
    const struct iterate_kit_device_event *event) {
  struct iterate_kit_voice_satellite *device = context;
  enum iterate_kit_status status;
  if (device == NULL || event == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      break;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      /*
       * The hardware AEC path is continuously publishable while connected;
       * provider VAD owns speech turns. Accepting PTT too would create two
       * contradictory gates and make a remote edge silently mute live audio.
       */
      return ITERATE_KIT_STATE_ERROR;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
    default:
      return ITERATE_KIT_INVALID_ARGUMENT;
  }

  if (device->control_driver.handler.handle != NULL) {
    status = device->control_driver.handler.handle(
        device->control_driver.handler.context, event);
    if (status != ITERATE_KIT_OK) {
      return status;
    }
  }

  device->conversation_active =
      event->type == ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED;
  return ITERATE_KIT_OK;
}

static void observe_event(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  struct iterate_kit_voice_satellite *device = context;
  enum iterate_kit_status stream_status;
  if (device == NULL || event == NULL) {
    return;
  }
  /*
   * The platform transition has already finished. Diagnostic subscriber
   * pressure must never roll it back, so the bounded stream records/coalesces
   * after the state transition and reports its independent result by sequence.
   */
  stream_status = iterate_kit_device_event_stream_observe(
      &device->event_stream, event, result);
  (void)stream_status;
  if (device->control_driver.observer.observe != NULL) {
    device->control_driver.observer.observe(
        device->control_driver.observer.context, event, result);
  }
}

enum capnweb_status iterate_kit_voice_satellite_init(
    struct iterate_kit_voice_satellite *device,
    const struct iterate_kit_voice_satellite_options *options) {
  struct iterate_kit_metrics_options metrics_options;
  struct iterate_kit_device_event_stream_options stream_options;
  struct iterate_kit_device_event_queue_options event_options;
  struct iterate_kit_peer_options peer_options;

  if (device == NULL || options == NULL || options->manifest == NULL ||
      options->manifest->slug == NULL ||
      options->manifest->display_name == NULL ||
      options->manifest->audio_mode != ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(device, 0, sizeof(*device));
  device->manifest = options->manifest;

  if (iterate_kit_callback_budget_init(
          &device->callback_budget,
          ITERATE_KIT_VOICE_SATELLITE_MAXIMUM_IN_FLIGHT_CALLBACKS) !=
      ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  metrics_options = options->metrics;
  metrics_options.callback_budget = &device->callback_budget;
  stream_options = (struct iterate_kit_device_event_stream_options){
    .session = options->metrics.session,
    .storage = device->event_notifications,
    .capacity = ITERATE_KIT_VOICE_SATELLITE_EVENT_NOTIFICATION_CAPACITY,
    .subscriptions = device->event_subscriptions,
    .subscription_count =
        ITERATE_KIT_VOICE_SATELLITE_EVENT_SUBSCRIPTION_CAPACITY,
    .callback_budget = &device->callback_budget,
    .audio_mode = options->manifest->audio_mode,
  };

  /*
   * Assemble every module before exposing the peer. That makes a missing LED,
   * metrics, or interruption driver one deterministic boot failure rather
   * than a partly truthful capability tree that fails only under remote use.
   */
  if (iterate_kit_metrics_init(&device->metrics, &metrics_options) !=
          ITERATE_KIT_OK ||
      iterate_kit_device_event_stream_init(
          &device->event_stream, &stream_options) != ITERATE_KIT_OK ||
      iterate_kit_leds_init(
          &device->leds, &options->leds, options->led_count) !=
          ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  event_options = (struct iterate_kit_device_event_queue_options){
    .storage = device->event_storage,
    .capacity = ITERATE_KIT_VOICE_SATELLITE_EVENT_CAPACITY,
    .handler = {.context = device, .handle = handle_event},
    .observer = {.context = device, .observe = observe_event},
  };
  if (iterate_kit_device_event_queue_init(
          &device->events, &event_options) != ITERATE_KIT_OK ||
      iterate_kit_conversation_init(
          &device->conversation, &device->events) != ITERATE_KIT_OK ||
      iterate_kit_conversation_bind_playback_interruption(
          &device->conversation, &options->playback_interruption) !=
          ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  /*
   * Event delivery and conversation interruption poll before observational
   * metrics. A slow metrics callback may miss an interval; it must never delay
   * lifecycle control or consume the shared callback budget first.
   */
  device->modules[0] =
      iterate_kit_device_event_stream_module(&device->event_stream);
  device->modules[1] = iterate_kit_metrics_module(&device->metrics);
  device->modules[2] =
      iterate_kit_conversation_module(&device->conversation);
  device->modules[3] = iterate_kit_leds_module(&device->leds);
  peer_options = (struct iterate_kit_peer_options){
    .description_expression = description,
    .description_expression_length = sizeof(description) - 1U,
    .modules = device->modules,
    .module_count = ITERATE_KIT_VOICE_SATELLITE_MODULE_COUNT,
  };
  return iterate_kit_peer_init(&device->peer, &peer_options);
}

enum iterate_kit_status iterate_kit_voice_satellite_bind_control_driver(
    struct iterate_kit_voice_satellite *device,
    const struct iterate_kit_voice_satellite_control_driver *driver) {
  if (device == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!device->peer.initialized || !device->events.initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (driver == NULL) {
    memset(&device->control_driver, 0, sizeof(device->control_driver));
  } else {
    device->control_driver = *driver;
  }
  return ITERATE_KIT_OK;
}

struct capnweb_capability iterate_kit_voice_satellite_capability(
    struct iterate_kit_voice_satellite *device) {
  return iterate_kit_peer_capability(device == NULL ? NULL : &device->peer);
}

struct iterate_kit_poll_result iterate_kit_voice_satellite_poll(
    struct iterate_kit_voice_satellite *device, uint64_t now_ms) {
  if (device == NULL ||
      iterate_kit_device_event_poll(
          &device->events,
          ITERATE_KIT_VOICE_SATELLITE_EVENTS_PER_POLL) != ITERATE_KIT_OK) {
    const struct iterate_kit_poll_result result = {
      ITERATE_KIT_POLL_DRIVER_ERROR,
      CAPNWEB_OK,
    };
    return result;
  }
  return iterate_kit_peer_poll(&device->peer, now_ms);
}

struct iterate_kit_poll_result iterate_kit_voice_satellite_close(
    struct iterate_kit_voice_satellite *device) {
  return iterate_kit_peer_close(device == NULL ? NULL : &device->peer);
}

static struct iterate_kit_poll_result poll_device(
    void *context, uint64_t now_ms) {
  return iterate_kit_voice_satellite_poll(context, now_ms);
}

static struct iterate_kit_poll_result close_device(void *context) {
  return iterate_kit_voice_satellite_close(context);
}

struct iterate_kit_device iterate_kit_voice_satellite_device(
    struct iterate_kit_voice_satellite *device) {
  const struct iterate_kit_device runtime = {
    device == NULL ? NULL : device->manifest,
    iterate_kit_voice_satellite_capability(device),
    device,
    poll_device,
    close_device,
  };
  return runtime;
}

enum iterate_kit_status iterate_kit_voice_satellite_publish_conversation(
    struct iterate_kit_voice_satellite *device,
    bool active,
    enum iterate_kit_device_event_source source) {
  if (device == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return iterate_kit_device_event_publish(
      &device->events,
      active ? ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED
             : ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED,
      source);
}

bool iterate_kit_voice_satellite_is_conversation_active(
    const struct iterate_kit_voice_satellite *device) {
  return device != NULL && device->conversation_active;
}

void iterate_kit_voice_satellite_event_metrics(
    const struct iterate_kit_voice_satellite *device,
    struct iterate_kit_device_event_queue_metrics *metrics) {
  iterate_kit_device_event_queue_metrics(
      device == NULL ? NULL : &device->events, metrics);
}
