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

  /*
   * A STREAM IS NO LONGER A CONVERSATION, so a used one does not need
   * replacing.
   *
   * Every path below used to mint a fresh `/agents/voice/<timestamp>` per
   * call, because the stream WAS the conversation — its identity was the
   * call's identity. The server now mints the call itself and says so with
   * `call-started`, so one stream carries as many conversations as the device
   * has button presses.
   *
   * Keeping the old behaviour is what stopped the boards calling at all:
   * preparing a fresh stream means installing the processor facet on it, and
   * a facet's first materialisation on a new path is measured at 45-52s
   * against setup's own deadline. A device asked for a stream it could not get
   * and sat at `wantsCall: true, callPending: false` forever — indefinitely
   * "preparing", never dialling.
   */
  if (!inputs->wants_call) {
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
