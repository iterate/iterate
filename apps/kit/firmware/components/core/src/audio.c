#include "iterate/kit/audio.h"

#include <string.h>

/*
 * This controller is intentionally policy, not a codec or hardware driver. It
 * gives push-to-talk and future full-duplex/AEC devices one common lifecycle
 * while leaving microphone DMA, speaker DMA, echo reference routing, and frame
 * storage at the device/platform edge.
 *
 * The central ownership invariant is that at most one capture buffer is
 * borrowed by egress. The controller therefore refuses another capture until
 * the exactly-once completion callback returns ownership. A queue here looked
 * convenient, but it would duplicate the bounded PCM lane, consume RAM, and
 * preserve speech precisely when a stalled network requires us to discard it.
 *
 * Push-to-talk is an interruption boundary, not merely a microphone toggle.
 * Speaker DMA must stop and release every borrowed playback frame before the
 * microphone opens; otherwise the device records its own stale response and
 * the button feels delayed. Full-duplex devices deliberately keep capture
 * running so their platform AEC receives a continuous microphone/reference
 * timeline. Capability-event delivery is best-effort observability and never
 * controls hardware state: a congested Cap'n Web socket must not leave a mic
 * or speaker active.
 *
 * One owner task calls every mutating operation and poll. The controller does
 * not allocate, block, copy PCM, or make its metric fields cross-task safe; a
 * platform that exports them from another task must snapshot under its own
 * ownership boundary.
 */

static enum iterate_kit_status remember(
    struct iterate_kit_audio_controller *controller,
    enum iterate_kit_status status) {
  controller->last_status = status;
  return status;
}

static bool valid_options(const struct iterate_kit_audio_options *options) {
  if (options == NULL ||
      (options->mode != ITERATE_KIT_AUDIO_PUSH_TO_TALK &&
       options->mode != ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC)) {
    return false;
  }
  return options->hardware.start_capture != NULL &&
      options->hardware.stop_capture != NULL &&
      options->hardware.stop_playback != NULL &&
      options->hardware.flush_playback != NULL &&
      options->hardware.prepare_playback != NULL &&
      options->egress.send_event != NULL &&
      options->egress.send_pcm != NULL &&
      options->capture.poll != NULL;
}

static void send_event(
    struct iterate_kit_audio_controller *controller,
    enum iterate_kit_audio_event event) {
  const enum iterate_kit_status status =
      controller->options.egress.send_event(
          controller->options.egress.context, event);
  if (status != ITERATE_KIT_OK) {
    controller->metrics.event_send_failures++;
  }
}

static void capture_send_complete(
    void *context, enum iterate_kit_status status) {
  struct iterate_kit_audio_controller *controller = context;
  /*
   * A duplicate/late callback means the egress implementation violated the
   * borrowed-buffer protocol. Silently accepting it would let a later frame's
   * completion release the wrong ownership epoch, so latch a visible local
   * state error even though there is no buffer here to free.
   */
  if (controller == NULL ||
      !controller->initialized ||
      !controller->capture_frame_in_flight) {
    if (controller != NULL) {
      controller->metrics.completion_protocol_errors++;
      controller->last_status = ITERATE_KIT_STATE_ERROR;
    }
    return;
  }

  controller->capture_frame_in_flight = false;
  controller->last_status = status;
  if (status == ITERATE_KIT_OK) {
    controller->metrics.capture_frames_sent++;
  } else {
    controller->metrics.capture_send_failures++;
  }
}

static enum iterate_kit_status start_capture(
    struct iterate_kit_audio_controller *controller) {
  enum iterate_kit_status status;
  if (controller->capture_active) {
    return remember(controller, ITERATE_KIT_OK);
  }
  status = controller->options.hardware.start_capture(
      controller->options.hardware.context);
  if (status != ITERATE_KIT_OK) {
    return remember(controller, status);
  }
  controller->capture_active = true;
  send_event(controller, ITERATE_KIT_AUDIO_CAPTURE_STARTED);
  return remember(controller, ITERATE_KIT_OK);
}

