#ifndef ITERATE_KIT_CLI_FAULT_SCHEDULE_H
#define ITERATE_KIT_CLI_FAULT_SCHEDULE_H

/*
 * cli_fault_schedule: everything the rig will do to itself, decided before it
 * starts.
 *
 * ORIGINATING FAILURE. Five defects reached the device behind a rig whose
 * every seam was an optimist — a speaker that could not run dry, a clock that
 * only went forwards, a wire that never clumped. The knobs that fix that are
 * useless without a way to say WHICH knobs were turned, and when. A run that
 * fails at 02:14 having consulted a PRNG lazily cannot be run again: change
 * how often any one knob asks for a decision and every subsequent draw
 * reshuffles, so the second run is a different experiment wearing the same
 * seed.
 *
 * MENTAL MODEL. One PRNG, seeded once, consumed in a FIXED ORDER by a
 * generator that runs to completion before the first frame moves. The result
 * is an artifact: bounded, printable, diffable, and attachable to a bug
 * report. Nothing consults the PRNG again for the life of the session.
 *
 * TWO SHAPES, AND THE REASON THEY DIFFER. Faults that occupy an interval —
 * a stall, a throttle, a skew — are EPISODES on a timeline, because their
 * identity is when they start and how long they last. Faults that befall an
 * individual frame — loss, duplication, reordering — cannot be a timeline:
 * the generator does not know how many frames a conversation will contain.
 * They are a pre-drawn FATE TABLE indexed by a frame counter, which is
 * deterministic without being periodic and stays bounded however long the run.
 *
 * THE LANE MATTERS AND MUST BE STATED. In the sealed lane — virtual clock, no
 * sockets — a seed replays the run bit for bit and a failure is a fact. In the
 * live lane a seed reproduces WHAT WE DID TO THE SYSTEM, not what happened to
 * it: TCP timing, provider latency, and model sampling are outside any seed.
 * That is still the difference between "it failed once, overnight" and "it
 * failed under schedule 0x8f31a44c, and here it is again", so both are worth
 * having as long as no report confuses one for the other.
 *
 * A SEED IS NOT ENOUGH ON ITS OWN. A seed only reproduces a run against the
 * generator that drew it, and generators get edited. So the schedule itself
 * serialises, and a serialised schedule can be replayed against any build.
 *
 * THE DEFAULT IS AN EMPTY SCHEDULE. No episodes, every frame delivered, which
 * is the rig exactly as it behaves with no knob turned. A harness nobody can
 * switch off does not get left in.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

enum {
  /*
   * Episodes one session may contain. An hour of conversation with a fault
   * every few seconds fits inside this with room to spare; a generator that
   * wants more is describing noise rather than a fault pattern, and a run
   * nobody can read the schedule of is not reproducible in the sense that
   * matters.
   */
  CLI_FAULT_SCHEDULE_MAX_EPISODES = 512,
  /*
   * Fates drawn for the delivery boundary. Indexed by a frame counter modulo
   * this, so it repeats every 1024 frames — twenty seconds of speech at the
   * 20 ms frame. Long enough that no single answer sees the seam, short
   * enough to print in full alongside the schedule.
   */
  CLI_FAULT_SCHEDULE_FATE_SLOTS = 1024,
  /*
   * Frames a reordering fate may hold back. The playout classifier decides
   * on an answer/frame identity, and a frame held longer than this arrives
   * after its answer has been superseded — which is a different test (a
   * stale answer, already covered by the classifier's own unit tests) than
   * the one reordering is for.
   */
  CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD = 8,
};

/** One status per way a schedule can fail to be built or read. */
enum cli_fault_schedule_status {
  CLI_FAULT_SCHEDULE_OK = 0,
  /** A NULL schedule, or a NULL stream where one was required. */
  CLI_FAULT_SCHEDULE_ERR_ARG,
  /** A knob outside its documented bounds. */
  CLI_FAULT_SCHEDULE_ERR_RANGE,
  /** The generator wanted more episodes than the schedule can hold. */
  CLI_FAULT_SCHEDULE_ERR_FULL,
  /** Serialised input that is not a schedule this build understands. */
  CLI_FAULT_SCHEDULE_ERR_MALFORMED,
  /** The output buffer or file could not take the whole schedule. */
  CLI_FAULT_SCHEDULE_ERR_IO,
};

