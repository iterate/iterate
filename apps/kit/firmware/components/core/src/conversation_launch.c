#include "iterate/kit/conversation_launch.h"

#include <stddef.h>

enum iterate_kit_launch_step iterate_kit_launch_next_step(
    struct iterate_kit_launch *launch,
    const struct iterate_kit_launch_inputs *inputs) {
  if (launch == NULL || inputs == NULL) return ITERATE_KIT_LAUNCH_NOTHING;
  /* A live call settles this request. Quiet is not a failure condition. */
  if (inputs->call_active) {
    launch->awaiting_acceptance = false;
    launch->failed = false;
    launch->next_delivery_refresh_ms = 0U;
    launch->delivery_refreshes = 0U;
    return ITERATE_KIT_LAUNCH_NOTHING;
  }
  /* Ending the request abandons its budget without manufacturing a failure. */
  if (!inputs->wants_call) {
    launch->awaiting_acceptance = false;
    return ITERATE_KIT_LAUNCH_NOTHING;
  }
  /* A pending append cannot hide an exhausted acceptance deadline. */
  if (launch->awaiting_acceptance &&
      inputs->now_ms >= launch->first_place_ms &&
      inputs->now_ms - launch->first_place_ms >=
          ITERATE_KIT_LAUNCH_ACCEPTANCE_TIMEOUT_MS) {
    if (!launch->failed) {
      launch->failed = true;
      ++launch->failures;
      return ITERATE_KIT_LAUNCH_FAILED;
    }
    return ITERATE_KIT_LAUNCH_NOTHING;
  }
  if (launch->failed) return ITERATE_KIT_LAUNCH_NOTHING;
  /*
   * Nothing is attempted without room to send it. A request built and dropped
   * costs the same wait as one that was never made, and looks like a device
   * ignoring a button.
   */
  if (!inputs->link_ready) return ITERATE_KIT_LAUNCH_NOTHING;
  /* Only an unaccepted explicit launch makes callback silence actionable. */
  if (launch->awaiting_acceptance &&
      launch->delivery_refreshes < ITERATE_KIT_LAUNCH_MAX_DELIVERY_REFRESHES &&
      inputs->delivery_refresh_ready &&
      inputs->now_ms >= launch->next_delivery_refresh_ms) {
    ++launch->delivery_refreshes;
    launch->next_delivery_refresh_ms =
        inputs->now_ms + ITERATE_KIT_LAUNCH_DELIVERY_REFRESH_MS;
    return ITERATE_KIT_LAUNCH_DELIVERY_REFRESH;
  }
  /* Something is already happening; a second attempt would race it. */
  if (inputs->call_pending) {
    return ITERATE_KIT_LAUNCH_NOTHING;
  }

  /*
   * Somebody is waiting from here down.
   *
   * A DEADLINE FURTHER OUT THAN ONE INTERVAL IS NOT A DEADLINE, it is a clock
   * that moved. `next_place_ms` is only ever set to `now + PLACE_RETRY_MS`, so
   * a value more than that ahead of `now` cannot have been produced by this
   * function reading the same clock — it means `now` has gone backwards, or
   * was written from a different base. Left alone it never arrives, and the
   * device refuses every press for the rest of its life while every other
   * input reads healthy.
   *
   * Measured exactly that way: 2018 consecutive polls with the button held,
   * `wants_call` and `link_ready` both true as the seam itself saw them, no
   * call active or pending, and NOTHING returned every time.
   *
   * Treat it as stale and let the press through. The worst case is one extra
   * attempt; the alternative is a board that never calls again.
   */
  if (launch->next_place_ms > inputs->now_ms + ITERATE_KIT_LAUNCH_PLACE_RETRY_MS) {
    launch->next_place_ms = 0U;
  }
  if (inputs->now_ms < launch->next_place_ms) return ITERATE_KIT_LAUNCH_NOTHING;
  if (!launch->awaiting_acceptance) {
    launch->awaiting_acceptance = true;
    launch->first_place_ms = inputs->now_ms;
    launch->next_delivery_refresh_ms =
        inputs->now_ms + ITERATE_KIT_LAUNCH_DELIVERY_REFRESH_MS;
    launch->delivery_refreshes = 0U;
  }
  launch->next_place_ms = inputs->now_ms + ITERATE_KIT_LAUNCH_PLACE_RETRY_MS;
  return ITERATE_KIT_LAUNCH_PLACE_CALL;
}

void iterate_kit_launch_begin(struct iterate_kit_launch *launch) {
  if (launch == NULL) return;
  launch->next_place_ms = 0U;
  launch->first_place_ms = 0U;
  launch->awaiting_acceptance = false;
  launch->failed = false;
  launch->next_delivery_refresh_ms = 0U;
  launch->delivery_refreshes = 0U;
}

void iterate_kit_launch_retry_now(struct iterate_kit_launch *launch) {
  if (launch == NULL) return;
  launch->next_place_ms = 0U;
}
