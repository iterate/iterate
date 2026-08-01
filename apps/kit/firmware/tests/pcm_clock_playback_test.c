#include "iterate/kit/pcm_clock_playback.h"

#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/spsc_ring.h"
#include "stackchan_realtime_policy.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define TEST_ASSERT(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

enum {
  lane_capacity = 8,
  userspace_initial_lead_frames = 8,
  wire_samples = ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
  core_s3_dma_samples = 128,
};

struct fixture {
  struct iterate_kit_spsc_ring uplink_ring;
  struct iterate_kit_spsc_ring downlink_ring;
  struct iterate_kit_pcm_uplink_slot uplink_storage[lane_capacity];
  struct iterate_kit_pcm_downlink_slot downlink_storage[lane_capacity];
  size_t uplink_lengths[lane_capacity];
  size_t downlink_lengths[lane_capacity];
  struct iterate_kit_pcm_lane lane;
  struct iterate_kit_pcm_clock_playback playback;
  int16_t retained_frame[wire_samples];
};

static void initialise_with_limits(
    struct fixture *fixture,
    uint32_t maximum_frame_age_ms,
    size_t maximum_lane_items_per_render) {
  TEST_ASSERT(
      iterate_kit_spsc_ring_init(
          &fixture->uplink_ring,
          fixture->uplink_storage,
          sizeof(fixture->uplink_storage[0]),
          lane_capacity,
          fixture->uplink_lengths) == ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_spsc_ring_init(
          &fixture->downlink_ring,
          fixture->downlink_storage,
          sizeof(fixture->downlink_storage[0]),
          lane_capacity,
          fixture->downlink_lengths) == ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_pcm_lane_init(
          &fixture->lane,
          &fixture->uplink_ring,
          &fixture->downlink_ring) == ITERATE_KIT_OK);
  const struct iterate_kit_pcm_clock_playback_options options = {
    .lane = &fixture->lane,
    .retained_frame = fixture->retained_frame,
    .retained_frame_capacity = wire_samples,
    .maximum_frame_age_ms = maximum_frame_age_ms,
    .maximum_lane_items_per_render = maximum_lane_items_per_render,
  };
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_init(
          &fixture->playback, &options) == ITERATE_KIT_OK);
}

static void initialise(struct fixture *fixture) {
  initialise_with_limits(fixture, 100U, lane_capacity);
}

static void publish_frame(
    struct fixture *fixture,
    int16_t first_sample,
    uint64_t received_at_ms) {
  int16_t frame[wire_samples];
  for (size_t index = 0U; index < wire_samples; ++index) {
    frame[index] = (int16_t)(first_sample + (int16_t)index);
  }
  TEST_ASSERT(
      iterate_kit_pcm_lane_receive_downlink_at(
          &fixture->lane,
          ITERATE_KIT_PCM_MESSAGE_BINARY,
          true,
          sizeof(frame),
          0U,
          frame,
          sizeof(frame),
          received_at_ms) == ITERATE_KIT_OK);
}

static void publish_end(
    struct fixture *fixture, uint64_t received_at_ms) {
  TEST_ASSERT(
      iterate_kit_pcm_lane_receive_downlink_at(
          &fixture->lane,
          ITERATE_KIT_PCM_MESSAGE_BINARY,
          true,
          0U,
          0U,
          NULL,
          0U,
          received_at_ms) == ITERATE_KIT_OK);
}

/*
 * PCM v1 arrives in 320-sample messages while the proven CoreS3 DMA cadence
 * is 128 samples. Treating either size as a queue item produces a 20/8 ms beat
 * pattern. This least-common-period scenario proves the adapter preserves
 * exact order with only one retained wire frame, then consumes the ordered
 * response marker without inventing an underrun at the finite tail.
 */
