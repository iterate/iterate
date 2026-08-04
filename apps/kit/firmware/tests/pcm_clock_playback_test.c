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
  size_t released_items;
};

static void note_released_item(
    void *context, uint32_t released_items) {
  struct fixture *fixture = context;
  TEST_ASSERT(fixture != NULL);
  fixture->released_items += released_items;
}

static void initialise_with_limits(
    struct fixture *fixture,
    uint32_t maximum_frame_age_ms,
    size_t maximum_lane_items_per_render,
    size_t minimum_start_items) {
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
    .minimum_start_items = minimum_start_items,
    .item_released = note_released_item,
    .item_released_context = fixture,
  };
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_init(
          &fixture->playback, &options) == ITERATE_KIT_OK);
}

static void initialise(struct fixture *fixture) {
  initialise_with_limits(fixture, 100U, lane_capacity, 0U);
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
 * A production StackChan run received the authorized startup window as
 * separate WebSocket messages. The first message made playback active before
 * its siblings reached the SPSC ring, so two hardware edges emitted silence
 * even though userspace already owned a deep, conserved response reservoir.
 * Starting on one packet therefore mistakes packetization for readiness.
 *
 * The watermark delays only an inactive response. Once playback begins the
 * ordinary no-wait underrun policy remains absolute: the audio task never
 * blocks and never replays debt. Four items are intentionally used in this
 * unit fixture so every boundary is visible without a large test allocation.
 */
static void response_waits_for_the_finite_startup_watermark(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  struct iterate_kit_pcm_clock_playback_result result;
  initialise_with_limits(&fixture, 100U, lane_capacity, 4U);

  for (size_t frame = 0U; frame < 3U; ++frame) {
    publish_frame(&fixture, (int16_t)(1000U + frame * 1000U), 10U);
    TEST_ASSERT(
        iterate_kit_pcm_clock_playback_render(
            &fixture.playback,
            10U,
            output,
            core_s3_dma_samples,
            &result) == ITERATE_KIT_OK);
    TEST_ASSERT(result.content_samples == 0U);
    TEST_ASSERT(result.silence_samples == core_s3_dma_samples);
    TEST_ASSERT(!result.began_response);
    TEST_ASSERT(fixture.released_items == 0U);
  }

  publish_frame(&fixture, 4000, 10U);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          10U,
          output,
          core_s3_dma_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(result.content_samples == core_s3_dma_samples);
  TEST_ASSERT(result.began_response);
  TEST_ASSERT(output[0] == 1000);
  TEST_ASSERT(fixture.released_items == 1U);

  const struct iterate_kit_pcm_clock_playback_metrics *metrics =
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback);
  TEST_ASSERT(metrics->underrun_incidents == 0U);
  TEST_ASSERT(metrics->startup_wait_edges == 3U);
}

/*
 * A watermark cannot strand a valid short answer. The ordered EOS is
 * published only after every response frame, so observing one queued behind
 * fewer than the watermark proves the entire answer is already local. This is
 * merely a readiness fact: EOS stays in the same FIFO and cannot overtake the
 * speech it terminates.
 */
static void a_complete_short_response_bypasses_the_startup_watermark(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  struct iterate_kit_pcm_clock_playback_result result;
  initialise_with_limits(&fixture, 100U, lane_capacity, 4U);
  publish_frame(&fixture, 1000, 10U);
  publish_frame(&fixture, 2000, 10U);
  publish_end(&fixture, 10U);

  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          10U,
          output,
          core_s3_dma_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(result.content_samples == core_s3_dma_samples);
  TEST_ASSERT(result.began_response);
  TEST_ASSERT(output[0] == 1000);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback)
          ->startup_wait_edges == 0U);
}

/*
 * A degraded socket may deliver one 20 ms frame every 100 ms. With an
 * eight-item startup watermark and a 400 ms freshness limit, waiting before
 * every stale scan leaves seven old items in the lane forever: each arriving
 * frame opens the gate only long enough to discard one predecessor. Even a
 * healthy burst cannot then enter the full ring, so the conversation never
 * recovers without reconnecting.
 *
 * Once the watermark has authorized a bounded scan, the clock owner must keep
 * draining that stale epoch across clock edges. StackChan deliberately permits
 * only four lane inspections per 8 ms edge, so a local loop flag is
 * insufficient. It may privately retain the first current frame, but it must
 * not play it until seven more current items arrive. This proves both halves
 * of the realtime contract: outage history is destroyed and counted, while
 * recovery neither replays delay nor starts on a lone packet.
 */
