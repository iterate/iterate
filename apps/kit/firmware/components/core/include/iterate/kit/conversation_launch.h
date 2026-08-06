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
 * Placing a call is two steps: prepare a conversation stream (the server mints
 * the stream, the agent, the capability host, three system prompts and a
 * warm-up handshake — measured at 3-5s) and then place the call on it. Each
 * board had its own copy of the ladder that sequences those, and all four
 * copies shared ONE retry timer between "prepare because nobody has asked yet"
 * and "prepare because somebody just pressed the button".
 *
 * That is the defect this module exists to end. The idle prepare arms a
 * deliberately slow retry — nobody is waiting on it — and the tap then had to
 * serve that countdown: measured on the HA Voice PE, one press reached the
 * server in 2.6s and the next took 21.5s, of which 18s was the device sitting
 * on an idle backoff while a person stood in front of it. Three separate
 * deadlines here, and a press can never wait on the idle one.
 */

/** Retry for a prepare nobody is waiting on. Slow on purpose. */
#define ITERATE_KIT_LAUNCH_PREPARE_AHEAD_RETRY_MS 30000U
/** Retry for a prepare somebody IS waiting on. */
#define ITERATE_KIT_LAUNCH_PREPARE_RETRY_MS 8000U
/** Retry for placing the call itself; a start takes ~1-3s. */
#define ITERATE_KIT_LAUNCH_PLACE_RETRY_MS 8000U

/** What the device loop should do about calls this tick. */
enum iterate_kit_launch_step {
  /** Nothing is owed: no intent, or a deadline has not come round yet. */
  ITERATE_KIT_LAUNCH_NOTHING = 0,
  /** Prepare a fresh conversation while idle, so a press costs nothing. */
  ITERATE_KIT_LAUNCH_PREPARE_AHEAD,
  /** Prepare a fresh conversation because a call was asked for. */
  ITERATE_KIT_LAUNCH_PREPARE_NOW,
  /** The stream is fresh and unused: place the call on it. */
  ITERATE_KIT_LAUNCH_PLACE_CALL,
};

/** Everything the decision reads, as the device knows it this tick. */
struct iterate_kit_launch_inputs {
  /** The person is asking for a call — a held button, a tap, an RPC. */
  bool wants_call;
  /**
   * This stream already has a conversation on it.
   *
   * A used stream is never called again: carrying the last conversation into
   * this one costs the person an answer that makes no sense.
   */
  bool stream_used;
  /** A call is up. */
  bool call_active;
  /** A start has been sent and nothing has answered it yet. */
  bool call_pending;
  /** A prepare is already in flight; a second would race it. */
  bool preparing;
  /** The session can carry the request — outbox room, transport ready. */
  bool link_ready;
  /** Milliseconds since boot, monotonic. */
  uint64_t now_ms;
};

/**
 * The three deadlines, which are NOT one deadline.
 *
 * Zero-initialise and everything is immediately due, which is what a device
 * that has just come up wants.
 */
struct iterate_kit_launch {
  /** Earliest next prepare-ahead. Armed slow; a press must never read it. */
  uint64_t next_prepare_ahead_ms;
  /** Earliest next prepare for a call somebody asked for. */
  uint64_t next_prepare_ms;
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
