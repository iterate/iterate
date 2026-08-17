#include "cli_paced_sink.h"

#include "cli_speaker.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice_playback_clock.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * These tests exist because the host rig could not fail the way the device
 * fails. Its speaker is an fwrite: it accepts every frame instantly, is never
 * full, and never runs dry, so the whole family of defects that only appear
 * when the consumer is WAITING was unreachable. The rig below is the CLI's
 * own playback loop — the same 5 ms cooperative iteration, the same 20 ms
 * software deadline, the same four-frame host-stall forgiveness, the same
 * ring and the same playback-clock policy — run twice over a virtual clock
 * with only the sink swapped. Everything asserted here is deterministic:
 * nothing in the rig reads a real clock.
 */

enum {
  /* CLI_MAIN_LOOP_MS: the cooperative loop's nanosleep between iterations. */
  RIG_LOOP_MS = 5,
  /* CLI_MAIN_HOST_STALL_FRAMES: past this the loop forgives what it missed. */
  RIG_HOST_STALL_FRAMES = 4,
  RIG_US_PER_MS = 1000,
  /* One frame every 20 ms is what the board's converter actually consumes. */
  RIG_CONVERTER_FPS = 1000 / ITERATE_KIT_VOICE_FRAME_MS,
  RIG_LEAD_FRAMES = CLI_PACED_SINK_DEFAULT_DEPTH_FRAMES,
};

/** One rig run: the schedule, and which sink the reader writes into. */
struct rig_plan {
  uint32_t run_ms;
  /*
   * The sender ships a whole answer as fast as the wire takes it, so the ring
   * is primed once and stays full. That is deliberate here: with audio always
   * available, neither run can starve for want of a downlink, and any
   * difference between them is attributable to the sink alone.
   */
  uint32_t answer_frames;
  /** One scheduler preemption: when the loop disappears, and for how long. */
  uint32_t stall_at_ms;
  uint32_t stall_ms;
  /** Zero is the file sink that always keeps up; 50 is the converter. */
  uint32_t pace_fps;
};

/** What the run would have been able to report about itself. */
struct rig_result {
  uint32_t frames_played;
  /** Frames the WAV would contain: played, concealed, and converter silence. */
  uint32_t frames_recorded;
  uint32_t conceal_frames;
  /** Due ticks that found nothing to play. */
  uint32_t dry_ticks;
  uint32_t converter_underruns;
  uint32_t converter_refusals;
  /** Frames the converter actually emitted, real or silent. */
  uint32_t converter_emitted;
  uint32_t queued_ms_at_end;
};

struct rig {
  struct cli_paced_sink sink;
  struct iterate_kit_voice_playback_clock clock;
  uint64_t next_due_ms;
  struct rig_result result;
};

/* The ring is 960 KiB of device profile and never belongs on a stack. */
static struct cli_speaker rig_speaker;
static struct rig rig_state;
static uint8_t rig_frame[ITERATE_KIT_VOICE_FRAME_BYTES];

/* Notes `frames` on the true playback timeline the WAV is supposed to be. */
static void rig_record(struct rig *rig, uint32_t frames);

/* Hands the whole answer to the ring at once, as the sender now does. */
static void rig_deliver_answer(uint32_t frames);

/* One feed attempt. False means the ring could not satisfy the consumer. */
static bool rig_feed_once(struct rig *rig, uint64_t now_ms);

/* Mirrors cli_main_poll_playback, including its stall forgiveness. */
static void rig_poll_playback(struct rig *rig, uint64_t now_ms);

/* Milliseconds the virtual clock jumps after this iteration. */
static uint32_t rig_step_ms(const struct rig_plan *plan, uint64_t now_ms);

/* Runs one whole plan and reports what its operator would have seen. */
static void rig_run(const struct rig_plan *plan, struct rig_result *out);

