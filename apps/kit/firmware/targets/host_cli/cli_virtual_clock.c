#include "cli_virtual_clock.h"

#include <assert.h>
#include <stddef.h>
#include <time.h>

/*
 * The ONE place in this target that reads the host clock. Everything else
 * takes a stamp from cli_virtual_clock_now_ms, so "is this run deterministic"
 * is answered by reading this function rather than by auditing call sites.
 */
static uint64_t host_monotonic_ms(void)
{
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0U;
  return (uint64_t)now.tv_sec * 1000U + (uint64_t)(now.tv_nsec / 1000000L);
}

/** Scale a real interval by the configured rate, in parts per thousand. */
static uint64_t scaled(uint64_t elapsed_ms, uint32_t rate)
{
  assert(rate > 0U);
  return elapsed_ms * rate / (uint64_t)CLI_VIRTUAL_CLOCK_RATE_UNIT;
}

/** Session time before the schedule is allowed to distort it. */
static uint64_t undistorted_ms(
    const struct cli_virtual_clock *clock, uint64_t host_now_ms)
{
  assert(clock != NULL);
  if (clock->mode == CLI_VIRTUAL_CLOCK_SEALED) return clock->sealed_ms;
  if (host_now_ms < clock->anchor_host_ms) return clock->anchor_session_ms;
  return clock->anchor_session_ms +
         scaled(host_now_ms - clock->anchor_host_ms, clock->rate);
}

/**
 * Jitter derived from the stamp itself rather than from a generator.
 *
 * Consuming a PRNG here would break the schedule's promise that every draw
 * happens before the run starts, and would make the number of stamps taken —
 * an implementation detail of the loop — change the sequence. A hash of the
 * millisecond is reproducible, evenly spread, and costs nothing.
 */
static uint64_t jittered(uint64_t base_ms, uint32_t magnitude)
{
  uint64_t mixed = base_ms * 0x9E3779B97F4A7C15ULL;
  uint64_t spread = (uint64_t)magnitude * 2U + 1U;
  uint64_t offset = (mixed >> 33) % spread;
  uint64_t low = base_ms < magnitude ? 0U : base_ms - magnitude;
  return low + offset;
}

const char *cli_virtual_clock_status_name(enum cli_virtual_clock_status s)
{
  switch (s) {
    case CLI_VIRTUAL_CLOCK_OK: return "ok";
    case CLI_VIRTUAL_CLOCK_ERR_ARG: return "arg";
    case CLI_VIRTUAL_CLOCK_ERR_RANGE: return "range";
  }
  return "unknown";
}

static void reset(
    struct cli_virtual_clock *clock,
    enum cli_virtual_clock_mode mode,
    uint32_t rate,
    const struct cli_fault_schedule *schedule)
{
  assert(clock != NULL);
  clock->mode = mode;
  clock->rate = rate;
  clock->anchor_host_ms = 0U;
  clock->anchor_session_ms = 0U;
  clock->sealed_ms = 0U;
  clock->issued_ms = 0U;
  clock->schedule = schedule;
  clock->jitter_stamps = 0U;
  clock->skew_stamps = 0U;
  clock->skews_spent = 0U;
  clock->skew_armed = true;
}

enum cli_virtual_clock_status cli_virtual_clock_anchor(
    struct cli_virtual_clock *clock,
    uint64_t host_now_ms,
    uint32_t rate,
    const struct cli_fault_schedule *schedule)
{
  if (clock == NULL) return CLI_VIRTUAL_CLOCK_ERR_ARG;
  if (rate == 0U || rate > CLI_VIRTUAL_CLOCK_MAX_RATE) {
    return CLI_VIRTUAL_CLOCK_ERR_RANGE;
  }
  reset(clock, CLI_VIRTUAL_CLOCK_ANCHORED, rate, schedule);
  clock->anchor_host_ms = host_now_ms;
  return CLI_VIRTUAL_CLOCK_OK;
}

enum cli_virtual_clock_status cli_virtual_clock_seal(
    struct cli_virtual_clock *clock, const struct cli_fault_schedule *schedule)
{
  if (clock == NULL) return CLI_VIRTUAL_CLOCK_ERR_ARG;
  reset(clock, CLI_VIRTUAL_CLOCK_SEALED, CLI_VIRTUAL_CLOCK_RATE_UNIT, schedule);
  return CLI_VIRTUAL_CLOCK_OK;
}

