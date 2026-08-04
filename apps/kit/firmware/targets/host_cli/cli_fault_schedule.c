#include "cli_fault_schedule.h"

#include <assert.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

/*
 * THE DRAW ORDER IS PART OF THE CONTRACT.
 *
 * The header promises that appending a knob to the END of cli_fault_recipe
 * leaves every previously drawn schedule unchanged. That promise is kept by
 * consuming the PRNG in exactly this order, and by nothing else:
 *
 *   1. CPU stall episodes      (count, then at/duration per episode)
 *   2. Clock skew episodes
 *   3. Clock jitter episode    (one, spanning the session, if configured)
 *   4. Wire stall episodes
 *   5. Wire reset episodes
 *   6. Wire throttle episode   (one, spanning the session, if configured)
 *   7. Mic short episode       (one, spanning the session, if configured)
 *   8. Mic clip episode        (one, spanning the session, if configured)
 *   9. The fate table, slot 0 upward
 *  10. The reorder hold table, slot 0 upward
 *
 * Inserting a knob in the middle of that list renumbers every subsequent draw
 * and silently changes what a seed means. That is why serialised schedules
 * exist: a seed only reproduces a run against the generator that drew it.
 */

enum {
  /* Milliseconds in a minute, for turning per-minute rates into counts. */
  MS_PER_MINUTE = 60000,
  /*
   * How long a clock step stays takeable. A backwards jump is instantaneous,
   * but a consumer only discovers it when it next samples the clock, so the
   * episode needs a window wide enough that a loop running at any plausible
   * rate lands inside it. Narrower than this and the fault silently never
   * fires, which reads in a report as a knob that found nothing.
   */
  SKEW_WINDOW_MS = 200,
};

/*
 * xorshift64* — small, well-distributed, and OURS. rand() was rejected on
 * purpose: its sequence belongs to libc and differs between platforms, which
 * would break the single promise this module makes.
 */
struct prng {
  uint64_t state;
};

static uint64_t prng_next(struct prng *prng)
{
  assert(prng != NULL);
  prng->state ^= prng->state >> 12;
  prng->state ^= prng->state << 25;
  prng->state ^= prng->state >> 27;
  return prng->state * 0x2545F4914F6CDD1DULL;
}

/** Uniform in [0, bound). Zero bound yields zero rather than dividing by it. */
static uint64_t prng_below(struct prng *prng, uint64_t bound)
{
  if (bound == 0U) return 0U;
  return prng_next(prng) % bound;
}

const char *cli_fault_schedule_status_name(enum cli_fault_schedule_status s)
{
  switch (s) {
    case CLI_FAULT_SCHEDULE_OK: return "ok";
    case CLI_FAULT_SCHEDULE_ERR_ARG: return "arg";
    case CLI_FAULT_SCHEDULE_ERR_RANGE: return "range";
    case CLI_FAULT_SCHEDULE_ERR_FULL: return "full";
    case CLI_FAULT_SCHEDULE_ERR_MALFORMED: return "malformed";
    case CLI_FAULT_SCHEDULE_ERR_IO: return "io";
  }
  return "unknown";
}

const char *cli_fault_kind_name(enum cli_fault_kind kind)
{
  switch (kind) {
    case CLI_FAULT_KIND_NONE: return "none";
    case CLI_FAULT_KIND_CPU_STALL: return "cpu-stall";
    case CLI_FAULT_KIND_CLOCK_SKEW: return "clock-skew";
    case CLI_FAULT_KIND_CLOCK_JITTER: return "clock-jitter";
    case CLI_FAULT_KIND_WIRE_THROTTLE: return "wire-throttle";
    case CLI_FAULT_KIND_WIRE_STALL: return "wire-stall";
    case CLI_FAULT_KIND_WIRE_RESET: return "wire-reset";
    case CLI_FAULT_KIND_MIC_SHORT: return "mic-short";
    case CLI_FAULT_KIND_MIC_CLIP: return "mic-clip";
  }
  return "unknown";
}

