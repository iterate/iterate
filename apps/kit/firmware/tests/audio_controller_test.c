#include "iterate/kit/audio.h"
#include "iterate/kit/peer.h"

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

struct fake_audio {
  char operations[32];
  size_t operation_count;
  size_t send_count;
  enum iterate_kit_audio_event event_to_fail;
  bool fail_event_once;
  bool fail_flush_once;
  size_t capture_poll_count;
  int16_t captured_frame[320];
  const int16_t *borrowed_samples;
  size_t borrowed_sample_count;
  iterate_kit_audio_send_complete_fn complete;
  void *complete_context;
  enum iterate_kit_status send_status;
};

static void record_operation(struct fake_audio *audio, char operation) {
  assert(audio->operation_count < sizeof(audio->operations));
  audio->operations[audio->operation_count++] = operation;
}

static enum iterate_kit_status start_capture(void *context) {
  record_operation(context, 'C');
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status stop_capture(void *context) {
  record_operation(context, 'X');
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status stop_playback(void *context) {
  record_operation(context, 'S');
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status flush_playback(void *context) {
  struct fake_audio *audio = context;
  record_operation(audio, 'F');
  if (audio->fail_flush_once) {
    audio->fail_flush_once = false;
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status send_event(
    void *context, enum iterate_kit_audio_event event) {
  struct fake_audio *audio = context;
  switch (event) {
    case ITERATE_KIT_AUDIO_INTERRUPTION:
      record_operation(audio, 'I');
      break;
    case ITERATE_KIT_AUDIO_CAPTURE_STARTED:
      record_operation(audio, 'B');
      break;
    case ITERATE_KIT_AUDIO_CAPTURE_ENDED:
      record_operation(audio, 'E');
      break;
  }
  if (audio->fail_event_once && audio->event_to_fail == event) {
    audio->fail_event_once = false;
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status send_pcm(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    iterate_kit_audio_send_complete_fn complete,
    void *complete_context) {
  struct fake_audio *audio = context;
  assert(sample_rate_hz == 16000U);
  assert(audio->complete == NULL);
  audio->send_count++;
  if (audio->send_status != ITERATE_KIT_OK) {
    /*
     * A rejected frame was never borrowed. Retaining its completion callback
     * in this fake would model an impossible egress contract and hide whether
     * the controller is free to poll the next current hardware frame.
     */
    return audio->send_status;
  }
  audio->borrowed_samples = samples;
  audio->borrowed_sample_count = sample_count;
  audio->complete = complete;
  audio->complete_context = complete_context;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status poll_capture(
    void *context,
    iterate_kit_audio_capture_submit_fn submit,
    void *submit_context) {
  struct fake_audio *audio = context;
  audio->capture_poll_count++;
  return submit(
      submit_context,
      audio->captured_frame,
      sizeof(audio->captured_frame) /
          sizeof(audio->captured_frame[0]),
      16000U);
}

static void complete_send(
    struct fake_audio *audio, enum iterate_kit_status status) {
  iterate_kit_audio_send_complete_fn complete = audio->complete;
  void *context = audio->complete_context;
  assert(complete != NULL);
  audio->complete = NULL;
  audio->complete_context = NULL;
  audio->borrowed_samples = NULL;
  audio->borrowed_sample_count = 0U;
  complete(context, status);
}

static struct iterate_kit_audio_options options(
    struct fake_audio *audio, enum iterate_kit_audio_mode mode) {
  const struct iterate_kit_audio_hardware hardware = {
    audio,
    start_capture,
    stop_capture,
    stop_playback,
    flush_playback,
  };
  const struct iterate_kit_audio_egress egress = {
    audio,
    send_event,
    send_pcm,
  };
  const struct iterate_kit_audio_options result = {
    .mode = mode,
    .hardware = hardware,
    .egress = egress,
    .capture = {
      audio,
      poll_capture,
    },
  };
  return result;
}

/*
 * On the button-driven stick, pressing PTT must make speech current immediately:
 * queued speaker audio is stopped and flushed before the microphone starts, and
 * a slow egress must not turn a long button hold into delayed speech. It would
 * be tempting to queue every captured frame for lossless delivery, but that
 * makes recovered connectivity replay stale conversation. This pins the
 * half-duplex transition order and the one-borrowed-frame backpressure bound.
 */
static void ptt_is_half_duplex_and_never_queues_mic_frames(void) {
  struct fake_audio audio = {0};
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_PUSH_TO_TALK);
  int16_t first_frame[320] = {0};
  int16_t later_frame[320] = {0};

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_note_playback_started(&controller) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);
  assert(audio.operation_count == 5U);
  assert(memcmp(audio.operations, "SFICB", 5U) == 0);

  assert(
      iterate_kit_audio_submit_capture(
          &controller, first_frame, 320U, 16000U) ==
      ITERATE_KIT_OK);
  assert(audio.send_count == 1U);
  assert(audio.borrowed_samples == first_frame);
  assert(audio.borrowed_sample_count == 320U);

  for (size_t attempt = 0U; attempt < 100U; ++attempt) {
    assert(
        iterate_kit_audio_submit_capture(
            &controller, later_frame, 320U, 16000U) ==
        ITERATE_KIT_BACKPRESSURE);
  }
  assert(audio.send_count == 1U);
  assert(audio.borrowed_samples == first_frame);
  assert(controller.metrics.capture_frames_dropped == 100U);
  assert(controller.metrics.capture_frames_sent == 0U);

  complete_send(&audio, ITERATE_KIT_OK);
  assert(controller.metrics.capture_frames_sent == 1U);
  assert(
      iterate_kit_audio_submit_capture(
          &controller, later_frame, 320U, 16000U) ==
      ITERATE_KIT_OK);
  assert(audio.send_count == 2U);
  complete_send(&audio, ITERATE_KIT_OK);

  assert(
      iterate_kit_audio_push_to_talk(&controller, false) ==
      ITERATE_KIT_OK);
  assert(audio.operation_count == 7U);
  assert(memcmp(audio.operations, "SFICBXE", 7U) == 0);
  assert(!controller.capture_active);
  assert(!controller.push_to_talk_active);
}

/*
 * A future AEC-capable device must hear the user while speaker audio is active
 * so an interruption can be detected without a physical button. Reusing the
 * half-duplex PTT shutdown sequence here would stop capture precisely when AEC
 * needs its microphone/reference relationship. This scenario protects the
 * mode boundary: interruption stops and flushes playback but leaves capture
 * continuously active.
 */
static void full_duplex_aec_keeps_capture_running_during_interruption(void) {
  struct fake_audio audio = {0};
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC);

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(iterate_kit_audio_start(&controller) == ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_note_playback_started(&controller) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_interrupt_playback(&controller) ==
      ITERATE_KIT_OK);

  assert(audio.operation_count == 5U);
  assert(memcmp(audio.operations, "CBSFI", 5U) == 0);
  assert(controller.capture_active);
  assert(!controller.playback_active);
}

/*
 * Lifecycle events are diagnostics/control-plane information, whereas the
 * hardware microphone is a privacy- and power-sensitive realtime resource. A
 * transient event-send failure must therefore be observable without making
 * controller state diverge from the already-started hardware. Rolling back
 * only the logical state would leave an untracked hot microphone; this proves
 * release still closes capture cleanly after the failed notification.
 */
static void capture_started_event_failure_cannot_leave_mic_hot(void) {
  struct fake_audio audio = {
    .event_to_fail = ITERATE_KIT_AUDIO_CAPTURE_STARTED,
    .fail_event_once = true,
  };
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_PUSH_TO_TALK);

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);
  assert(controller.capture_active);
  assert(controller.push_to_talk_active);
  assert(controller.metrics.event_send_failures == 1U);

  assert(
      iterate_kit_audio_push_to_talk(&controller, false) ==
      ITERATE_KIT_OK);
  assert(!controller.capture_active);
  assert(!controller.push_to_talk_active);
  assert(controller.metrics.event_send_failures == 1U);
  assert(audio.operation_count == 5U);
  assert(memcmp(audio.operations, "FCBXE", 5U) == 0);
}

/*
 * Wi-Fi can fail exactly as a user releases PTT. Treating a failed
 * capture-ended notification as an incomplete state transition would wedge the
 * next press even though the microphone has stopped. The hardware transition
 * remains authoritative and the event failure remains diagnostic, so this test
 * proves the controller can begin a fresh capture epoch immediately.
 */
static void capture_ended_event_failure_cannot_block_next_press(void) {
  struct fake_audio audio = {0};
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_PUSH_TO_TALK);

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);
  audio.event_to_fail = ITERATE_KIT_AUDIO_CAPTURE_ENDED;
  audio.fail_event_once = true;
  assert(
      iterate_kit_audio_push_to_talk(&controller, false) ==
      ITERATE_KIT_OK);
  assert(!controller.capture_active);
  assert(!controller.push_to_talk_active);
  assert(controller.metrics.event_send_failures == 1U);

  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);
  assert(controller.capture_active);
  assert(controller.push_to_talk_active);
  assert(audio.operation_count == 8U);
  assert(memcmp(audio.operations, "FCBXEFCB", 8U) == 0);
}

