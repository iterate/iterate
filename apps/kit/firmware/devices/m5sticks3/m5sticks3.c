#include "iterate/kit/devices/m5sticks3.h"

#include <string.h>

/*
 * This file is a composition root, not an M5 hardware driver. It chooses which
 * reusable capabilities describe an M5StickS3 and funnels both physical
 * buttons and remote lifecycle calls through one bounded event queue. The actual
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
    "screen, context-menu button, manual push-to-talk button, microphone, and "
    "speaker. Tap the top button to open or advance the menu. Hold the front "
    "button to talk, or double-tap it to lock or unlock a longer turn. With "
    "the menu open, the front button chooses the selected action. The bottom "
    "button remains the hardware reset control.\","
    "\"children\":{"
    "\"subscribeToMetrics\":\"Call a callback immediately and once per "
    "configured interval with bounded runtime metrics.\","
    "\"subscribeToPlaybackMetrics\":\"Call a callback immediately and once "
    "per configured interval with raw playback timing, loss, buffer, stack, "
    "heap, and CPU evidence for endurance diagnostics.\","
    "\"subscribeToEvents\":\"Call one callback with the current push-to-talk "
    "snapshot and each later processed call or talk transition.\","
    "\"getDiagnostics\":\"Return one retained control-transport incident "
    "snapshot. This remains available after a WebSocket reconnect.\","
    "\"renderOnScreen\":\"Download and render a PNG from {url}.\"," 
    "\"captureScreen\":\"Return the pixels currently shown on the panel as a "
    "bounded PNG byte array.\"," 
    "\"changeSpriteSet\":\"Select dot-matrix-oracle, karakuri-brass, or "
    "starbyte.\","
    "\"conversation\":{\"start\":\"Open the PCM conversation.\","
    "\"hangUp\":\"End the current conversation.\"},"
    "\"pushToTalk\":{\"start\":\"Start one manual microphone turn.\","
    "\"stop\":\"Commit the current microphone turn.\"},"
    "\"logicalInput\":{"
    "\"talk\":{\"setPressed\":\"Inject the remote TALK down/up level.\"},"
    "\"menu\":{\"setPressed\":\"Inject the remote MENU down/up level.\"}}}}";

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
      /*
       * A stray front-button press must not power the mic or fill a
       * disconnected PCM lane. The failed event remains observable, so this
       * is a modeled rejection rather than a silently ignored GPIO edge.
       */
      if (!device->conversation_active) {
        return ITERATE_KIT_STATE_ERROR;
      }
      return iterate_kit_audio_push_to_talk(&device->audio, true);
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      /*
       * Stop is safe and idempotent outside a call. This closes the ordinary
       * race where hang-up and the physical release are queued together.
       */
      return iterate_kit_audio_push_to_talk(&device->audio, false);
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED: {
      /*
       * Hang-up leaves the half-duplex speaker deliberately suspended after
       * purging the previous generation. Conversation start must still make
       * the output hardware ready before returning success, but it does not
       * authorize provider speech: in manual PTT mode only a completed front-
       * button turn does that. Preparing here keeps the first legitimate
       * answer off the codec/I2S initialization path without resurrecting the
       * discarded "Grok speaks first" product behavior.
       */
      const enum iterate_kit_status status =
          iterate_kit_audio_prepare_playback(&device->audio);
      if (status == ITERATE_KIT_OK) {
        device->conversation_active = true;
      }
      return status;
    }
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED: {
      enum iterate_kit_status status =
          iterate_kit_audio_push_to_talk(&device->audio, false);
      if (status == ITERATE_KIT_OK) {
        /*
         * Hang-up is also a playback generation boundary. Waiting for the
         * network task to close before flushing the speaker can leave already
         * accepted Grok audio audible after the call indicator says idle.
         */
        status = iterate_kit_audio_interrupt_playback(&device->audio);
      }
      if (status == ITERATE_KIT_OK) {
        device->conversation_active = false;
      }
      return status;
    }
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

static void observe_event(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  struct iterate_kit_m5sticks3 *device = context;
  enum iterate_kit_status stream_status;
  if (device == NULL || event == NULL) {
    return;
  }
  /*
   * Audio state has already changed when this observer runs. A saturated
   * control subscriber must therefore never roll back capture or delay the
   * button owner; the stream keeps the newest state and exposes the sequence
   * gap. The optional platform observer remains a diagnostic mirror of the
   * original local result, not a second behavior path.
   */
  stream_status = iterate_kit_device_event_stream_observe(
      &device->event_stream, event, result);
  (void)stream_status;
  if (device->event_observer.observe != NULL) {
    device->event_observer.observe(
        device->event_observer.context, event, result);
  }
}

