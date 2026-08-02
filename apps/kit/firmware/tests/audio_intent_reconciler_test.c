#include "iterate/kit/audio_intent_reconciler.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) return;
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

struct fake_owner {
  enum iterate_kit_status results[4];
  bool requested[4];
  size_t result_count;
  size_t request_count;
  size_t reset_count;
};

static enum iterate_kit_status request_uplink(
    void *context, bool active) {
  struct fake_owner *owner = context;
  enum iterate_kit_status result = ITERATE_KIT_OK;
  assert(owner->request_count < 4U);
  owner->requested[owner->request_count] = active;
  if (owner->request_count < owner->result_count) {
    result = owner->results[owner->request_count];
  }
  ++owner->request_count;
  return result;
}

static void reset_playback(void *context) {
  struct fake_owner *owner = context;
  ++owner->reset_count;
}

static void initialize(
    struct iterate_kit_audio_intent_reconciler *reconciler,
    struct fake_owner *owner,
    enum iterate_kit_audio_mode mode,
    bool media_ready) {
  const struct iterate_kit_audio_intent_ops ops = {
    owner,
    request_uplink,
    reset_playback,
  };
  memset(owner, 0, sizeof(*owner));
  assert(
      iterate_kit_audio_intent_reconciler_init(reconciler, mode, &ops) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_audio_intent_reconciler_set_media_ready(
          reconciler, media_ready) == ITERATE_KIT_OK);
}

static void handle(
    struct iterate_kit_audio_intent_reconciler *reconciler,
    enum iterate_kit_device_event_type type) {
  const struct iterate_kit_device_event event = {
    (uint8_t)type,
    (uint8_t)ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE,
  };
  assert(
      iterate_kit_audio_intent_reconciler_handle(reconciler, &event) ==
      ITERATE_KIT_OK);
}

/*
 * A control burst can contain press and release before the audio task gets a
 * scheduling edge. Sending both commands would create a pointless mic pulse;
 * retaining only the final boolean is both smaller and closer to user intent.
 */
static void a_short_turn_coalesces_to_the_safe_final_state(void) {
  struct iterate_kit_audio_intent_reconciler reconciler;
  struct fake_owner owner;
  initialize(
      &reconciler, &owner, ITERATE_KIT_AUDIO_PUSH_TO_TALK, true);

  handle(&reconciler, ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED);
  handle(&reconciler, ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED);
  assert(owner.reset_count == 1U);
  assert(owner.request_count == 0U);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 0U);
}

/*
 * The lower mailbox documents BACKPRESSURE as "not accepted". A release must
 * therefore remain pending rather than relying on the already-consumed device
 * event to recur; otherwise a long conversation can leave mic publication on.
 */