/** The kind a serialised name denotes; NONE when nothing matches. */
static enum cli_fault_kind kind_from_name(const char *name, size_t length)
{
  static const enum cli_fault_kind kinds[] = {
      CLI_FAULT_KIND_CPU_STALL,     CLI_FAULT_KIND_CLOCK_SKEW,
      CLI_FAULT_KIND_CLOCK_JITTER,  CLI_FAULT_KIND_WIRE_THROTTLE,
      CLI_FAULT_KIND_WIRE_STALL,    CLI_FAULT_KIND_WIRE_RESET,
      CLI_FAULT_KIND_MIC_SHORT,     CLI_FAULT_KIND_MIC_CLIP};
  size_t index;
  assert(name != NULL);
  for (index = 0U; index < sizeof(kinds) / sizeof(kinds[0]); index++) {
    const char *candidate = cli_fault_kind_name(kinds[index]);
    if (strlen(candidate) == length && strncmp(candidate, name, length) == 0) {
      return kinds[index];
    }
  }
  return CLI_FAULT_KIND_NONE;
}

void cli_fault_schedule_clear(struct cli_fault_schedule *schedule)
{
  if (schedule == NULL) return;
  memset(schedule, 0, sizeof(*schedule));
  schedule->empty = true;
}

/** Append one episode, refusing rather than truncating when full. */
static enum cli_fault_schedule_status push_episode(
    struct cli_fault_schedule *schedule,
    enum cli_fault_kind kind,
    uint64_t at_ms,
    uint32_t duration_ms,
    uint32_t magnitude)
{
  struct cli_fault_episode *episode;
  assert(schedule != NULL);
  if (schedule->episode_count >= CLI_FAULT_SCHEDULE_MAX_EPISODES) {
    return CLI_FAULT_SCHEDULE_ERR_FULL;
  }
  episode = &schedule->episodes[schedule->episode_count++];
  episode->kind = kind;
  episode->at_ms = at_ms;
  episode->duration_ms = duration_ms;
  episode->magnitude = magnitude;
  schedule->empty = false;
  return CLI_FAULT_SCHEDULE_OK;
}

/**
 * How many episodes a per-minute rate produces over the session.
 *
 * Deliberately NOT clamped. An earlier version capped this per kind, which is
 * exactly the silent truncation the header promises never to do: a recipe
 * asking for more adversity than a schedule can hold would have quietly run
 * with less, and a clean result would have been believed. Overflow is
 * `scatter`'s to report, and it reports ERR_FULL.
 */
static uint32_t episodes_for_rate(uint64_t session_ms, uint32_t per_minute)
{
  return (uint32_t)((uint64_t)per_minute * session_ms /
                    (uint64_t)MS_PER_MINUTE);
}

/**
 * Scatter `count` bounded episodes of one kind across the session.
 *
 * `window_ms` of zero means the drawn value IS the duration, which is what a
 * stall or a throttle wants. A non-zero window means the episode lasts that
 * long and the drawn value is its MAGNITUDE — which is what an instantaneous
 * fault like a clock step wants, since "how far back" and "for how long" are
 * different questions and only one of them has an answer.
 *
 * Two draws per episode either way, so the draw order stays fixed whichever
 * shape a kind takes.
 */
static enum cli_fault_schedule_status scatter(
    struct cli_fault_schedule *schedule,
    struct prng *prng,
    enum cli_fault_kind kind,
    uint32_t count,
    uint32_t max_value,
    uint32_t window_ms)
{
  uint32_t index;
  assert(schedule != NULL && prng != NULL);
  for (index = 0U; index < count; index++) {
    uint64_t at_ms = prng_below(prng, schedule->session_ms);
    uint64_t value =
        max_value == 0U ? 0U : prng_below(prng, (uint64_t)max_value) + 1U;
    enum cli_fault_schedule_status status =
        window_ms == 0U
            ? push_episode(schedule, kind, at_ms, (uint32_t)value, 0U)
            : push_episode(schedule, kind, at_ms, window_ms, (uint32_t)value);
    if (status != CLI_FAULT_SCHEDULE_OK) return status;
  }
  return CLI_FAULT_SCHEDULE_OK;
}

