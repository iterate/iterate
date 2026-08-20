#ifndef ITERATE_KIT_CONVERSATION_LAUNCH_H
#define ITERATE_KIT_CONVERSATION_LAUNCH_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * GETTING INTO A CALL, for every board.
 *
 * A STREAM IS NO LONGER A CONVERSATION, so this is one step: place the call.
 *
 * Placing a call used to be two — mint a fresh `/agents/voice/<timestamp>`,
 * then dial on it — because a stream's identity WAS the call's identity. Each
 * board carried its own copy of the ladder that sequenced those, and all four
 * shared ONE retry timer between "prepare because nobody has asked yet" and
 * "prepare because somebody just pressed the button", so a press served the
 * idle countdown: measured on the HA Voice PE, one press reached the server in
 * 2.6s and the next took 21.5s, of which 18s was a device sitting on an idle
 * backoff while a person stood in front of it.
 *
 * Splitting the deadlines fixed the wait. What retired the whole ladder was
 * the server minting the call itself and saying so with `call-started`: one
 * stream now carries as many conversations as the device has button presses.
 * Keeping the old behaviour was actively fatal by then — preparing meant
 * installing the processor facet on a brand-new path, whose first
 * materialisation is measured at 45-52s, longer than setup's own deadline. A
 * board asked for a stream it could not get and sat at `wantsCall: true,
 * callPending: false` forever, indefinitely "preparing" and never dialling.
 */

/**
 * Retry for placing the call itself. A warm start measures 1.4-1.5s, so 3s
 * re-places with real headroom while capping the penalty when the FIRST
 * press is swallowed — measured on preview: touching an idle stream resets
 * its Durable Object, the ephemeral opening press dies with the old
 * incarnation, and this retry was the 8-second clock the whole cold dial
 * waited on.
 */
#define ITERATE_KIT_LAUNCH_PLACE_RETRY_MS 3000U

/** What the device loop should do about calls this tick. */
enum iterate_kit_launch_step {
  /** Nothing is owed: no intent, or a deadline has not come round yet. */
  ITERATE_KIT_LAUNCH_NOTHING = 0,
  /** Somebody has asked and nothing is in flight: place the call. */
  ITERATE_KIT_LAUNCH_PLACE_CALL,
};

/** Everything the decision reads, as the device knows it this tick. */
struct iterate_kit_launch_inputs {
  /** The person is asking for a call — a held button, a tap, an RPC. */
  bool wants_call;
  /** A call is up. */
  bool call_active;
  /** A start has been sent and nothing has answered it yet. */
  bool call_pending;
  /** The session can carry the request — outbox room, transport ready. */
  bool link_ready;
  /** Milliseconds since boot, monotonic. */
  uint64_t now_ms;
};

/**
 * The one deadline.
 *
 * Zero-initialise and it is immediately due, which is what a device that has
 * just come up wants.
 */
struct iterate_kit_launch {
  /** Earliest next attempt at placing the call. */
  uint64_t next_place_ms;
};

/**
 * Decide, and arm the deadline for whatever was decided.
 *
 * Call once per loop tick and act on the answer. Deciding and arming are one
 * operation deliberately: a caller that could do the first without the second
 * is a caller that can retry in a tight loop.
 */
enum iterate_kit_launch_step iterate_kit_launch_next_step(
    struct iterate_kit_launch *launch,
    const struct iterate_kit_launch_inputs *inputs);

/**
 * Forget every backoff: the next tick may act.
 *
 * For the moments when waiting is provably pointless — a call whose bridge has
 * gone silent, a start nothing ever answered. Retrying on the old deadline
 * there adds a wait to a failure the device has already detected.
 */
void iterate_kit_launch_retry_now(struct iterate_kit_launch *launch);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_CONVERSATION_LAUNCH_H */