/*
 * THE DELIVERABLE.
 *
 * Same reader, same ring, same audio, same virtual clock, same 200 ms
 * scheduler preemption. Only the sink differs.
 *
 * Against the file sink the run is immaculate: every frame it offered was
 * accepted, no counter moved, and the only trace of 200 ms of missing audio
 * is that the recording came out 180 ms shorter than the call — which no
 * listener and no assertion has ever noticed, because a WAV carries no
 * timestamps. That is precisely how a spin-on-empty latch, a concealment debt
 * that deleted words, and a response-complete treated as a barge-in all
 * survived a rig that ran for hours.
 *
 * Against the converter the same preemption is what it is on the board: the
 * DMA lead covers the first 80 ms and the remaining 120 ms is silence the
 * listener heard, counted as such, and written into the recording so the
 * recording finally spans the call.
 */
static void a_paced_converter_starves_where_a_file_sink_never_could(void)
{
  struct rig_plan plan = {
    .run_ms = 3000U,
    .answer_frames = 200U,
    .stall_at_ms = 1000U,
    .stall_ms = 200U,
    .pace_fps = 0U,
  };
  struct rig_result file_sink = {0};
  rig_run(&plan, &file_sink);
  plan.pace_fps = RIG_CONVERTER_FPS;
  struct rig_result converter = {0};
  rig_run(&plan, &converter);
  /*
   * Printed rather than only asserted: the two recording lengths side by side
   * are the whole argument for this module, and a reader of a CI log should
   * not have to reconstruct them from which assertion did not fire.
   */
  (void)fprintf(
      stderr,
      "%u ms call: file sink recorded %u ms and reported nothing; converter "
      "recorded %u ms and reported %u ms of silence\n",
      plan.run_ms, file_sink.frames_recorded * ITERATE_KIT_VOICE_FRAME_MS,
      converter.frames_recorded * ITERATE_KIT_VOICE_FRAME_MS,
      converter.converter_underruns * ITERATE_KIT_VOICE_FRAME_MS);

  /*
   * The control. Both runs had 200 frames of answer sitting in the ring the
   * whole time, so neither reader ever waited on the downlink. Without this,
   * a difference below could be a difference in how much audio was available
   * rather than in when it was allowed to be consumed.
   */
  assert(file_sink.dry_ticks == 0U && converter.dry_ticks == 0U);
  assert(file_sink.conceal_frames == 0U && converter.conceal_frames == 0U);
  assert(file_sink.queued_ms_at_end > 0U && converter.queued_ms_at_end > 0U);

  /* The blind spot, reproduced: nothing about the file-backed run is wrong. */
  assert(file_sink.converter_underruns == 0U);
  assert(file_sink.converter_refusals == 0U);
  /* Except its evidence, which is a call's worth of audio minus the stall. */
  assert(file_sink.frames_recorded * ITERATE_KIT_VOICE_FRAME_MS + 150U <
         plan.run_ms);

  /* Starvation is now reachable, and its size is the stall past the DMA lead. */
  assert(converter.converter_underruns > 0U);
  assert(converter.converter_underruns * ITERATE_KIT_VOICE_FRAME_MS ==
         plan.stall_ms - RIG_LEAD_FRAMES * ITERATE_KIT_VOICE_FRAME_MS);
  /* And the recording now spans the call it claims to be a recording of. */
  assert(converter.frames_recorded * ITERATE_KIT_VOICE_FRAME_MS >= plan.run_ms);
  /*
   * The converter's own timeline is wall clock, to within the one frame whose
   * boundary falls after the last iteration. A sink that drifted from this
   * would be a second unmodelled clock and worse than none.
   */
  assert(converter.converter_emitted * ITERATE_KIT_VOICE_FRAME_MS <=
         plan.run_ms);
  assert(converter.converter_emitted * ITERATE_KIT_VOICE_FRAME_MS +
             ITERATE_KIT_VOICE_FRAME_MS >= plan.run_ms);
}