/** Order episodes by start, so consumers walk with a cursor and never search. */
static int compare_episodes(const void *left, const void *right)
{
  const struct cli_fault_episode *a = (const struct cli_fault_episode *)left;
  const struct cli_fault_episode *b = (const struct cli_fault_episode *)right;
  if (a->at_ms < b->at_ms) return -1;
  return a->at_ms > b->at_ms ? 1 : 0;
}

/** Draw the per-frame fates and the hold each REORDER uses. */
static void draw_fates(
    struct cli_fault_schedule *schedule,
    struct prng *prng,
    const struct cli_fault_recipe *recipe)
{
  size_t slot;
  assert(schedule != NULL && prng != NULL && recipe != NULL);
  for (slot = 0U; slot < CLI_FAULT_SCHEDULE_FATE_SLOTS; slot++) {
    enum cli_frame_fate fate = CLI_FRAME_FATE_DELIVER;
    if (recipe->frame_loss_one_in > 0U &&
        prng_below(prng, recipe->frame_loss_one_in) == 0U) {
      fate = CLI_FRAME_FATE_DROP;
    } else if (
        recipe->frame_duplicate_one_in > 0U &&
        prng_below(prng, recipe->frame_duplicate_one_in) == 0U) {
      fate = CLI_FRAME_FATE_DUPLICATE;
    } else if (
        recipe->frame_reorder_one_in > 0U &&
        prng_below(prng, recipe->frame_reorder_one_in) == 0U) {
      fate = CLI_FRAME_FATE_REORDER;
    }
    schedule->fates[slot] = (uint8_t)fate;
    if (fate != CLI_FRAME_FATE_DELIVER) schedule->empty = false;
  }
  for (slot = 0U; slot < CLI_FAULT_SCHEDULE_FATE_SLOTS; slot++) {
    uint64_t hold = prng_below(prng, CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD) + 1U;
    schedule->reorder_hold[slot] = (uint8_t)hold;
  }
}

/** The knobs that run for the whole session rather than in bursts. */
static enum cli_fault_schedule_status draw_spanning(
    struct cli_fault_schedule *schedule, const struct cli_fault_recipe *recipe)
{
  enum cli_fault_schedule_status status = CLI_FAULT_SCHEDULE_OK;
  assert(schedule != NULL && recipe != NULL);
  if (recipe->clock_jitter_ms > 0U) {
    status = push_episode(
        schedule, CLI_FAULT_KIND_CLOCK_JITTER, 0U,
        (uint32_t)schedule->session_ms, recipe->clock_jitter_ms);
    if (status != CLI_FAULT_SCHEDULE_OK) return status;
  }
  if (recipe->wire_throttle_fps > 0U) {
    status = push_episode(
        schedule, CLI_FAULT_KIND_WIRE_THROTTLE, 0U,
        (uint32_t)schedule->session_ms, recipe->wire_throttle_fps);
    if (status != CLI_FAULT_SCHEDULE_OK) return status;
  }
  if (recipe->mic_short_one_in > 0U) {
    status = push_episode(
        schedule, CLI_FAULT_KIND_MIC_SHORT, 0U, (uint32_t)schedule->session_ms,
        recipe->mic_short_one_in);
    if (status != CLI_FAULT_SCHEDULE_OK) return status;
  }
  if (!recipe->mic_clip) return CLI_FAULT_SCHEDULE_OK;
  return push_episode(
      schedule, CLI_FAULT_KIND_MIC_CLIP, 0U, (uint32_t)schedule->session_ms, 0U);
}