static void a_backpressured_stop_is_retried_until_accepted(void) {
  struct iterate_kit_audio_intent_reconciler reconciler;
  struct iterate_kit_audio_intent_metrics metrics;
  struct fake_owner owner;
  initialize(
      &reconciler, &owner, ITERATE_KIT_AUDIO_PUSH_TO_TALK, true);
  owner.results[0] = ITERATE_KIT_OK;
  owner.results[1] = ITERATE_KIT_BACKPRESSURE;
  owner.results[2] = ITERATE_KIT_OK;
  owner.result_count = 3U;

  handle(&reconciler, ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  handle(&reconciler, ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED);
  assert(
      iterate_kit_audio_intent_reconciler_poll(&reconciler) ==
      ITERATE_KIT_BACKPRESSURE);
  assert(
      iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 3U);
  assert(owner.requested[0]);
  assert(!owner.requested[1]);
  assert(!owner.requested[2]);
  assert(owner.reset_count == 2U);

  iterate_kit_audio_intent_reconciler_metrics(&reconciler, &metrics);
  assert(metrics.commands_accepted == 2U);
  assert(metrics.command_backpressure == 1U);
  assert(!metrics.command_pending);
  assert(!metrics.desired_uplink_active);
}

/*
 * Retrying an invariant/hardware failure forever would produce an invisible
 * busy loop and error storm. Only explicit mailbox pressure is retryable; the
 * first different error becomes a sticky diagnostic and rejects later starts.
 */
static void terminal_owner_failure_is_not_an_unbounded_retry_loop(void) {
  struct iterate_kit_audio_intent_reconciler reconciler;
  struct fake_owner owner;
  struct iterate_kit_device_event start = {
    (uint8_t)ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED,
    (uint8_t)ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE,
  };
  initialize(
      &reconciler, &owner, ITERATE_KIT_AUDIO_PUSH_TO_TALK, true);
  owner.results[0] = ITERATE_KIT_IO_ERROR;
  owner.result_count = 1U;

  handle(&reconciler, ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED);
  assert(
      iterate_kit_audio_intent_reconciler_poll(&reconciler) ==
      ITERATE_KIT_IO_ERROR);
  assert(
      iterate_kit_audio_intent_reconciler_poll(&reconciler) ==
      ITERATE_KIT_IO_ERROR);
  assert(owner.request_count == 1U);
  assert(
      iterate_kit_audio_intent_reconciler_handle(&reconciler, &start) ==
      ITERATE_KIT_IO_ERROR);
}

/*
 * StackChan and HAVPE keep local AEC running and give Grok's server VAD one
 * continuous microphone sequence for the lifetime of a conversation. If the
 * reconciler remained implicitly PTT-shaped, conversation start would leave
 * the publication gate closed forever; if it accepted a stray PTT event, it
 * could also inject a false provider boundary. The audio mode must therefore
 * select the policy once, while both modes continue to share one bounded
 * lower-owner command path and one destructive hang-up reset.
 */
static void full_duplex_conversation_controls_one_continuous_publication(void) {
  struct iterate_kit_audio_intent_reconciler reconciler;
  struct iterate_kit_audio_intent_metrics metrics;
  struct fake_owner owner;
  const struct iterate_kit_device_event stray_ptt = {
    (uint8_t)ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED,
    (uint8_t)ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE,
  };
  initialize(
      &reconciler, &owner, ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC, true);

  handle(&reconciler, ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED);
  assert(owner.reset_count == 0U);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 1U);
  assert(owner.requested[0]);

  assert(
      iterate_kit_audio_intent_reconciler_handle(
          &reconciler, &stray_ptt) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(owner.reset_count == 0U);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 1U);

  handle(&reconciler, ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED);
  assert(owner.reset_count == 1U);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 2U);
  assert(!owner.requested[1]);

  iterate_kit_audio_intent_reconciler_metrics(&reconciler, &metrics);
  assert(metrics.intent_edges == 2U);
  assert(metrics.commands_accepted == 2U);
  assert(metrics.playback_resets == 1U);
  assert(!metrics.desired_uplink_active);
}

/*
 * A conversation event arrives over Cap'n Web before the independent `/pcm`
 * WebSocket has completed DNS/TCP/TLS/upgrade. Publishing clean mic frames in
 * that gap caused the first frame of every physical HAVPE run to enter a lane
 * with no consumer and be reported as an uplink drop. Treating that as a
 * harmless baseline adjustment would hide a real ordering defect.
 *
 * The reconciler must instead drive the lower owner from the conjunction of
 * user intent and current media readiness. Losing readiness closes the gate
 * immediately; restoring it reopens at current audio, with no retained PCM or
 * synthetic turn boundary. This test is shared by StackChan and HAVPE because
 * the policy is independent of their codecs and AEC implementations.
 */
static void full_duplex_publication_tracks_media_readiness(void) {
  struct iterate_kit_audio_intent_reconciler reconciler;
  struct iterate_kit_audio_intent_metrics metrics;
  struct fake_owner owner;
  initialize(
      &reconciler, &owner, ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC, false);

  handle(&reconciler, ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 0U);

  assert(
      iterate_kit_audio_intent_reconciler_set_media_ready(
          &reconciler, true) == ITERATE_KIT_OK);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 1U);
  assert(owner.requested[0]);

  assert(
      iterate_kit_audio_intent_reconciler_set_media_ready(
          &reconciler, false) == ITERATE_KIT_OK);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 2U);
  assert(!owner.requested[1]);

  assert(
      iterate_kit_audio_intent_reconciler_set_media_ready(
          &reconciler, true) == ITERATE_KIT_OK);
  assert(iterate_kit_audio_intent_reconciler_poll(&reconciler) == ITERATE_KIT_OK);
  assert(owner.request_count == 3U);
  assert(owner.requested[2]);

  iterate_kit_audio_intent_reconciler_metrics(&reconciler, &metrics);
  assert(metrics.media_ready);
  assert(metrics.media_readiness_edges == 3U);
  assert(metrics.commands_accepted == 3U);
  assert(metrics.desired_uplink_active);
}

int main(void) {
  a_short_turn_coalesces_to_the_safe_final_state();
  a_backpressured_stop_is_retried_until_accepted();
  terminal_owner_failure_is_not_an_unbounded_retry_loop();
  full_duplex_conversation_controls_one_continuous_publication();
  full_duplex_publication_tracks_media_readiness();
  return 0;
}