static void slow_trickle_cannot_deadlock_fresh_response_recovery(void) {
  struct fixture fixture = {0};
  int16_t output[core_s3_dma_samples];
  struct iterate_kit_pcm_clock_playback_result result;
  initialise_with_limits(&fixture, 400U, 4U, lane_capacity);

  for (size_t frame = 0U; frame < 12U; ++frame) {
    const uint64_t now_ms = 1U + frame * 100U;
    publish_frame(
        &fixture,
        (int16_t)(1000U + frame * 100U),
        now_ms);
    TEST_ASSERT(
        iterate_kit_pcm_clock_playback_render(
            &fixture.playback,
            now_ms,
            output,
            core_s3_dma_samples,
            &result) == ITERATE_KIT_OK);
    TEST_ASSERT(result.content_samples == 0U);
    TEST_ASSERT(!result.began_response);
  }

  /*
   * The first current frame supplies the eighth slot that makes a bounded
   * stale scan safe. The four-item CPU budget requires two hardware edges to
   * remove the queued outage epoch; scan permission must survive the first.
   */
  publish_frame(&fixture, 9000, 2000U);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          2000U,
          output,
          core_s3_dma_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(result.content_samples == 0U);
  TEST_ASSERT(!result.began_response);

  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          2008U,
          output,
          core_s3_dma_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(result.content_samples == 0U);
  TEST_ASSERT(!result.began_response);

  struct iterate_kit_pcm_lane_metrics after_stale_epoch;
  iterate_kit_pcm_lane_metrics(&fixture.lane, &after_stale_epoch);
  TEST_ASSERT(after_stale_epoch.downlink.current_slots == 0U);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback)
          ->retained_samples == wire_samples);

  for (size_t frame = 0U; frame < lane_capacity - 1U; ++frame) {
    publish_frame(
        &fixture,
        (int16_t)(10000U + frame * 100U),
        2000U);
  }
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          2000U,
          output,
          core_s3_dma_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(result.began_response);
  TEST_ASSERT(result.content_samples == core_s3_dma_samples);
  TEST_ASSERT(output[0] == 9000);

  const struct iterate_kit_pcm_clock_playback_metrics *metrics =
      iterate_kit_pcm_clock_playback_metrics(&fixture.playback);
  TEST_ASSERT(metrics->stale_frames_discarded == 12U);
  TEST_ASSERT(metrics->stale_scan_budget_exhaustions > 0U);
  TEST_ASSERT(metrics->underrun_incidents == 0U);
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
      lane_capacity,
      0U);
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
  initialise_with_limits(&fixture, 100U, 2U, 0U);
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

/*
 * The 2026-08-03 physical StackChan run exposed the architectural error in
 * treating Cloudflare's 20 ms timer as the speaker clock: a 380 ms isolate
 * wakeup miss discarded 61 response frames even though the codec continued
 * asking for samples on time. The replacement flow-control seam must advance
 * only when the hardware-clocked consumer frees an ordered lane item. Merely
 * publishing three frames into the socket-owned ring grants no credit; each
 * frame and its EOS marker grant exactly one item after bounded playback work
 * releases it. The callback is deliberately allocation-free and does not claim
 * that every copied sample is already audible—it proves that one finite ring
 * slot is reusable, which is the capacity fact userspace actually needs.
 */
static void downlink_credit_follows_hardware_consumption(void) {
  struct fixture fixture = {0};
  int16_t output[wire_samples];
  struct iterate_kit_pcm_clock_playback_result result;
  initialise(&fixture);
  publish_frame(&fixture, 1000, 100U);
  publish_frame(&fixture, 2000, 120U);
  publish_frame(&fixture, 3000, 140U);
  publish_end(&fixture, 160U);

  TEST_ASSERT(fixture.released_items == 0U);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          160U,
          output,
          wire_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(fixture.released_items == 1U);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          180U,
          output,
          wire_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(fixture.released_items == 2U);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          200U,
          output,
          wire_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(fixture.released_items == 3U);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_render(
          &fixture.playback,
          220U,
          output,
          wire_samples,
          &result) == ITERATE_KIT_OK);
  TEST_ASSERT(result.end_of_response);
  TEST_ASSERT(fixture.released_items == 4U);
}

/*
 * An interruption does not merely stop the retained speaker suffix: it also
 * invalidates every complete response item still waiting in the lane. Those
 * slots are part of the userspace sender's finite credit window. Releasing
 * them locally without returning the same number of credits leaves the sender
 * waiting for capacity that already exists; the production symptom was nine
 * missing receipts followed by a deliberate 1.5 s stream close. Include the
 * EOS marker because it occupies one ordered slot even though it has no PCM.
 * The audio owner needs one bounded bulk notification, not one task wake per
 * discarded frame, because reset runs on the highest-priority audio task.
 */
static void interruption_purge_returns_every_capacity_credit(void) {
  struct fixture fixture = {0};
  uint32_t discarded_frames = 0U;
  uint32_t discarded_items = 0U;
  initialise(&fixture);
  publish_frame(&fixture, 1000, 100U);
  publish_frame(&fixture, 2000, 120U);
  publish_end(&fixture, 140U);

  TEST_ASSERT(fixture.released_items == 0U);
  TEST_ASSERT(
      iterate_kit_pcm_clock_playback_discard_queued(
          &fixture.playback,
          &discarded_frames,
          &discarded_items) == ITERATE_KIT_OK);
  TEST_ASSERT(discarded_frames == 2U);
  TEST_ASSERT(discarded_items == 3U);
  TEST_ASSERT(fixture.released_items == 3U);
}

int main(void) {
  reframes_wire_audio_into_clock_chunks_exactly();
  response_waits_for_the_finite_startup_watermark();
  a_complete_short_response_bypasses_the_startup_watermark();
  slow_trickle_cannot_deadlock_fresh_response_recovery();
  mid_response_gap_becomes_current_silence_not_backlog();
  stale_frames_are_purged_before_current_playback();
  stackchan_accepts_the_userspace_startup_lead();
  stale_scan_budget_bounds_each_audio_pass();
  reset_discards_the_retained_prior_generation();
  downlink_credit_follows_hardware_consumption();
  interruption_purge_returns_every_capacity_credit();
  return 0;
}