enum cli_fault_schedule_status cli_fault_schedule_generate(
    struct cli_fault_schedule *schedule,
    uint64_t seed,
    const struct cli_fault_recipe *recipe)
{
  struct prng prng;
  enum cli_fault_schedule_status status;
  if (schedule == NULL || recipe == NULL) return CLI_FAULT_SCHEDULE_ERR_ARG;
  if (recipe->session_ms == 0U) return CLI_FAULT_SCHEDULE_ERR_RANGE;

  cli_fault_schedule_clear(schedule);
  schedule->seed = seed;
  schedule->session_ms = recipe->session_ms;
  /* xorshift64* is dead at zero; a caller asking for seed 0 gets a real one. */
  prng.state = seed == 0U ? 0x9E3779B97F4A7C15ULL : seed;

  status = scatter(
      schedule, &prng, CLI_FAULT_KIND_CPU_STALL,
      episodes_for_rate(recipe->session_ms, recipe->cpu_stalls_per_minute),
      recipe->cpu_stall_max_ms, 0U);
  if (status != CLI_FAULT_SCHEDULE_OK) return status;

  status = scatter(
      schedule, &prng, CLI_FAULT_KIND_CLOCK_SKEW,
      episodes_for_rate(recipe->session_ms, recipe->clock_skews_per_minute),
      recipe->clock_skew_max_ms, (uint32_t)SKEW_WINDOW_MS);
  if (status != CLI_FAULT_SCHEDULE_OK) return status;

  status = scatter(
      schedule, &prng, CLI_FAULT_KIND_WIRE_STALL,
      episodes_for_rate(recipe->session_ms, recipe->wire_stalls_per_minute),
      recipe->wire_stall_max_ms, 0U);
  if (status != CLI_FAULT_SCHEDULE_OK) return status;

  status = scatter(
      schedule, &prng, CLI_FAULT_KIND_WIRE_RESET,
      recipe->wire_resets_per_session, 0U, 0U);
  if (status != CLI_FAULT_SCHEDULE_OK) return status;

  status = draw_spanning(schedule, recipe);
  if (status != CLI_FAULT_SCHEDULE_OK) return status;

  draw_fates(schedule, &prng, recipe);
  qsort(
      schedule->episodes, schedule->episode_count,
      sizeof(schedule->episodes[0]), compare_episodes);
  return CLI_FAULT_SCHEDULE_OK;
}

bool cli_fault_schedule_active(
    const struct cli_fault_schedule *schedule,
    enum cli_fault_kind kind,
    uint64_t elapsed_ms,
    uint32_t *magnitude)
{
  size_t index;
  if (schedule == NULL) return false;
  for (index = 0U; index < schedule->episode_count; index++) {
    const struct cli_fault_episode *episode = &schedule->episodes[index];
    if (episode->kind != kind) continue;
    if (elapsed_ms < episode->at_ms) break; /* sorted: none later can match */
    if (elapsed_ms >= episode->at_ms + episode->duration_ms) continue;
    if (magnitude != NULL) *magnitude = episode->magnitude;
    return true;
  }
  return false;
}

enum cli_frame_fate cli_fault_schedule_fate(
    const struct cli_fault_schedule *schedule,
    uint32_t sequence,
    uint32_t *hold_frames)
{
  size_t slot;
  enum cli_frame_fate fate;
  if (schedule == NULL) return CLI_FRAME_FATE_DELIVER;
  slot = (size_t)(sequence % CLI_FAULT_SCHEDULE_FATE_SLOTS);
  fate = (enum cli_frame_fate)schedule->fates[slot];
  /*
   * A caller with nowhere to hold a frame reads REORDER as DELIVER. Honest
   * degradation: a rig that cannot hold a frame back must not report that it
   * did, or the run claims to have tested something it never ran.
   */
  if (fate == CLI_FRAME_FATE_REORDER && hold_frames == NULL) {
    return CLI_FRAME_FATE_DELIVER;
  }
  if (hold_frames != NULL) *hold_frames = schedule->reorder_hold[slot];
  return fate;
}