/*
 * The other half of "paced": a consumer that has fallen behind may not make
 * it up by writing faster. The file sink absorbed catch-up bursts silently,
 * which is why the CLI's four-frame forgiveness looked harmless — on the
 * board those frames are refused by hardware and the audio they would have
 * carried is simply late.
 */
static void the_converter_refuses_a_caller_that_tries_to_run_ahead(void)
{
  struct cli_paced_sink sink;
  const struct cli_paced_sink_config config = {
    .frames_per_second = RIG_CONVERTER_FPS,
    .depth_frames = 0U,
  };
  assert(cli_paced_sink_configure(&sink, &config) == CLI_PACED_SINK_OK);
  assert(cli_paced_sink_paced(&sink));
  assert(cli_paced_sink_advance(&sink, 0U) == 0U);
  for (uint32_t index = 0U; index < RIG_LEAD_FRAMES; ++index) {
    assert(cli_paced_sink_ready(&sink));
    assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_OK);
  }
  assert(!cli_paced_sink_ready(&sink));
  assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_ERR_BUSY);
  assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_ERR_BUSY);
  assert(sink.refused_frames == 2U);
  assert(sink.underrun_frames == 0U);

  /* Exactly one period buys room for exactly one frame. Never two. */
  assert(cli_paced_sink_advance(
             &sink, ITERATE_KIT_VOICE_FRAME_MS * RIG_US_PER_MS) == 0U);
  assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_OK);
  assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_ERR_BUSY);
}

/*
 * A monotonic clock read twice in one loop iteration can still come back one
 * millisecond earlier on this hardware. The device's arithmetic subtracted
 * those stamps unsigned, and the resulting 49-day elapsed time tripped every
 * supervision deadline at once: a healthy call was torn down and rebuilt 42
 * times in three minutes. A model of the converter that made the same mistake
 * would answer that question with several million frames of invented silence.
 */
static void a_stamp_that_goes_backwards_neither_drains_nor_underruns(void)
{
  struct cli_paced_sink sink;
  const struct cli_paced_sink_config config = {
    .frames_per_second = RIG_CONVERTER_FPS,
    .depth_frames = 0U,
  };
  assert(cli_paced_sink_configure(&sink, &config) == CLI_PACED_SINK_OK);
  const uint64_t start_us = 1000U * RIG_US_PER_MS;
  assert(cli_paced_sink_advance(&sink, start_us) == 0U);
  assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_OK);
  assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_OK);

  assert(cli_paced_sink_advance(&sink, start_us - RIG_US_PER_MS) == 0U);
  assert(sink.skew_stamps == 1U);
  assert(sink.underrun_frames == 0U);
  assert(sink.drained_frames == 0U);
  assert(sink.queued_frames == 2U);

  /* The schedule the skewed stamp did not disturb is still the real one. */
  assert(cli_paced_sink_advance(
             &sink, start_us + ITERATE_KIT_VOICE_FRAME_MS * RIG_US_PER_MS) ==
         0U);
  assert(sink.drained_frames == 1U);
}

/*
 * A laptop that slept returns a stamp hours later. Replaying every 20 ms
 * boundary in between would report a quarter of a million underruns for a
 * closed lid, which is indistinguishable from a catastrophic fault and would
 * make every unattended report worthless. The gap has to stay visible without
 * being dressed up as audio nobody heard.
 */
static void a_suspended_host_resyncs_instead_of_inventing_hours_of_silence(void)
{
  struct cli_paced_sink sink;
  const struct cli_paced_sink_config config = {
    .frames_per_second = RIG_CONVERTER_FPS,
    .depth_frames = 0U,
  };
  assert(cli_paced_sink_configure(&sink, &config) == CLI_PACED_SINK_OK);
  assert(cli_paced_sink_advance(&sink, 0U) == 0U);
  const uint64_t four_hours_us = 4ULL * 3600ULL * 1000ULL * RIG_US_PER_MS;
  assert(cli_paced_sink_advance(&sink, four_hours_us) ==
         CLI_PACED_SINK_MAX_DRAIN_FRAMES);
  assert(sink.resyncs == 1U);
  /* And the model is back on a schedule anchored to the stamp it was given. */
  assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_OK);
  assert(cli_paced_sink_advance(&sink, four_hours_us) == 0U);
}

