#ifndef ITERATE_KIT_CLI_VIRTUAL_CLOCK_H
#define ITERATE_KIT_CLI_VIRTUAL_CLOCK_H

/*
 * cli_virtual_clock: the second implementation of a seam that already exists.
 *
 * ORIGINATING FAILURE. A healthy call was torn down and rebuilt 42 times in
 * three minutes because an elapsed-time subtraction ran on unsigned stamps and
 * one stamp arrived a millisecond behind another. `now - since` underflowed to
 * 18446744073709551615, every supervision deadline in the process compared
 * true at the same instant, and the device spent the call reconnecting. No
 * host run could reach that: `clock_gettime(CLOCK_MONOTONIC)` never goes
 * backwards, so the branch existed and could not be entered.
 *
 * WHY AN IMPLEMENTATION AND NOT A DECORATOR. `voicelab_options.now_ms` is
 * already a function pointer and `cli_runtime_now_ms` is merely its only
 * implementation, so the seam is built; this is a second thing to plug into
 * it. A decorator would imply a real clock underneath, and half the value here
 * is running with NO real clock at all — a sealed rig whose every stamp comes
 * from a counter and whose runs therefore replay bit for bit.
 *
 * TWO MODES, ONE INTERFACE.
 *   ANCHORED advances with the host's monotonic clock and applies the
 *   schedule's distortions on top. This is the live lane: real sockets, real
 *   provider, injected adversity. A seed reproduces what we did to the system,
 *   not what happened to it.
 *   SEALED reads no host clock ever. Time advances only when the caller says
 *   so, which makes an hour of session take as long as the arithmetic and
 *   makes every run of a seed identical. This is where regressions are gated.
 *
 * THE ONE INVARIANT. A stamp handed out is never contradicted. Jitter and
 * skew move the clock, but `cli_virtual_clock_now_ms` is MONOTONIC ACROSS
 * CALLS unless a skew episode is deliberately running, and a skew is bounded,
 * announced in the schedule, and counted. Corrupting time by accident would
 * make every failure a clock bug; corrupting it on purpose, once, on a
 * schedule anyone can read, is a test.
 *
 * THE DEFAULT CHANGES NOTHING. Anchored, no schedule, rate 1.0: the stamps are
 * the host's own, and the rig behaves exactly as it did before this existed.
 */

#include <stdbool.h>
#include <stdint.h>

#include "cli_fault_schedule.h"

/** Where the clock's advance comes from. */
enum cli_virtual_clock_mode {
  /** The host's monotonic clock, distorted by the schedule. The live lane. */
  CLI_VIRTUAL_CLOCK_ANCHORED = 0,
  /** A counter the caller advances. No host clock is read. The sealed lane. */
  CLI_VIRTUAL_CLOCK_SEALED,
};

/** One status per way the clock can be misconfigured. */
enum cli_virtual_clock_status {
  CLI_VIRTUAL_CLOCK_OK = 0,
  /** A NULL clock, or a sealed advance on an anchored clock. */
  CLI_VIRTUAL_CLOCK_ERR_ARG,
  /** A rate of zero, or one so large that a session overflows its stamps. */
  CLI_VIRTUAL_CLOCK_ERR_RANGE,
};

enum {
  /*
   * Rate is fixed point in parts per thousand, not a double: a float here
   * would make two runs of one seed differ in their last bit on different
   * hosts, and "replays bit for bit" is the whole promise of the sealed lane.
   */
  CLI_VIRTUAL_CLOCK_RATE_UNIT = 1000,
  /*
   * A run 1000x faster than realtime turns an hour into three seconds, which
   * is the point; faster than that and a 20 ms frame period rounds to zero
   * and every deadline fires on every iteration.
   */
  CLI_VIRTUAL_CLOCK_MAX_RATE = 1000 * CLI_VIRTUAL_CLOCK_RATE_UNIT,
};

/**
 * The clock.
 *
 * `issued_ms` is the last stamp handed to anybody, which is what makes the
 * monotonicity invariant checkable rather than aspirational: every path that
 * would return something smaller must go through the skew accounting, and the
 * counters below are the record that it did.
 */