/**
 * What an episode does while it is running.
 *
 * Each names a fault the device actually suffered, and the comment says which,
 * because a knob whose provenance nobody remembers gets swept to its default
 * and stops finding anything.
 */
enum cli_fault_kind {
  CLI_FAULT_KIND_NONE = 0,
  /**
   * The loop is not scheduled at all for the episode's duration.
   *
   * The device's task is preempted; this rig's is not. Everything the loop
   * forgives during a stall — the four-frame playback clamp, the mic deadline
   * clamp — is unreachable without this, and with a file-backed speaker a
   * stall costs nothing and reports nothing.
   */
  CLI_FAULT_KIND_CPU_STALL,
  /**
   * The clock returns a stamp behind one already handed out, once, by
   * `magnitude` milliseconds.
   *
   * This is the 42-rebuilds-in-three-minutes defect: an unsigned elapsed-time
   * subtraction underflowed to 2^64-1 and tripped every supervision deadline
   * in the process at the same instant.
   */
  CLI_FAULT_KIND_CLOCK_SKEW,
  /** Stamps wander +/- `magnitude` ms, for deadline arithmetic that assumes
   * evenly spaced samples. */
  CLI_FAULT_KIND_CLOCK_JITTER,
  /**
   * The downlink is held to `magnitude` frames per second.
   *
   * Measured on the device at 9-31 f/s against the 50 realtime needs. Lives
   * out of process: see the proxy note on cli_fault_schedule_write_json.
   */
  CLI_FAULT_KIND_WIRE_THROTTLE,
  /**
   * Bytes stop moving for the episode's duration, then resume in a clump.
   *
   * The wire delivered 139 frames in one second and then nothing; a rig that
   * only models an even rate never builds the backlog that follows.
   */
  CLI_FAULT_KIND_WIRE_STALL,
  /** The connection is severed mid-answer, for the reconnect and recycle
   * paths. */
  CLI_FAULT_KIND_WIRE_RESET,
  /** Capture hands back partial buffers, as a real driver does around the
   * start and stop of a turn. */
  CLI_FAULT_KIND_MIC_SHORT,
  /**
   * Capture is driven to full scale.
   *
   * The mu-law encoder mapped -32768 to the code for silence, so the loudest
   * possible sample played as nothing. Only a clipped input reaches it.
   */
  CLI_FAULT_KIND_MIC_CLIP,
};

/** What happens to one frame at the delivery boundary. */
enum cli_frame_fate {
  /** The overwhelming majority, and the only fate an empty schedule draws. */
  CLI_FRAME_FATE_DELIVER = 0,
  /** Dropped: sequence-gap accounting and concealment. */
  CLI_FRAME_FATE_DROP,
  /** Delivered twice: a duplicate must not be played twice. */
  CLI_FRAME_FATE_DUPLICATE,
  /** Held back and delivered after the frames behind it. */
  CLI_FRAME_FATE_REORDER,
};

/**
 * One fault, bounded in time.
 *
 * `at_ms` is measured from the start of the session, not from a wall clock,
 * so a schedule means the same thing on any machine and in any year.
 * `magnitude` is interpreted per kind and is documented on each: milliseconds
 * for a skew, frames per second for a throttle, unused for a reset.
 */
struct cli_fault_episode {
  uint64_t at_ms;
  uint32_t duration_ms;
  uint32_t magnitude;
  enum cli_fault_kind kind;
};

/**
 * The knobs a generator is allowed to draw from.
 *
 * Every field zero means an empty schedule, so a caller that wants today's
 * behaviour supplies nothing and gets it. Rates are per-minute because that is
 * the unit an operator reasons in ("a stall about every twenty seconds"), and
 * a per-frame probability is unreadable at the sizes that matter.
 */
struct cli_fault_recipe {
  uint64_t session_ms;
  uint32_t cpu_stalls_per_minute;
  uint32_t cpu_stall_max_ms;
  uint32_t clock_skews_per_minute;
  uint32_t clock_skew_max_ms;
  uint32_t clock_jitter_ms;
  uint32_t wire_stalls_per_minute;
  uint32_t wire_stall_max_ms;
  uint32_t wire_resets_per_session;
  /** Held to this many frames per second throughout; 0 leaves it
   * unthrottled. */
  uint32_t wire_throttle_fps;
  /** One frame in N is lost / duplicated / reordered; 0 disables each. */
  uint32_t frame_loss_one_in;
  uint32_t frame_duplicate_one_in;
  uint32_t frame_reorder_one_in;
  uint32_t mic_short_one_in;
  bool mic_clip;
};

