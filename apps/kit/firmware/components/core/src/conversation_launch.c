#include "iterate/kit/conversation_launch.h"

#include <stddef.h>

enum iterate_kit_launch_step iterate_kit_launch_next_step(
    struct iterate_kit_launch *launch,
    const struct iterate_kit_launch_inputs *inputs) {
  if (launch == NULL || inputs == NULL) return ITERATE_KIT_LAUNCH_NOTHING;
  /*
   * Nothing is attempted without room to send it. A request built and dropped
   * costs the same wait as one that was never made, and looks like a device
   * ignoring a button.
   */
  if (!inputs->link_ready) return ITERATE_KIT_LAUNCH_NOTHING;
  /* Something is already happening; a second attempt would race it. */
  if (inputs->call_active || inputs->call_pending || inputs->preparing) {
    return ITERATE_KIT_LAUNCH_NOTHING;
  }

  if (!inputs->wants_call) {
    /* Already holding a fresh stream: the whole point of preparing ahead. */
    if (!inputs->stream_used) return ITERATE_KIT_LAUNCH_NOTHING;
    if (inputs->now_ms < launch->next_prepare_ahead_ms) {
      return ITERATE_KIT_LAUNCH_NOTHING;
    }
    /* Bounded: see ITERATE_KIT_LAUNCH_PREPARE_AHEAD_LIMIT. A prepare nobody is
     * waiting on must not become a stream minted every thirty seconds. */
    if (launch->prepares_without_call >= ITERATE_KIT_LAUNCH_PREPARE_AHEAD_LIMIT) {
      return ITERATE_KIT_LAUNCH_NOTHING;
    }
    launch->prepares_without_call++;
    launch->next_prepare_ahead_ms =
        inputs->now_ms + ITERATE_KIT_LAUNCH_PREPARE_AHEAD_RETRY_MS;
    return ITERATE_KIT_LAUNCH_PREPARE_AHEAD;
  }

  /*
   * SOMEBODY IS WAITING FROM HERE DOWN, and neither branch reads
   * `next_prepare_ahead_ms`. That single line is the eighteen seconds.
   */
  if (inputs->stream_used) {
    if (inputs->now_ms < launch->next_prepare_ms) {
      return ITERATE_KIT_LAUNCH_NOTHING;
    }
    launch->next_prepare_ms =
        inputs->now_ms + ITERATE_KIT_LAUNCH_PREPARE_RETRY_MS;
    return ITERATE_KIT_LAUNCH_PREPARE_NOW;
  }
  if (inputs->now_ms < launch->next_place_ms) return ITERATE_KIT_LAUNCH_NOTHING;
  launch->next_place_ms = inputs->now_ms + ITERATE_KIT_LAUNCH_PLACE_RETRY_MS;
  /* Preparing ahead did its job: the count starts again from here. */
  launch->prepares_without_call = 0U;
  return ITERATE_KIT_LAUNCH_PLACE_CALL;
}

void iterate_kit_launch_retry_now(struct iterate_kit_launch *launch) {
  if (launch == NULL) return;
  launch->next_prepare_ahead_ms = 0U;
  launch->next_prepare_ms = 0U;
  launch->next_place_ms = 0U;
  launch->prepares_without_call = 0U;
}
