/* cli_paced_sink.c: owns the modelled converter's clock and its refusals. */

#include <assert.h>
#include <string.h>

#include "cli_paced_sink.h"

enum {
  CLI_PACED_SINK_US_PER_SECOND = 1000000,
};

/*
 * Adds without wrapping. A counter that wrapped would make a run that got
 * steadily worse look like one that recovered, and these counters are the
 * only evidence an unattended run leaves behind.
 */
static uint32_t cli_paced_sink_add(uint32_t total, uint32_t delta);

/* Advances the schedule and reports the underruns it just discovered. */
static uint32_t cli_paced_sink_drain(struct cli_paced_sink *sink, uint64_t now_us);

/* True when this stamp is older than one already accepted. */
static bool cli_paced_sink_went_backwards(
    const struct cli_paced_sink *sink, uint64_t now_us);

const char *cli_paced_sink_status_name(enum cli_paced_sink_status status)
{
  switch (status) {
    case CLI_PACED_SINK_OK: return "ok";
    case CLI_PACED_SINK_ERR_ARG: return "bad-argument";
    case CLI_PACED_SINK_ERR_BUSY: return "converter-full";
    default: return "unknown";
  }
}

enum cli_paced_sink_status cli_paced_sink_configure(
    struct cli_paced_sink *sink, const struct cli_paced_sink_config *config)
{
  if (sink == NULL || config == NULL) return CLI_PACED_SINK_ERR_ARG;
  if (config->frames_per_second > CLI_PACED_SINK_MAX_FRAMES_PER_SECOND) {
    return CLI_PACED_SINK_ERR_ARG;
  }
  if (config->depth_frames > CLI_PACED_SINK_MAX_DEPTH_FRAMES) {
    return CLI_PACED_SINK_ERR_ARG;
  }
  memset(sink, 0, sizeof(*sink));
  /* No rate is the whole of "unpaced": period_us stays zero and every other
   * entry point short-circuits on it, so the old file-sink behaviour needs no
   * second flag that could disagree with this one. */
  if (config->frames_per_second == 0U) return CLI_PACED_SINK_OK;
  sink->frames_per_second = config->frames_per_second;
  sink->depth_frames = config->depth_frames == 0U
      ? (uint32_t)CLI_PACED_SINK_DEFAULT_DEPTH_FRAMES
      : config->depth_frames;
  /*
   * Truncated to whole microseconds. At 50 frames per second the period is
   * exact; at rates that do not divide evenly the error is under 1 ppm, which
   * is smaller than the crystal tolerance of the converter being modelled.
   */
  sink->period_us =
      (uint32_t)CLI_PACED_SINK_US_PER_SECOND / config->frames_per_second;
  return CLI_PACED_SINK_OK;
}

bool cli_paced_sink_paced(const struct cli_paced_sink *sink)
{
  return sink != NULL && sink->period_us != 0U;
}

uint32_t cli_paced_sink_advance(struct cli_paced_sink *sink, uint64_t now_us)
{
  if (!cli_paced_sink_paced(sink)) return 0U;
  if (cli_paced_sink_went_backwards(sink, now_us)) {
    sink->skew_stamps = cli_paced_sink_add(sink->skew_stamps, 1U);
    return 0U;
  }
  sink->last_us = now_us;
  /*
   * The converter starts when the caller first looks at it, not at stamp
   * zero. Anchoring at zero would make the first advance of a run that began
   * at an arbitrary monotonic offset report the entire uptime of the machine
   * as underruns.
   */
  if (!sink->running) {
    sink->running = true;
    sink->next_drain_us = now_us + sink->period_us;
    return 0U;
  }
  if (now_us < sink->next_drain_us) return 0U;
  return cli_paced_sink_drain(sink, now_us);
}

bool cli_paced_sink_ready(const struct cli_paced_sink *sink)
{
  if (!cli_paced_sink_paced(sink)) return false;
  return sink->queued_frames < sink->depth_frames;
}

enum cli_paced_sink_status cli_paced_sink_offer(struct cli_paced_sink *sink)
{
  if (sink == NULL) return CLI_PACED_SINK_ERR_ARG;
  if (sink->period_us == 0U) {
    sink->accepted_frames = cli_paced_sink_add(sink->accepted_frames, 1U);
    return CLI_PACED_SINK_OK;
  }
  if (sink->queued_frames >= sink->depth_frames) {
    sink->refused_frames = cli_paced_sink_add(sink->refused_frames, 1U);
    return CLI_PACED_SINK_ERR_BUSY;
  }
  ++sink->queued_frames;
  sink->accepted_frames = cli_paced_sink_add(sink->accepted_frames, 1U);
  return CLI_PACED_SINK_OK;
}

static uint32_t cli_paced_sink_add(uint32_t total, uint32_t delta)
{
  if (UINT32_MAX - total < delta) return UINT32_MAX;
  return total + delta;
}

static bool cli_paced_sink_went_backwards(
    const struct cli_paced_sink *sink, uint64_t now_us)
{
  assert(sink != NULL);
  return sink->running && now_us < sink->last_us;
}

static uint32_t cli_paced_sink_drain(struct cli_paced_sink *sink, uint64_t now_us)
{
  assert(sink != NULL && sink->running && sink->period_us != 0U);
  assert(now_us >= sink->next_drain_us);
  const uint64_t period_us = sink->period_us;
  const uint64_t reached = (now_us - sink->next_drain_us) / period_us + 1U;
  const bool resynced = reached > (uint64_t)CLI_PACED_SINK_MAX_DRAIN_FRAMES;
  const uint32_t due = resynced
      ? (uint32_t)CLI_PACED_SINK_MAX_DRAIN_FRAMES
      : (uint32_t)reached;
  const uint32_t played =
      due < sink->queued_frames ? due : sink->queued_frames;
  const uint32_t starved = due - played;
  sink->queued_frames -= played;
  sink->drained_frames = cli_paced_sink_add(sink->drained_frames, played);
  sink->underrun_frames = cli_paced_sink_add(sink->underrun_frames, starved);
  sink->next_drain_us = resynced
      ? now_us + period_us
      : sink->next_drain_us + reached * period_us;
  if (resynced) sink->resyncs = cli_paced_sink_add(sink->resyncs, 1U);
  return starved;
}