/*
 * Starting PTT while old assistant audio remains in the speaker queue creates
 * acoustic feedback and makes interruption semantics dishonest. Continuing
 * after a failed flush is tempting because capture startup is latency
 * sensitive, but it can mix two conversational epochs. This test requires a
 * bounded failure followed by a real retry, and forbids capture until the
 * speaker has actually accepted the flush.
 */
static void failed_playback_flush_is_retried_before_capture(void) {
  struct fake_audio audio = {
    .fail_flush_once = true,
  };
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_PUSH_TO_TALK);

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_note_playback_started(&controller) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_IO_ERROR);
  assert(!controller.capture_active);

  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);
  assert(controller.capture_active);
  assert(controller.push_to_talk_active);
  assert(audio.operation_count == 6U);
  assert(memcmp(audio.operations, "SFFICB", 6U) == 0);
}

/*
 * The downlink lane may contain audio even before the controller has observed
 * hardware playback start. Looking only at playback_active would skip the
 * flush and allow that latent audio to play underneath the user's first PTT
 * utterance. This scenario pins the stronger epoch invariant: every PTT start
 * flushes queued playback before opening capture, not only known-active audio.
 */
static void queued_playback_is_flushed_before_first_ptt_capture(void) {
  struct fake_audio audio = {0};
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_PUSH_TO_TALK);

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(!controller.playback_active);
  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);
  assert(audio.operation_count == 3U);
  assert(memcmp(audio.operations, "FCB", 3U) == 0);
  assert(controller.capture_active);
}