/** Write one run of `count` digits, for the fate and hold tables. */
static bool write_digits(FILE *out, const uint8_t *values, size_t count)
{
  size_t index;
  assert(out != NULL && values != NULL);
  for (index = 0U; index < count; index++) {
    if (fputc('0' + (int)values[index], out) == EOF) return false;
  }
  return true;
}

enum cli_fault_schedule_status cli_fault_schedule_write_json(
    const struct cli_fault_schedule *schedule, FILE *out)
{
  size_t index;
  if (schedule == NULL || out == NULL) return CLI_FAULT_SCHEDULE_ERR_ARG;
  if (fprintf(
          out, "{\"seed\":%" PRIu64 ",\"sessionMs\":%" PRIu64 ",\"episodes\":[",
          schedule->seed, schedule->session_ms) < 0) {
    return CLI_FAULT_SCHEDULE_ERR_IO;
  }
  for (index = 0U; index < schedule->episode_count; index++) {
    const struct cli_fault_episode *episode = &schedule->episodes[index];
    if (fprintf(
            out,
            "%s{\"kind\":\"%s\",\"atMs\":%" PRIu64 ",\"durationMs\":%" PRIu32
            ",\"magnitude\":%" PRIu32 "}",
            index == 0U ? "" : ",", cli_fault_kind_name(episode->kind),
            episode->at_ms, episode->duration_ms,
            episode->magnitude) < 0) {
      return CLI_FAULT_SCHEDULE_ERR_IO;
    }
  }
  /*
   * One digit per slot for each table. Both are written, not just the fates:
   * a REORDER's hold is drawn alongside its fate, so a replay missing the
   * holds would hold every frame for one frame and quietly be a different
   * experiment wearing the same seed.
   */
  if (fputs("],\"fates\":\"", out) == EOF) return CLI_FAULT_SCHEDULE_ERR_IO;
  if (!write_digits(out, schedule->fates, CLI_FAULT_SCHEDULE_FATE_SLOTS)) {
    return CLI_FAULT_SCHEDULE_ERR_IO;
  }
  if (fputs("\",\"holds\":\"", out) == EOF) return CLI_FAULT_SCHEDULE_ERR_IO;
  if (!write_digits(
          out, schedule->reorder_hold, CLI_FAULT_SCHEDULE_FATE_SLOTS)) {
    return CLI_FAULT_SCHEDULE_ERR_IO;
  }
  if (fputs("\"}\n", out) == EOF) return CLI_FAULT_SCHEDULE_ERR_IO;
  return CLI_FAULT_SCHEDULE_OK;
}

/** Step `in` past whitespace to the next non-space, returning it. */
static int skip_space(FILE *in)
{
  int c;
  assert(in != NULL);
  do {
    c = fgetc(in);
  } while (c == ' ' || c == '\n' || c == '\t' || c == '\r');
  return c;
}

/** Consume `literal` exactly, ignoring whitespace between its characters. */
static bool expect(FILE *in, const char *literal)
{
  size_t index;
  assert(in != NULL && literal != NULL);
  for (index = 0U; literal[index] != '\0'; index++) {
    if (skip_space(in) != literal[index]) return false;
  }
  return true;
}

/** Consume `label` then one unsigned decimal. */
static bool read_labelled(FILE *in, const char *label, uint64_t *value)
{
  assert(in != NULL && label != NULL && value != NULL);
  if (!expect(in, label)) return false;
  return fscanf(in, "%" SCNu64, value) == 1;
}