static void reframes_wire_audio_into_clock_chunks_exactly(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  initialise(&fixture);
  for (size_t frame = 0U; frame < 5U; ++frame) {
    publish_frame(
        &fixture,
        (int16_t)(frame * wire_samples),
        100U + frame * 20U);
  }
  publish_end(&fixture, 200U);

  size_t expected_sample = 0U;
  bool observed_end = false;
  for (size_t chunk = 0U; chunk < 13U; ++chunk) {
    struct iterate_kit_pcm_clock_playback_result result;
    TEST_ASSERT(
        iterate_kit_pcm_clock_playback_render(
            &fixture.playback,
            200U,
            output,
            core_s3_dma_samples,
            &result) == ITERATE_KIT_OK);
    for (size_t index = 0U; index < result.content_samples; ++index) {
      TEST_ASSERT(output[index] == (int16_t)expected_sample);
      ++expected_sample;
    }
    for (size_t index = result.content_samples;
         index < core_s3_dma_samples;
         ++index) {
      TEST_ASSERT(output[index] == 0);
    }
    observed_end = observed_end || result.end_of_response;
  }

  TEST_ASSERT(expected_sample == 5U * wire_samples);
  TEST_ASSERT(observed_end);
  const struct iterate_kit_pcm_clock_playback_metrics *metrics =
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback);
  TEST_ASSERT(metrics->frames_acquired == 5U);
  TEST_ASSERT(metrics->frames_released == 5U);
  TEST_ASSERT(metrics->content_samples_rendered == 1600U);
  TEST_ASSERT(metrics->end_markers_consumed == 1U);
  TEST_ASSERT(metrics->end_padding_silence_samples == 64U);
  TEST_ASSERT(metrics->underrun_incidents == 0U);
  TEST_ASSERT(metrics->retained_samples == 0U);
  TEST_ASSERT(!metrics->response_active);
}

/*
 * Once response audio has begun, a missing next wire frame is a real delivery
 * hole rather than harmless idle. The hardware clock may never wait for the
 * network: finish the current 320 samples, write explicit silence for the
 * missing suffix, and let the first recovered frame start immediately on the
 * next 8 ms clock edge instead of preserving a debt to replay later.
 */
static void mid_response_gap_becomes_current_silence_not_backlog(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  initialise(&fixture);
  publish_frame(&fixture, 1000, 10U);

  for (size_t chunk = 0U; chunk < 3U; ++chunk) {
    struct iterate_kit_pcm_clock_playback_result result;
    TEST_ASSERT(
        iterate_kit_pcm_clock_playback_render(
            &fixture.playback,
            20U,
            output,
            core_s3_dma_samples,
            &result) == ITERATE_KIT_OK);
    if (chunk == 2U) {
      TEST_ASSERT(result.content_samples == 64U);
      TEST_ASSERT(result.silence_samples == 64U);
      for (size_t index = 64U; index < core_s3_dma_samples; ++index) {
        TEST_ASSERT(output[index] == 0);
      }
    }
  }

  publish_frame(&fixture, 5000, 30U);
  struct iterate_kit_pcm_clock_playback_result recovered;
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          30U,
          output,
          core_s3_dma_samples,
          &recovered) == ITERATE_KIT_OK);
  TEST_ASSERT(recovered.content_samples == core_s3_dma_samples);
  TEST_ASSERT(output[0] == 5000);
  TEST_ASSERT(output[core_s3_dma_samples - 1U] == 5127);

  const struct iterate_kit_pcm_clock_playback_metrics *metrics =
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback);
  TEST_ASSERT(metrics->underrun_incidents == 1U);
  TEST_ASSERT(metrics->underrun_silence_samples == 64U);
  TEST_ASSERT(metrics->retained_samples == 192U);
}

/*
 * A task stall can leave old server audio in the bounded lane even though the
 * socket itself is healthy. Replaying it makes the conversation accumulate
 * delay. Age belongs to each lane slot, so the clock adapter must discard old
 * complete frames and render the first current one in the same bounded call.
 */
static void stale_frames_are_purged_before_current_playback(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  initialise(&fixture);
  publish_frame(&fixture, 1000, 0U);
  publish_frame(&fixture, 2000, 20U);
  publish_frame(&fixture, 3000, 190U);

  struct iterate_kit_pcm_clock_playback_result result;
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          250U,
          output,
          core_s3_dma_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(result.content_samples == core_s3_dma_samples);
  TEST_ASSERT(result.receive_timing_valid);
  TEST_ASSERT(result.oldest_received_at_ms == 190U);
  TEST_ASSERT(output[0] == 3000);

  const struct iterate_kit_pcm_clock_playback_metrics *metrics =
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback);
  TEST_ASSERT(metrics->stale_frames_discarded == 2U);
  TEST_ASSERT(metrics->input_samples_discarded == 640U);
  TEST_ASSERT(metrics->maximum_receive_to_render_ms == 60U);
}

/*
 * The userspace bridge intentionally sends eight 20 ms frames as a finite
 * startup lead before pacing at the hardware rate. StackChan receives that
 * burst at essentially one instant, so its eighth frame is about 152 ms old
 * when the 8 ms CoreS3 clock first needs it. A freshness limit below that lead
 * creates a deterministic stale-discard/underrun pair even on a perfect
 * network. This cross-layer example exists because testing stale purging alone
 * cannot reveal a target policy that rejects valid, deliberately early audio.
 */