struct cli_virtual_clock {
  enum cli_virtual_clock_mode mode;
  /** Parts per thousand of real time; CLI_VIRTUAL_CLOCK_RATE_UNIT is 1.0. */
  uint32_t rate;
  /** Host stamp at the last reset; unused and unread when sealed. */
  uint64_t anchor_host_ms;
  /** Session time at the last reset. */
  uint64_t anchor_session_ms;
  /** Sealed mode's counter. */
  uint64_t sealed_ms;
  /** The last stamp returned to a caller. */
  uint64_t issued_ms;
  /** Schedule consulted for jitter and skew; may be NULL for none. */
  const struct cli_fault_schedule *schedule;
  /** Distortions actually applied, for the report. */
  uint32_t jitter_stamps;
  uint32_t skew_stamps;
  /** Skew episodes fire ONCE each; this is how many have been spent. */
  uint32_t skews_spent;
  /**
   * Whether the skew episode now running has yet to fire.
   *
   * A skew is a single backwards STEP, not an interval: an NTP correction or
   * a counter wrap happens once, and what matters is the first subtraction
   * afterwards. The episode still needs a window, because a consumer only
   * discovers a step when it next samples — so the window says "somewhere in
   * here", and this says "not yet spent". Cleared on entering an episode,
   * set again once it has passed, which is what makes a recipe asking for
   * several skews get several rather than one.
   */
  bool skew_armed;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_virtual_clock_status_name(enum cli_virtual_clock_status s);

/**
 * Start an anchored clock at `host_now_ms`, running at `rate`.
 *
 * `schedule` may be NULL, and with a NULL schedule and unit rate this clock
 * returns the host's stamps unchanged — which is the default the rig ships
 * with and the reason turning the harness off is free.
 */
enum cli_virtual_clock_status cli_virtual_clock_anchor(
    struct cli_virtual_clock *clock,
    uint64_t host_now_ms,
    uint32_t rate,
    const struct cli_fault_schedule *schedule);

/**
 * Start a sealed clock at session time zero. No host clock is ever read.
 *
 * Every stamp comes from cli_virtual_clock_advance, so a caller that forgets
 * to advance sees time stand still — which is a hang, loudly, rather than a
 * run that quietly consulted the wall clock behind the seam's back.
 */
enum cli_virtual_clock_status cli_virtual_clock_seal(
    struct cli_virtual_clock *clock,
    const struct cli_fault_schedule *schedule);

/**
 * Move a sealed clock forward by `delta_ms`. ERR_ARG on an anchored clock,
 * because a caller pushing time into a clock that also reads the host has
 * two sources of truth and no way to say which produced a stamp.
 */
enum cli_virtual_clock_status cli_virtual_clock_advance(
    struct cli_virtual_clock *clock, uint64_t delta_ms);

/**
 * The current stamp, in session milliseconds, with the schedule's distortions
 * applied.
 *
 * `host_now_ms` is ignored by a sealed clock and is the host's monotonic
 * reading for an anchored one — passed in rather than read here so that this
 * module reads no clock and every caller is visibly the one that did.
 *
 * Shaped as the `now_ms` callback's twin so it can be installed straight into
 * `iterate_kit_voicelab_options`; see cli_virtual_clock_now_ms.
 */
uint64_t cli_virtual_clock_sample(
    struct cli_virtual_clock *clock, uint64_t host_now_ms);

/**
 * The `now_ms(void *context)` the voicelab options want, with `context` a
 * `struct cli_virtual_clock *`.
 *
 * An anchored clock reads the host here — the single place in the rig that is
 * allowed to, so "is this run deterministic" is answered by looking at one
 * function rather than auditing every call site. A sealed clock does not.
 */
uint64_t cli_virtual_clock_now_ms(void *context);

/**
 * The same instant in microseconds, for the converter model whose 20 ms
 * period a millisecond stamp cannot express at every rate worth sweeping.
 */
uint64_t cli_virtual_clock_now_us(void *context);

#endif /* ITERATE_KIT_CLI_VIRTUAL_CLOCK_H */
