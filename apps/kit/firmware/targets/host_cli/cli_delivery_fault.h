#ifndef ITERATE_KIT_CLI_DELIVERY_FAULT_H
#define ITERATE_KIT_CLI_DELIVERY_FAULT_H

/*
 * cli_delivery_fault: losing, repeating and reordering frames on purpose,
 * where those things actually happen.
 *
 * WHY NOT ON THE SOCKET. It is tempting to "test packet loss" by dropping
 * bytes in the TLS adapter. That would prove nothing, because A TCP-LEVEL
 * ADVERSARY CANNOT LOSE AN APPLICATION FRAME. By the time bytes reach the
 * adapter they are ordered, retransmitted and MAC-protected; loss on the wire
 * manifests as DELAY, never as a missing frame. Wire timing therefore belongs
 * to something outside this process that reshapes when bytes move, and the
 * frame faults belong here — at the delivery boundary, where the sender and
 * the reconnect machinery really can lose, repeat and reorder one.
 *
 * That is not hypothetical. A connection recycle overlaps two subscriptions
 * for a moment and the same frame arrives twice; a recycle that drops its
 * predecessor a beat early loses the frames in flight; a bridge superseded
 * mid-answer delivers its successor's frames alongside its own. Every one of
 * those is a sender-side event that a socket-level adversary cannot express.
 *
 * WHAT IT IS FOR. The speaker path is a straight line — arrive, queue, play —
 * and a straight line is only as good as what it does when the line is not
 * straight. A live provider is orderly, so a run against one exercises the
 * loss, repeat and reorder cases never. This module makes them happen in a
 * real conversation, deterministically, from a seed, so a report can say what
 * a hole in the audio sounded like rather than that none appeared.
 *
 * FRAMES CARRY NO IDENTITY, so neither does this. They used to arrive stamped
 * with a call, an answer and a position, and the device ran a classifier over
 * those three numbers; a duplicate was interesting because the classifier was
 * supposed to recognise and refuse it. The sender now paces the audio and the
 * device plays what it is given, so a duplicated frame is simply heard twice —
 * still worth injecting, and nothing here has to name it.
 *
 * ORDERING IS THE WHOLE POINT. A held frame must be released BEFORE the frame
 * that displaced it is offered onward, or the reordering is a drop followed by
 * an arrival, which is a different fault. So one offer can emit several
 * frames, and the caller must deliver them in the order given.
 *
 * OWNERSHIP. Held payloads are COPIED into this module, because the caller's
 * buffer is gone by the next frame. Emitted pointers — whether the caller's
 * own frame or a released copy — are valid only until the next call. Nothing
 * allocates; the hold buffer is fixed and bounded by the schedule's maximum.
 *
 * THE DEFAULT IS NO FAULT AT ALL. With an empty schedule every frame is
 * delivered exactly once, in order, and the counters stay zero.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cli_fault_schedule.h"
#include "iterate/kit/voice_device_profile.h"

enum {
  /*
   * Frames one offer can emit: every held frame falling due at once, plus the
   * current frame counted twice in case it is duplicated.
   */
  CLI_DELIVERY_FAULT_MAX_EMIT = CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD + 2,
};

/** One status per way an offer can fail to be understood. */
enum cli_delivery_fault_status {
  CLI_DELIVERY_FAULT_OK = 0,
  /** A NULL fault, frame, payload or output. */
  CLI_DELIVERY_FAULT_ERR_ARG,
};

/**
 * One frame as it is handed onward.
 *
 * `pcm` points either at the caller's own buffer or at this module's hold
 * storage, and is valid only until the next call — see OWNERSHIP above.
 */
struct cli_delivery_frame {
  const uint8_t *pcm;
  size_t bytes;
};

/** What one offer produced, in the order it must be delivered. */
struct cli_delivery_fault_out {
  struct cli_delivery_frame frames[CLI_DELIVERY_FAULT_MAX_EMIT];
  size_t count;
};

/**
 * A frame kept back, and how many more offers until it is due.
 *
 * `remaining` of zero means the slot is free. Counting DOWN rather than
 * storing a release sequence keeps this correct across a call boundary, where
 * sequence numbers restart and an absolute deadline would either fire
 * immediately or never.
 */
struct cli_delivery_held {
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
  size_t bytes;
  uint32_t remaining;
};

/**
 * The injector.
 *
 * `offers` counts frames seen, and is what indexes the schedule's fate table:
 * a counter of its own rather than the frame's own sequence number, so the
 * faults a run suffers do not change when the provider happens to renumber
 * its answers.
 */
struct cli_delivery_fault {
  const struct cli_fault_schedule *schedule;
  struct cli_delivery_held held[CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD];
  uint32_t offers;
  /** The census, which is the whole postmortem of an injected run. */
  uint32_t delivered;
  uint32_t dropped;
  uint32_t duplicated;
  uint32_t reordered;
  /** Held frames released because the call ended, not because they fell due. */
  uint32_t flushed;
  /**
   * Frames that wanted holding when every slot was taken, and so were passed
   * straight through. Counted rather than silently delivered, because a run
   * that quietly injected fewer faults than its schedule says would make a
   * clean result look like proof.
   */
  uint32_t hold_unavailable;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_delivery_fault_status_name(enum cli_delivery_fault_status s);

/**
 * Point the injector at `schedule`, clearing every held frame and counter.
 *
 * A NULL schedule is valid and means "no faults", so a caller needs no branch
 * around whether the harness is on.
 */
void cli_delivery_fault_configure(
    struct cli_delivery_fault *fault, const struct cli_fault_schedule *schedule);

/**
 * Offer one arriving frame; receive the frames to deliver, in order.
 *
 * `out->count` of zero is normal and means the frame was dropped or is being
 * held. A payload longer than a wire frame is delivered untouched but cannot
 * be held — holding copies, and the copy is exactly one frame — so it is
 * passed through and counted in `hold_unavailable`.
 */
enum cli_delivery_fault_status cli_delivery_fault_offer(
    struct cli_delivery_fault *fault,
    const uint8_t *pcm,
    size_t bytes,
    struct cli_delivery_fault_out *out);

/**
 * Release everything held, in the order it was held.
 *
 * Called when a call ends. Frames held at that moment have nowhere to go and
 * would otherwise be a silent leak: the audio is missing, no counter says so,
 * and the next call inherits a buffer with the previous one's speech in it.
 */
void cli_delivery_fault_flush(
    struct cli_delivery_fault *fault, struct cli_delivery_fault_out *out);

#endif /* ITERATE_KIT_CLI_DELIVERY_FAULT_H */