static void stackchan_accepts_the_userspace_startup_lead(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  size_t rendered_samples = 0U;
  initialise_with_limits(
      &fixture,
      STACKCHAN_MAXIMUM_DOWNLINK_FRAME_AGE_MS,
      lane_capacity);
  for (size_t frame = 0U; frame < userspace_initial_lead_frames; ++frame) {
    publish_frame(
        &fixture,
        (int16_t)(frame * wire_samples),
        1000U);
  }

  for (size_t chunk = 0U;
       chunk <
           (userspace_initial_lead_frames * wire_samples) /
               core_s3_dma_samples;
       ++chunk) {
    struct iterate_kit_pcm_clock_playback_result result;
    TEST_ASSERT(
        iterate_kit_pcm_clock_playback_render(
            &fixture.playback,
            1000U + chunk * 8U,
            output,
            core_s3_dma_samples,
            &result) == ITERATE_KIT_OK);
    rendered_samples += result.content_samples;
  }

  const struct iterate_kit_pcm_clock_playback_metrics *metrics =
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback);
  TEST_ASSERT(
      rendered_samples ==
      userspace_initial_lead_frames * wire_samples);
  TEST_ASSERT(metrics->stale_frames_discarded == 0U);
  TEST_ASSERT(metrics->underrun_incidents == 0U);
}

/*
 * Freshness scanning must itself have a hard CPU bound. If a corrupt caller
 * configured a deeper lane, dropping every stale item in one 8 ms audio pass
 * could starve the codec. Exhaustion renders silence for this clock edge and
 * resumes the bounded purge on the next edge; it never plays a known-old item.
 */
static void stale_scan_budget_bounds_each_audio_pass(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  initialise_with_limits(&fixture, 100U, 2U);
  for (size_t frame = 0U; frame < 4U; ++frame) {
    publish_frame(
        &fixture, (int16_t)(1000U + frame * 500U), frame * 20U);
  }
  publish_frame(&fixture, 9000, 190U);

  struct iterate_kit_pcm_clock_playback_result first;
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          250U,
          output,
          core_s3_dma_samples,
          &first) == ITERATE_KIT_OK);
  TEST_ASSERT(first.content_samples == 0U);
  TEST_ASSERT(first.silence_samples == core_s3_dma_samples);
  for (size_t index = 0U; index < core_s3_dma_samples; ++index) {
    TEST_ASSERT(output[index] == 0);
  }

  struct iterate_kit_pcm_clock_playback_result second;
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          258U,
          output,
          core_s3_dma_samples,
          &second) == ITERATE_KIT_OK);
  TEST_ASSERT(second.content_samples == 0U);
  struct iterate_kit_pcm_clock_playback_result third;
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          266U,
          output,
          core_s3_dma_samples,
          &third) == ITERATE_KIT_OK);
  TEST_ASSERT(third.content_samples == core_s3_dma_samples);
  TEST_ASSERT(output[0] == 9000);

  const struct iterate_kit_pcm_clock_playback_metrics *metrics =
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback);
  TEST_ASSERT(metrics->stale_scan_budget_exhaustions == 2U);
  TEST_ASSERT(metrics->stale_frames_discarded == 4U);
}

/*
 * Interruption and socket-generation replacement are semantic freshness
 * barriers. A 192-sample suffix retained from the prior assistant response is
 * just as stale as a complete ring slot, so reset must destroy and account it
 * before the next response can render.
 */
static void reset_discards_the_retained_prior_generation(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  initialise(&fixture);
  publish_frame(&fixture, 1000, 10U);

  struct iterate_kit_pcm_clock_playback_result before_reset;
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          10U,
          output,
          core_s3_dma_samples,
          &before_reset) == ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_reset(&fixture.playback) ==
      ITERATE_KIT_OK);
  publish_frame(&fixture, 7000, 20U);

  struct iterate_kit_pcm_clock_playback_result after_reset;
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          20U,
          output,
          core_s3_dma_samples,
          &after_reset) == ITERATE_KIT_OK);
  TEST_ASSERT(output[0] == 7000);
  const struct iterate_kit_pcm_clock_playback_metrics *metrics =
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback);
  TEST_ASSERT(metrics->resets == 1U);
  TEST_ASSERT(metrics->reset_samples_discarded == 192U);
  TEST_ASSERT(metrics->input_samples_discarded == 192U);
}

int main(void) {
  reframes_wire_audio_into_clock_chunks_exactly();
  mid_response_gap_becomes_current_silence_not_backlog();
  stale_frames_are_purged_before_current_playback();
  stackchan_accepts_the_userspace_startup_lead();
  stale_scan_budget_bounds_each_audio_pass();
  reset_discards_the_retained_prior_generation();
  return 0;
}