/** Read one episode object; false on anything this build cannot represent. */
static bool read_episode(FILE *in, struct cli_fault_episode *episode)
{
  char name[32];
  uint64_t at_ms = 0U;
  uint64_t duration = 0U;
  uint64_t magnitude = 0U;
  assert(in != NULL && episode != NULL);
  if (fscanf(in, " {\"kind\":\"%31[^\"]\"", name) != 1) return false;
  episode->kind = kind_from_name(name, strlen(name));
  if (episode->kind == CLI_FAULT_KIND_NONE) return false;
  if (!read_labelled(in, ",\"atMs\":", &at_ms)) return false;
  if (!read_labelled(in, ",\"durationMs\":", &duration)) return false;
  if (!read_labelled(in, ",\"magnitude\":", &magnitude)) return false;
  if (skip_space(in) != '}') return false;
  episode->at_ms = at_ms;
  episode->duration_ms = (uint32_t)duration;
  episode->magnitude = (uint32_t)magnitude;
  return true;
}

/** Read one digit table of FATE_SLOTS entries, bounded by `max`. */
static bool read_digits(FILE *in, uint8_t *values, uint8_t max)
{
  size_t index;
  assert(in != NULL && values != NULL);
  for (index = 0U; index < CLI_FAULT_SCHEDULE_FATE_SLOTS; index++) {
    int c = fgetc(in);
    if (c < '0' || c > '0' + (int)max) return false;
    values[index] = (uint8_t)(c - '0');
  }
  return fgetc(in) == '"';
}

/** Read the episode array, assuming the opening bracket is consumed. */
static enum cli_fault_schedule_status read_episodes(
    FILE *in, struct cli_fault_schedule *schedule)
{
  assert(in != NULL && schedule != NULL);
  for (;;) {
    int c = skip_space(in);
    if (c == ']') return CLI_FAULT_SCHEDULE_OK;
    if (c == ',') continue;
    if (c != '{') return CLI_FAULT_SCHEDULE_ERR_MALFORMED;
    if (ungetc(c, in) == EOF) return CLI_FAULT_SCHEDULE_ERR_MALFORMED;
    if (schedule->episode_count >= CLI_FAULT_SCHEDULE_MAX_EPISODES) {
      return CLI_FAULT_SCHEDULE_ERR_FULL;
    }
    if (!read_episode(in, &schedule->episodes[schedule->episode_count])) {
      return CLI_FAULT_SCHEDULE_ERR_MALFORMED;
    }
    schedule->episode_count++;
    schedule->empty = false;
  }
}

enum cli_fault_schedule_status cli_fault_schedule_read_json(
    struct cli_fault_schedule *schedule, FILE *in)
{
  uint64_t seed = 0U;
  uint64_t session_ms = 0U;
  enum cli_fault_schedule_status status;
  size_t index;
  if (schedule == NULL || in == NULL) return CLI_FAULT_SCHEDULE_ERR_ARG;
  cli_fault_schedule_clear(schedule);

  if (!read_labelled(in, "{\"seed\":", &seed) ||
      !read_labelled(in, ",\"sessionMs\":", &session_ms) ||
      !expect(in, ",\"episodes\":[")) {
    return CLI_FAULT_SCHEDULE_ERR_MALFORMED;
  }
  schedule->seed = seed;
  schedule->session_ms = session_ms;

  status = read_episodes(in, schedule);
  if (status != CLI_FAULT_SCHEDULE_OK) return status;

  if (!expect(in, ",\"fates\":\"") ||
      !read_digits(in, schedule->fates, CLI_FRAME_FATE_REORDER)) {
    return CLI_FAULT_SCHEDULE_ERR_MALFORMED;
  }
  if (!expect(in, ",\"holds\":\"") ||
      !read_digits(
          in, schedule->reorder_hold, CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD)) {
    return CLI_FAULT_SCHEDULE_ERR_MALFORMED;
  }
  for (index = 0U; index < CLI_FAULT_SCHEDULE_FATE_SLOTS; index++) {
    if (schedule->fates[index] != CLI_FRAME_FATE_DELIVER) {
      schedule->empty = false;
    }
  }
  return CLI_FAULT_SCHEDULE_OK;
}