/*
 * Device teardown and reconnect happen through the generic module lifecycle,
 * even though physical PTT is not exposed as an RPC method. Omitting close
 * because the method table is empty would leave capture running across worker
 * replacement. This proves the module still advertises poll/close hooks and
 * that close ends the capture epoch and flushes residual playback state.
 */
static void methodless_audio_module_closes_active_capture(void) {
  struct fake_audio audio = {0};
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_PUSH_TO_TALK);

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);

  const struct iterate_kit_module module =
      iterate_kit_audio_module(&controller);
  assert(module.methods == NULL);
  assert(module.method_count == 0U);
  assert(module.poll != NULL);
  assert(module.close != NULL);
  const struct iterate_kit_poll_result close_result =
      module.close(module.context);
  assert(close_result.status == ITERATE_KIT_POLL_OK);
  assert(!controller.capture_active);
  assert(!controller.push_to_talk_active);
  assert(audio.operation_count == 6U);
  assert(memcmp(audio.operations, "FCBXEF", 6U) == 0);
}

/*
 * Recorder callbacks borrow sample storage until the asynchronous network send
 * completes. Polling the recorder again while that frame is in flight could
 * overwrite borrowed PCM or manufacture an implicit queue under backpressure.
 * A busy loop is especially plausible in the generic module scheduler; this
 * test proves repeated polls perform no capture work until ownership returns,
 * then resume immediately without counting the deliberate pause as loss.
 */