enum capnweb_status iterate_kit_m5sticks3_init(
    struct iterate_kit_m5sticks3 *device,
    const struct iterate_kit_m5sticks3_options *options) {
  struct iterate_kit_peer_options peer_options;
  struct iterate_kit_device_event_queue_options event_options;
  struct iterate_kit_metrics_options metrics_options;
  struct iterate_kit_device_event_stream_options
      event_stream_options;
  if (device == NULL || options == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(device, 0, sizeof(*device));
  if (iterate_kit_callback_budget_init(
          &device->callback_budget,
          options->maximum_in_flight_callbacks) !=
      ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  metrics_options = options->metrics;
  metrics_options.callback_budget = &device->callback_budget;
  event_stream_options = options->event_stream;
  event_stream_options.callback_budget =
      &device->callback_budget;
  event_stream_options.audio_mode =
      iterate_kit_m5sticks3_manifest.audio_mode;
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
      iterate_kit_avatar_init(
          &device->avatar,
          &options->avatar,
          options->avatar_slug_scratch,
          options->avatar_slug_scratch_size) != ITERATE_KIT_OK ||
      iterate_kit_screen_capture_init(
          &device->screen_capture,
          &options->screen_capture,
          options->maximum_screen_capture_bytes) != ITERATE_KIT_OK ||
      iterate_kit_metrics_init(
          &device->metrics, &metrics_options) != ITERATE_KIT_OK ||
      iterate_kit_audio_controller_init(
          &device->audio, &options->audio) != ITERATE_KIT_OK ||
      iterate_kit_device_event_stream_init(
          &device->event_stream,
          &event_stream_options) != ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  device->event_observer = options->event_observer;
  event_options = (struct iterate_kit_device_event_queue_options){
    .storage = options->event_storage,
    .capacity = options->event_capacity,
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
      iterate_kit_push_to_talk_init(
          &device->push_to_talk, &device->events) != ITERATE_KIT_OK ||
      iterate_kit_logical_input_init(
          &device->logical_input,
          &options->logical_input) != ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  /*
   * Event state is latency-sensitive control for the PCM lane, whereas
   * metrics are latest-state observations. Poll events first so a button edge
   * claims a shared callback slot before a due metrics fanout; metrics use any
   * remaining slot or skip to a later sample without building history.
   */
  device->modules[0] =
      iterate_kit_device_event_stream_module(
          &device->event_stream);
  device->modules[1] = iterate_kit_metrics_module(&device->metrics);
  device->modules[2] = iterate_kit_screen_module(&device->screen);
  device->modules[3] = iterate_kit_avatar_module(&device->avatar);
  device->modules[4] =
      iterate_kit_screen_capture_module(&device->screen_capture);
  device->modules[5] =
      iterate_kit_conversation_module(&device->conversation);
  device->modules[6] =
      iterate_kit_push_to_talk_module(&device->push_to_talk);
  device->modules[7] = iterate_kit_audio_module(&device->audio);
  device->modules[8] =
      iterate_kit_logical_input_module(&device->logical_input);
  /*
   * A flat module table is sufficient: modules themselves publish the desired
   * method paths (for example conversation.start). Building a heap capability
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

enum iterate_kit_status iterate_kit_m5sticks3_publish_conversation(
    struct iterate_kit_m5sticks3 *device,
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

bool iterate_kit_m5sticks3_is_conversation_active(
    const struct iterate_kit_m5sticks3 *device) {
  return device != NULL && device->conversation_active;
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

enum iterate_kit_status iterate_kit_m5sticks3_set_media_ready(
    struct iterate_kit_m5sticks3 *device, bool ready) {
  if (device == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return iterate_kit_audio_set_media_ready(&device->audio, ready);
}

void iterate_kit_m5sticks3_event_metrics(
    const struct iterate_kit_m5sticks3 *device,
    struct iterate_kit_device_event_queue_metrics *metrics) {
  iterate_kit_device_event_queue_metrics(
      device == NULL ? NULL : &device->events, metrics);
}