static enum iterate_kit_status stop_capture(
    struct iterate_kit_audio_controller *controller) {
  enum iterate_kit_status status;
  if (!controller->capture_active) {
    return remember(controller, ITERATE_KIT_OK);
  }
  status = controller->options.hardware.stop_capture(
      controller->options.hardware.context);
  if (status != ITERATE_KIT_OK) {
    return remember(controller, status);
  }
  controller->capture_active = false;
  send_event(controller, ITERATE_KIT_AUDIO_CAPTURE_ENDED);
  return remember(controller, ITERATE_KIT_OK);
}

static enum iterate_kit_status submit_polled_capture(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz) {
  return iterate_kit_audio_submit_capture(
      context, samples, sample_count, sample_rate_hz);
}

static struct iterate_kit_poll_result audio_poll(
    void *context, uint64_t now_ms) {
  struct iterate_kit_audio_controller *controller = context;
  enum iterate_kit_status capture_status;
  struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
  (void)now_ms;
  if (controller == NULL || !controller->initialized) {
    result.status = ITERATE_KIT_POLL_DRIVER_ERROR;
    return result;
  }
  if (!controller->capture_active ||
      controller->capture_frame_in_flight) {
    return result;
  }
  capture_status = controller->options.capture.poll(
      controller->options.capture.context,
      submit_polled_capture,
      controller);
  /*
   * A full or disconnected realtime egress deliberately rejects the current
   * frame with BACKPRESSURE. The capture adapter releases that completed
   * hardware buffer instead of retaining it, and submit_capture() accounts the
   * loss. Upgrading this expected freshness policy to POLL_DRIVER_ERROR made a
   * network outage look like microphone corruption and encouraged callers to
   * retry or log every 20 ms. Actual recorder and ownership failures remain
   * driver errors.
   */
  if (capture_status != ITERATE_KIT_OK &&
      capture_status != ITERATE_KIT_BACKPRESSURE) {
    result.status = ITERATE_KIT_POLL_DRIVER_ERROR;
  }
  return result;
}

static struct iterate_kit_poll_result audio_close(void *context) {
  struct iterate_kit_audio_controller *controller = context;
  struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
  enum iterate_kit_status status;
  if (controller == NULL || !controller->initialized) {
    result.status = ITERATE_KIT_POLL_DRIVER_ERROR;
    return result;
  }

  status = stop_capture(controller);
  if (status == ITERATE_KIT_OK) {
    controller->push_to_talk_active = false;
  } else {
    result.status = ITERATE_KIT_POLL_DRIVER_ERROR;
  }
  status = iterate_kit_audio_interrupt_playback(controller);
  if (status != ITERATE_KIT_OK) {
    result.status = ITERATE_KIT_POLL_DRIVER_ERROR;
  }
  return result;
}