/*
 * The knob defaults to off, and off has to be indistinguishable from the file
 * sink this wraps or nobody will leave the code in. An unpaced converter
 * never asks for a frame, never refuses one, and never reports silence.
 */
static void an_unpaced_converter_is_exactly_the_file_sink_it_replaces(void)
{
  struct cli_paced_sink sink;
  const struct cli_paced_sink_config config = {
    .frames_per_second = 0U,
    .depth_frames = 0U,
  };
  assert(cli_paced_sink_configure(&sink, &config) == CLI_PACED_SINK_OK);
  assert(!cli_paced_sink_paced(&sink));
  assert(!cli_paced_sink_ready(&sink));
  assert(cli_paced_sink_advance(&sink, 0U) == 0U);
  assert(cli_paced_sink_advance(&sink, UINT64_MAX) == 0U);
  for (uint32_t index = 0U; index < 1000U; ++index) {
    assert(cli_paced_sink_offer(&sink) == CLI_PACED_SINK_OK);
  }
  assert(sink.accepted_frames == 1000U);
  assert(sink.refused_frames == 0U);
  assert(sink.underrun_frames == 0U);
}

/*
 * A rate nobody meant must fail loudly at configure. Clamped, a mistyped
 * 5000 would silently become the device's 50 and every number in the report
 * would describe a converter that was never asked for.
 */
static void an_impossible_knob_is_refused_rather_than_clamped(void)
{
  struct cli_paced_sink sink;
  struct cli_paced_sink_config config = {
    .frames_per_second = CLI_PACED_SINK_MAX_FRAMES_PER_SECOND + 1U,
    .depth_frames = 0U,
  };
  assert(cli_paced_sink_configure(&sink, &config) == CLI_PACED_SINK_ERR_ARG);
  config.frames_per_second = RIG_CONVERTER_FPS;
  config.depth_frames = CLI_PACED_SINK_MAX_DEPTH_FRAMES + 1U;
  assert(cli_paced_sink_configure(&sink, &config) == CLI_PACED_SINK_ERR_ARG);
  assert(cli_paced_sink_configure(NULL, &config) == CLI_PACED_SINK_ERR_ARG);
  assert(cli_paced_sink_configure(&sink, NULL) == CLI_PACED_SINK_ERR_ARG);
  assert(cli_paced_sink_offer(NULL) == CLI_PACED_SINK_ERR_ARG);
  assert(cli_paced_sink_advance(NULL, 0U) == 0U);
  assert(!cli_paced_sink_paced(NULL));
  assert(strcmp(cli_paced_sink_status_name(CLI_PACED_SINK_ERR_BUSY),
                "converter-full") == 0);
}

static void rig_record(struct rig *rig, uint32_t frames)
{
  assert(rig != NULL);
  rig->result.frames_recorded += frames;
}

static void rig_deliver_answer(uint32_t frames)
{
  for (uint32_t index = 0U; index < frames; ++index) {
    uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
    memset(pcm, (uint8_t)(index + 1U), sizeof(pcm));
    assert(cli_speaker_write(&rig_speaker, pcm, sizeof(pcm)) ==
           CLI_SPEAKER_OK);
  }
}