enum cli_virtual_clock_status cli_virtual_clock_advance(
    struct cli_virtual_clock *clock, uint64_t delta_ms)
{
  if (clock == NULL) return CLI_VIRTUAL_CLOCK_ERR_ARG;
  /*
   * Pushing time into a clock that also reads the host would give the rig two
   * sources of truth and no way to say which produced a given stamp.
   */
  if (clock->mode != CLI_VIRTUAL_CLOCK_SEALED) return CLI_VIRTUAL_CLOCK_ERR_ARG;
  clock->sealed_ms += delta_ms;
  return CLI_VIRTUAL_CLOCK_OK;
}

/**
 * Spend one skew episode: hand back a stamp BEHIND one already issued.
 *
 * Deliberately once per episode. A skew that persisted would not model the
 * defect it exists for — an NTP step or a counter wrap is a single backwards
 * jump, and it is the arithmetic on the FIRST subtraction afterwards that
 * underflowed and rebuilt a healthy call 42 times in three minutes.
 */
static bool take_skew(
    struct cli_virtual_clock *clock, uint64_t elapsed_ms, uint64_t *stamp)
{
  uint32_t magnitude = 0U;
  assert(clock != NULL && stamp != NULL);
  if (clock->schedule == NULL) return false;
  if (!cli_fault_schedule_active(
          clock->schedule, CLI_FAULT_KIND_CLOCK_SKEW, elapsed_ms, &magnitude)) {
    /* Out of any episode: the next one gets its own step. */
    clock->skew_armed = true;
    return false;
  }
  if (!clock->skew_armed) return false;
  clock->skew_armed = false;
  clock->skews_spent++;
  clock->skew_stamps++;
  *stamp = clock->issued_ms < magnitude ? 0U : clock->issued_ms - magnitude;
  return true;
}

uint64_t cli_virtual_clock_sample(
    struct cli_virtual_clock *clock, uint64_t host_now_ms)
{
  uint64_t stamp;
  uint32_t jitter = 0U;
  if (clock == NULL) return 0U;

  stamp = undistorted_ms(clock, host_now_ms);
  if (take_skew(clock, stamp, &stamp)) return stamp;

  if (clock->schedule != NULL &&
      cli_fault_schedule_active(
          clock->schedule, CLI_FAULT_KIND_CLOCK_JITTER, stamp, &jitter) &&
      jitter > 0U) {
    stamp = jittered(stamp, jitter);
    clock->jitter_stamps++;
  }
  /*
   * Monotonic unless a skew episode deliberately said otherwise. Jitter that
   * happened to land behind the last stamp is clamped rather than issued:
   * corrupting time by accident would make every failure look like a clock
   * bug, and the whole point of the skew knob is that the corruption is
   * announced, bounded, and counted.
   */
  if (stamp < clock->issued_ms) stamp = clock->issued_ms;
  clock->issued_ms = stamp;
  return stamp;
}

uint64_t cli_virtual_clock_now_ms(void *context)
{
  struct cli_virtual_clock *clock = (struct cli_virtual_clock *)context;
  if (clock == NULL) return 0U;
  if (clock->mode == CLI_VIRTUAL_CLOCK_SEALED) {
    return cli_virtual_clock_sample(clock, 0U);
  }
  return cli_virtual_clock_sample(clock, host_monotonic_ms());
}

uint64_t cli_virtual_clock_now_us(void *context)
{
  /*
   * Derived from the millisecond stamp rather than sampled separately, so the
   * converter model and the loop can never disagree about what time it is —
   * two independent reads of a jittered clock would drift apart by the jitter
   * on every iteration, and the sink would report underruns caused by nothing
   * but its own clock.
   *
   * THE COST, STATED: resolution is a millisecond, so a converter period that
   * does not divide 1000 evenly (30 f/s is 33333 us) has its drain boundaries
   * detected up to 1 ms late. The sink advances by whole periods and counts
   * boundaries crossed, so no boundary is ever LOST and cumulative underrun
   * counts stay exact — only the instant one is noticed moves. That is a
   * price worth paying for two stamps that cannot contradict each other.
   */
  return cli_virtual_clock_now_ms(context) * 1000U;
}