enum iterate_kit_status iterate_kit_audio_controller_init(
    struct iterate_kit_audio_controller *controller,
    const struct iterate_kit_audio_options *options) {
  if (controller == NULL || !valid_options(options)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(controller, 0, sizeof(*controller));
  controller->options = *options;
  controller->last_status = ITERATE_KIT_OK;
  controller->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_audio_start(
    struct iterate_kit_audio_controller *controller) {
  if (controller == NULL || !controller->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (controller->options.mode == ITERATE_KIT_AUDIO_PUSH_TO_TALK) {
    return remember(controller, ITERATE_KIT_OK);
  }
  return start_capture(controller);
}

enum iterate_kit_status iterate_kit_audio_note_playback_started(
    struct iterate_kit_audio_controller *controller) {
  if (controller == NULL || !controller->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (controller->options.mode == ITERATE_KIT_AUDIO_PUSH_TO_TALK &&
      controller->capture_active) {
    return remember(controller, ITERATE_KIT_STATE_ERROR);
  }
  if (controller->playback_flush_pending) {
    return remember(controller, ITERATE_KIT_STATE_ERROR);
  }
  controller->playback_active = true;
  return remember(controller, ITERATE_KIT_OK);
}

enum iterate_kit_status iterate_kit_audio_interrupt_playback(
    struct iterate_kit_audio_controller *controller) {
  enum iterate_kit_status status;
  bool notify_interruption;
  if (controller == NULL || !controller->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  notify_interruption =
      controller->playback_active ||
      controller->playback_flush_pending;

  if (controller->playback_active) {
    status = controller->options.hardware.stop_playback(
        controller->options.hardware.context);
    if (status != ITERATE_KIT_OK) {
      return remember(controller, status);
    }
    controller->playback_active = false;
    controller->playback_flush_pending = true;
  }

  /*
   * Always invoke the hardware flush. Downlink PCM can be queued before the
   * first frame reaches the speaker, so playback_active alone cannot prove
   * that there is nothing stale to discard before capture starts.
   */
  controller->playback_flush_pending = true;
  status = controller->options.hardware.flush_playback(
      controller->options.hardware.context);
  if (status != ITERATE_KIT_OK) {
    return remember(controller, status);
  }
  controller->playback_flush_pending = false;
  if (notify_interruption) {
    send_event(controller, ITERATE_KIT_AUDIO_INTERRUPTION);
  }
  return remember(controller, ITERATE_KIT_OK);
}

enum iterate_kit_status iterate_kit_audio_prepare_playback(
    struct iterate_kit_audio_controller *controller) {
  enum iterate_kit_status status;
  if (controller == NULL || !controller->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  /*
   * In the push-to-talk profile, capture and speaker ownership are mutually
   * exclusive. Refusing an early prepare is safer than allowing a call-state
   * transition to steal I2S pins from an active microphone. The device event
   * owner serializes normal use, so this branch represents a real lifecycle
   * defect rather than a retryable race.
   */
  if (controller->options.mode == ITERATE_KIT_AUDIO_PUSH_TO_TALK &&
      (controller->capture_active || controller->push_to_talk_active)) {
    return remember(controller, ITERATE_KIT_STATE_ERROR);
  }
  if (controller->playback_flush_pending) {
    return remember(controller, ITERATE_KIT_STATE_ERROR);
  }
  status = controller->options.hardware.prepare_playback(
      controller->options.hardware.context);
  return remember(controller, status);
}

enum iterate_kit_status iterate_kit_audio_push_to_talk(
    struct iterate_kit_audio_controller *controller, bool pressed) {
  enum iterate_kit_status status;
  if (controller == NULL || !controller->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (controller->options.mode != ITERATE_KIT_AUDIO_PUSH_TO_TALK) {
    return remember(controller, ITERATE_KIT_STATE_ERROR);
  }
  if (pressed == controller->push_to_talk_active) {
    return remember(controller, ITERATE_KIT_OK);
  }

  if (pressed) {
    status = iterate_kit_audio_interrupt_playback(controller);
    if (status != ITERATE_KIT_OK) {
      return status;
    }
    status = start_capture(controller);
    if (status != ITERATE_KIT_OK) {
      return status;
    }
    controller->push_to_talk_active = true;
    return remember(controller, ITERATE_KIT_OK);
  }

  status = stop_capture(controller);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  controller->push_to_talk_active = false;
  return remember(controller, ITERATE_KIT_OK);
}

enum iterate_kit_status iterate_kit_audio_submit_capture(
    struct iterate_kit_audio_controller *controller,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz) {
  enum iterate_kit_status status;
  bool completed_synchronously;
  if (controller == NULL ||
      !controller->initialized ||
      samples == NULL ||
      sample_count == 0U ||
      sample_rate_hz == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!controller->capture_active) {
    return remember(controller, ITERATE_KIT_STATE_ERROR);
  }
  if (controller->capture_frame_in_flight) {
    controller->metrics.capture_frames_dropped++;
    return remember(controller, ITERATE_KIT_BACKPRESSURE);
  }

  controller->capture_frame_in_flight = true;
  status = controller->options.egress.send_pcm(
      controller->options.egress.context,
      samples,
      sample_count,
      sample_rate_hz,
      capture_send_complete,
      controller);
  completed_synchronously = !controller->capture_frame_in_flight;
  if (status == ITERATE_KIT_OK) {
    return remember(controller, ITERATE_KIT_OK);
  }

  if (completed_synchronously) {
    controller->metrics.completion_protocol_errors++;
  } else {
    controller->capture_frame_in_flight = false;
  }
  if (status == ITERATE_KIT_BACKPRESSURE) {
    controller->metrics.capture_frames_dropped++;
  } else {
    controller->metrics.capture_send_failures++;
  }
  return remember(controller, status);
}

struct iterate_kit_module iterate_kit_audio_module(
    struct iterate_kit_audio_controller *controller) {
  const struct iterate_kit_module module = {
    .methods = NULL,
    .method_count = 0U,
    .context = controller,
    .poll = audio_poll,
    .close = audio_close,
    .session_ended = NULL,
  };
  return module;
}