static bool rig_feed_once(struct rig *rig, uint64_t now_ms)
{
  assert(rig != NULL);
  if (!iterate_kit_voice_playback_clock_ready(
          &rig->clock, (uint32_t)rig_speaker.used)) {
    ++rig->result.dry_ticks;
    return false;
  }
  if (cli_speaker_read(&rig_speaker, rig_frame, sizeof(rig_frame)) !=
      CLI_SPEAKER_OK) {
    ++rig->result.dry_ticks;
    if (iterate_kit_voice_playback_clock_empty(&rig->clock, now_ms) ==
        ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) {
      ++rig->result.conceal_frames;
      rig_record(rig, 1U);
      (void)cli_paced_sink_offer(&rig->sink);
    }
    return false;
  }
  if (iterate_kit_voice_playback_clock_frame(
          &rig->clock, (uint32_t)rig_speaker.used,
          0U, now_ms) != ITERATE_KIT_VOICE_PLAYBACK_PLAY) {
    return false;
  }
  ++rig->result.frames_played;
  rig_record(rig, 1U);
  (void)cli_paced_sink_offer(&rig->sink);
  return true;
}

static void rig_poll_playback(struct rig *rig, uint64_t now_ms)
{
  assert(rig != NULL);
  if (rig->next_due_ms == 0U) rig->next_due_ms = now_ms;
  if (now_ms < rig->next_due_ms) return;
  rig->next_due_ms += ITERATE_KIT_VOICE_FRAME_MS;
  const uint64_t stall_limit =
      rig->next_due_ms + ITERATE_KIT_VOICE_FRAME_MS * RIG_HOST_STALL_FRAMES;
  if (now_ms > stall_limit) {
    rig->next_due_ms = now_ms + ITERATE_KIT_VOICE_FRAME_MS;
  }
  /*
   * The first frame is unconditional, which is exactly what the loop did
   * before a converter existed; the continuation is the converter still
   * asking. An unpaced sink never asks, so this runs once and the default
   * path is unchanged.
   */
  do {
    if (!rig_feed_once(rig, now_ms)) return;
  } while (cli_paced_sink_ready(&rig->sink));
}

static uint32_t rig_step_ms(const struct rig_plan *plan, uint64_t now_ms)
{
  assert(plan != NULL);
  if (plan->stall_ms != 0U && now_ms == plan->stall_at_ms) {
    return plan->stall_ms;
  }
  return RIG_LOOP_MS;
}

static void rig_run(const struct rig_plan *plan, struct rig_result *out)
{
  assert(plan != NULL && out != NULL);
  memset(&rig_state, 0, sizeof(rig_state));
  cli_speaker_clear(&rig_speaker);
  iterate_kit_voice_playback_clock_init(&rig_state.clock);
  const struct cli_paced_sink_config config = {
    .frames_per_second = plan->pace_fps,
    .depth_frames = 0U,
  };
  assert(cli_paced_sink_configure(&rig_state.sink, &config) ==
         CLI_PACED_SINK_OK);
  rig_deliver_answer(plan->answer_frames);
  uint64_t now_ms = 0U;
  while (now_ms < plan->run_ms) {
    rig_record(
        &rig_state,
        cli_paced_sink_advance(&rig_state.sink, now_ms * RIG_US_PER_MS));
    rig_poll_playback(&rig_state, now_ms);
    now_ms += rig_step_ms(plan, now_ms);
  }
  rig_state.result.converter_underruns = rig_state.sink.underrun_frames;
  rig_state.result.converter_refusals = rig_state.sink.refused_frames;
  rig_state.result.converter_emitted =
      rig_state.sink.drained_frames + rig_state.sink.underrun_frames;
  rig_state.result.queued_ms_at_end = cli_speaker_queued_ms(&rig_speaker);
  *out = rig_state.result;
}

int main(void)
{
  a_paced_converter_starves_where_a_file_sink_never_could();
  the_converter_refuses_a_caller_that_tries_to_run_ahead();
  a_stamp_that_goes_backwards_neither_drains_nor_underruns();
  a_suspended_host_resyncs_instead_of_inventing_hours_of_silence();
  an_unpaced_converter_is_exactly_the_file_sink_it_replaces();
  an_impossible_knob_is_refused_rather_than_clamped();
  return 0;
}