static void audio_module_poll_never_captures_a_second_in_flight_frame(void) {
  struct fake_audio audio = {0};
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_PUSH_TO_TALK);

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);
  const struct iterate_kit_module module =
      iterate_kit_audio_module(&controller);

  assert(module.poll(module.context, 0U).status == ITERATE_KIT_POLL_OK);
  assert(audio.capture_poll_count == 1U);
  assert(audio.send_count == 1U);
  assert(controller.capture_frame_in_flight);

  for (size_t attempt = 0U; attempt < 100U; ++attempt) {
    assert(
        module.poll(module.context, attempt + 1U).status ==
        ITERATE_KIT_POLL_OK);
  }
  assert(audio.capture_poll_count == 1U);
  assert(audio.send_count == 1U);
  assert(controller.metrics.capture_frames_dropped == 0U);

  complete_send(&audio, ITERATE_KIT_OK);
  assert(module.poll(module.context, 102U).status == ITERATE_KIT_POLL_OK);
  assert(audio.capture_poll_count == 2U);
  assert(audio.send_count == 2U);
}

/*
 * A PTT press can overlap DNS/TLS/WebSocket reconnect. Keeping those samples
 * in the application ring would replay stale speech after recovery; treating
 * each intentional rejection as a microphone driver failure would instead
 * create a 50 Hz error storm. The egress therefore returns BACKPRESSURE for
 * each current frame, which must remain a healthy bounded poll, count exact
 * loss, and leave no borrowed frame that could block subsequent capture.
 */
static void disconnected_egress_drops_current_frames_without_driver_failure(
    void) {
  struct fake_audio audio = {
    .send_status = ITERATE_KIT_BACKPRESSURE,
  };
  struct iterate_kit_audio_controller controller = {0};
  const struct iterate_kit_audio_options audio_options =
      options(&audio, ITERATE_KIT_AUDIO_PUSH_TO_TALK);
  const struct iterate_kit_module module =
      iterate_kit_audio_module(&controller);

  assert(
      iterate_kit_audio_controller_init(
          &controller,
          &audio_options) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);

  for (size_t frame = 0U; frame < 100U; ++frame) {
    assert(
        module.poll(module.context, frame).status ==
        ITERATE_KIT_POLL_OK);
  }
  assert(audio.capture_poll_count == 100U);
  assert(audio.send_count == 100U);
  assert(audio.complete == NULL);
  assert(!controller.capture_frame_in_flight);
  assert(controller.metrics.capture_frames_dropped == 100U);
  assert(controller.metrics.capture_send_failures == 0U);

  audio.send_status = ITERATE_KIT_OK;
  assert(module.poll(module.context, 101U).status == ITERATE_KIT_POLL_OK);
  assert(audio.capture_poll_count == 101U);
  assert(audio.send_count == 101U);
  assert(controller.capture_frame_in_flight);
  complete_send(&audio, ITERATE_KIT_OK);
  assert(controller.metrics.capture_frames_sent == 1U);
}

int main(void) {
  ptt_is_half_duplex_and_never_queues_mic_frames();
  full_duplex_aec_keeps_capture_running_during_interruption();
  capture_started_event_failure_cannot_leave_mic_hot();
  capture_ended_event_failure_cannot_block_next_press();
  failed_playback_flush_is_retried_before_capture();
  queued_playback_is_flushed_before_first_ptt_capture();
  methodless_audio_module_closes_active_capture();
  audio_module_poll_never_captures_a_second_in_flight_frame();
  disconnected_egress_drops_current_frames_without_driver_failure();
  return 0;
}