/**
 * A whole session's adversity, and the seed that produced it.
 *
 * Episodes are sorted by `at_ms` at generation, so a consumer walks them with
 * a cursor and never searches. The fate table is drawn once and read modulo
 * its length; `reorder_hold` says how many frames a REORDER fate holds its
 * frame back, drawn alongside the fate so the pair stays reproducible.
 */
struct cli_fault_schedule {
  uint64_t seed;
  uint64_t session_ms;
  size_t episode_count;
  struct cli_fault_episode episodes[CLI_FAULT_SCHEDULE_MAX_EPISODES];
  uint8_t fates[CLI_FAULT_SCHEDULE_FATE_SLOTS];
  uint8_t reorder_hold[CLI_FAULT_SCHEDULE_FATE_SLOTS];
  /** True when no knob was turned: the rig behaves exactly as it did before
   * this module existed, and reports say so. */
  bool empty;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_fault_schedule_status_name(enum cli_fault_schedule_status s);

/** Human-readable kind name, used in the serialised form and in logs. */
const char *cli_fault_kind_name(enum cli_fault_kind kind);

/**
 * Clear `schedule` to the empty one: no episodes, every frame delivered.
 *
 * A caller that never turns a knob still has a valid schedule to consult, so
 * no site downstream needs a NULL check or a "is the harness on" branch.
 */
void cli_fault_schedule_clear(struct cli_fault_schedule *schedule);

/**
 * Draw a whole session's faults from `seed` and `recipe`, in one pass, before
 * anything runs.
 *
 * The PRNG is consumed in a fixed, documented order — episodes by kind in
 * declaration order, then the fate table, then the hold table — so adding a
 * knob at the END of the recipe leaves every previously drawn schedule
 * unchanged. Adding one in the middle does not, which is why serialised
 * schedules exist.
 *
 * Returns ERR_FULL rather than truncating: a schedule quietly missing its
 * last hour of faults would make a clean run look like proof.
 */
enum cli_fault_schedule_status cli_fault_schedule_generate(
    struct cli_fault_schedule *schedule,
    uint64_t seed,
    const struct cli_fault_recipe *recipe);

/**
 * Write `schedule` as JSON.
 *
 * Serialised because a seed only reproduces a run against the generator that
 * drew it, and generators get edited. JSON specifically because the wire
 * faults are enforced by a proxy OUTSIDE this process — a TCP-level adversary
 * cannot drop an application frame, only delay it, so wire timing belongs to
 * something that terminates nothing while frame loss belongs at the delivery
 * boundary in here. Both halves must be able to read the same artifact.
 */
enum cli_fault_schedule_status cli_fault_schedule_write_json(
    const struct cli_fault_schedule *schedule, FILE *out);

/**
 * Read back what cli_fault_schedule_write_json wrote.
 *
 * Rejects a schedule it does not fully understand rather than ignoring the
 * parts it cannot read: a replay silently missing the one fault that mattered
 * is worse than a replay that refuses.
 */
enum cli_fault_schedule_status cli_fault_schedule_read_json(
    struct cli_fault_schedule *schedule, FILE *in);

/**
 * The fate of frame `sequence`, and how long a REORDER holds it.
 *
 * `hold_frames` may be NULL when the caller does not implement reordering,
 * in which case a REORDER fate reads as DELIVER — an honest degradation,
 * since a rig that cannot hold a frame back must not pretend it did.
 */
enum cli_frame_fate cli_fault_schedule_fate(
    const struct cli_fault_schedule *schedule,
    uint32_t sequence,
    uint32_t *hold_frames);

/**
 * Whether an episode of `kind` covers `elapsed_ms`, and its magnitude.
 *
 * Takes elapsed session time rather than a clock, so this module reads no
 * clock and a sealed run driven by a counter replays bit for bit — including
 * the clock episodes, which would otherwise have to ask the clock they are
 * about to corrupt what time it is.
 */
bool cli_fault_schedule_active(
    const struct cli_fault_schedule *schedule,
    enum cli_fault_kind kind,
    uint64_t elapsed_ms,
    uint32_t *magnitude);

#endif /* ITERATE_KIT_CLI_FAULT_SCHEDULE_H */
