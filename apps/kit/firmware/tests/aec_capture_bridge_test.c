#include "iterate/kit/aec_capture_bridge.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
  processing_samples = 256,
  wire_samples = 320,
  dma_samples = 128,
  maximum_emitted_frames = 16,
};

struct fixture {
  struct iterate_kit_aec_capture_bridge bridge;
  int16_t near[processing_samples];
  int16_t reference[processing_samples];
  int16_t playout[processing_samples];
  int16_t clean[processing_samples];
  int16_t egress[wire_samples];
  int16_t emitted[maximum_emitted_frames][wire_samples];
  uint64_t emitted_at_us[maximum_emitted_frames];
  size_t process_calls;
  size_t reset_calls;
  size_t copy_calls;
  size_t copied_frames;
  int16_t last_processed_playout_first;
  int16_t last_processed_playout_last;
  size_t fail_process_call;
  size_t fail_copy_call;
};

static enum iterate_kit_status process_aec(
    void *context,
    const int16_t *near,
    const int16_t *reference,
    const int16_t *playout,
    int16_t *clean,
    size_t sample_count) {
  struct fixture *fixture = context;
  fixture->process_calls++;
  fixture->last_processed_playout_first = playout[0];
  fixture->last_processed_playout_last = playout[sample_count - 1U];
  for (size_t index = 0U; index < sample_count; ++index) {
    clean[index] = (int16_t)(near[index] - reference[index]);
  }
  if (fixture->process_calls == fixture->fail_process_call) {
    /*
     * A real DSP failure can leave its destination partly written. Returning
     * raw or partial microphone data would silently disable echo protection,
     * so the bridge—not the processor—is responsible for replacing the whole
     * failed frame with silence before anything reaches the network.
     */
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status reset_aec(void *context) {
  struct fixture *fixture = context;
  fixture->reset_calls++;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status copy_egress(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us) {
  struct fixture *fixture = context;
  const size_t call = fixture->copy_calls++;
  TEST_ASSERT(sample_count == wire_samples);
  TEST_ASSERT(sample_rate_hz == 16000U);
  if (call + 1U == fixture->fail_copy_call) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  TEST_ASSERT(fixture->copied_frames < maximum_emitted_frames);
  memcpy(
      fixture->emitted[fixture->copied_frames],
      samples,
      sample_count * sizeof(*samples));
  fixture->emitted_at_us[fixture->copied_frames] =
      captured_through_at_us;
  fixture->copied_frames++;
  return ITERATE_KIT_OK;
}

static void initialise(struct fixture *fixture) {
  const struct iterate_kit_aec_capture_bridge_options options = {
    .sample_rate_hz = 16000U,
    .processing_frame_samples = processing_samples,
    .egress_frame_samples = wire_samples,
    .near_frame = fixture->near,
    .reference_frame = fixture->reference,
    .playout_frame = fixture->playout,
    .clean_frame = fixture->clean,
    .processing_frame_capacity = processing_samples,
    .egress_frame = fixture->egress,
    .egress_frame_capacity = wire_samples,
    .processor_context = fixture,
    .process = process_aec,
    .reset_processor = reset_aec,
    .egress_context = fixture,
    .copy_egress = copy_egress,
  };
  TEST_ASSERT(
      iterate_kit_aec_capture_bridge_init(&fixture->bridge, &options) ==
      ITERATE_KIT_OK);
}

static enum iterate_kit_status push_chunk(
    struct fixture *fixture,
    uint32_t sequence,
    uint64_t captured_through_at_us,
    size_t first_sample) {
  int16_t near[dma_samples];
  int16_t reference[dma_samples];
  int16_t playout[dma_samples];
  for (size_t index = 0U; index < dma_samples; ++index) {
    near[index] = (int16_t)(first_sample + index);
    reference[index] = 0;
    playout[index] = (int16_t)(12000U + first_sample + index);
  }
  return iterate_kit_aec_capture_bridge_push_aligned(
      &fixture->bridge,
      sequence,
      captured_through_at_us,
      near,
      reference,
      playout,
      dma_samples);
}

/*
 * Physical loudspeaker feedback and exact digital playout answer different
 * questions. The feedback is the best cancellation input because it contains
 * amplifier distortion; the exact playout is the only reliable far-active
 * oracle because the feedback lane can contain noise during silence. This
 * regression proves the generic cadence bridge cannot accidentally alias or
 * discard the third timeline while joining two 128-sample DMA chunks into one
 * 256-sample DSP frame.
 */
static void preserves_distinct_reference_and_playout_timelines(void) {
  struct fixture fixture = {0};
  initialise(&fixture);

  TEST_ASSERT(push_chunk(&fixture, 0U, 8000U, 0U) == ITERATE_KIT_OK);
  TEST_ASSERT(
      push_chunk(&fixture, 1U, 16000U, dma_samples) == ITERATE_KIT_OK);
  TEST_ASSERT(fixture.process_calls == 1U);
  TEST_ASSERT(fixture.last_processed_playout_first == 12000);
  TEST_ASSERT(
      fixture.last_processed_playout_last ==
      (int16_t)(12000U + processing_samples - 1U));
}

/*
 * CoreS3's ESP-SR VOIP AEC consumes 256-sample frames while PCM v1 is
 * fixed at 320 samples. Accumulating either side as whole frames creates a
 * beat-pattern queue and eventually stale speech. Twenty 8 ms DMA chunks are
 * the least common period, so this test proves exact order, conservation, and
 * capture-boundary timestamps across all ten DSP / eight wire frames.
 */
static void reframes_without_loss_or_drift(void) {
  struct fixture fixture = {0};
  const uint64_t stream_started_at_us = 1000000U;
  initialise(&fixture);

  for (size_t chunk = 0U; chunk < 20U; ++chunk) {
    TEST_ASSERT(
        push_chunk(
            &fixture,
            (uint32_t)chunk,
            stream_started_at_us + (chunk + 1U) * 8000U,
            chunk * dma_samples) == ITERATE_KIT_OK);
  }

  TEST_ASSERT(fixture.process_calls == 10U);
  TEST_ASSERT(fixture.copied_frames == 8U);
  for (size_t frame = 0U; frame < 8U; ++frame) {
    for (size_t sample = 0U; sample < wire_samples; ++sample) {
      TEST_ASSERT(
          fixture.emitted[frame][sample] ==
          (int16_t)(frame * wire_samples + sample));
    }
    TEST_ASSERT(
        fixture.emitted_at_us[frame] ==
        stream_started_at_us + (frame + 1U) * 20000U);
  }

  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(metrics->input_samples_accepted == 2560U);
  TEST_ASSERT(metrics->processor_frames == 10U);
  TEST_ASSERT(metrics->clean_samples_produced == 2560U);
  TEST_ASSERT(metrics->egress_frames_copied == 8U);
  TEST_ASSERT(metrics->egress_samples_copied == 2560U);
  TEST_ASSERT(metrics->clean_samples_discarded == 0U);
  TEST_ASSERT(metrics->input_partial_samples == 0U);
  TEST_ASSERT(metrics->egress_partial_samples == 0U);
}

/*
 * An ISR queue overflow or skipped DMA callback breaks sample continuity even
 * if near and reference still have matching array lengths. Feeding the two
 * fragments around that hole into one AEC frame teaches the adaptive filter a
 * false time relationship. The bridge must reset DSP and discard both raw and
 * clean partials before accepting the first current chunk after the gap.
 */
static void sequence_gap_resets_every_partial_epoch(void) {
  struct fixture fixture = {0};
  initialise(&fixture);

  for (uint32_t sequence = 0U; sequence < 4U; ++sequence) {
    TEST_ASSERT(
        push_chunk(
            &fixture,
            sequence,
            (uint64_t)(sequence + 1U) * 8000U,
            (size_t)sequence * dma_samples) == ITERATE_KIT_OK);
  }
  TEST_ASSERT(fixture.copied_frames == 1U);
  TEST_ASSERT(
      push_chunk(&fixture, 6U, 56000U, 6U * dma_samples) ==
      ITERATE_KIT_OK);

  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(fixture.reset_calls == 1U);
  TEST_ASSERT(metrics->sequence_discontinuities == 1U);
  TEST_ASSERT(metrics->epoch_resets == 1U);
  TEST_ASSERT(metrics->clean_samples_discarded == 192U);
  TEST_ASSERT(metrics->input_samples_discarded == 0U);
  TEST_ASSERT(metrics->input_partial_samples == dma_samples);
  TEST_ASSERT(metrics->egress_partial_samples == 0U);
}

/*
 * A sequence hole can arrive before enough samples exist for one DSP call.
 * Silently carrying that raw prefix into the new epoch is especially easy to
 * miss because no clean frame exists yet. This pins raw-partial accounting and
 * proves the first post-gap chunk starts a fresh 128-sample frame.
 */
static void sequence_gap_discards_unprocessed_input(void) {
  struct fixture fixture = {0};
  initialise(&fixture);

  TEST_ASSERT(push_chunk(&fixture, 0U, 8000U, 0U) == ITERATE_KIT_OK);
  TEST_ASSERT(
      push_chunk(&fixture, 2U, 24000U, 2U * dma_samples) ==
      ITERATE_KIT_OK);

  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(fixture.process_calls == 0U);
  TEST_ASSERT(fixture.reset_calls == 1U);
  TEST_ASSERT(metrics->input_samples_accepted == 256U);
  TEST_ASSERT(metrics->input_samples_discarded == 128U);
  TEST_ASSERT(metrics->input_partial_samples == dma_samples);
}

/*
 * AEC is a safety boundary for full-duplex conversation, not an optional
 * enhancement. If its implementation errors after writing some output, a raw
 * fallback can feed the assistant into its own microphone and cause a runaway
 * conversation. The frame cadence remains real-time, but every failed DSP
 * sample must be known silence and the failure must remain explicit.
 */
static void processor_failure_is_auditable_silence(void) {
  struct fixture fixture = {0};
  fixture.fail_process_call = 1U;
  initialise(&fixture);

  enum iterate_kit_status observed_failure = ITERATE_KIT_OK;
  for (uint32_t sequence = 0U; sequence < 4U; ++sequence) {
    const enum iterate_kit_status status = push_chunk(
        &fixture,
        sequence,
        (uint64_t)(sequence + 1U) * 8000U,
        (size_t)sequence * dma_samples);
    if (status != ITERATE_KIT_OK) {
      observed_failure = status;
    }
  }
  TEST_ASSERT(observed_failure == ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(fixture.copied_frames == 1U);
  for (size_t sample = 0U; sample < processing_samples; ++sample) {
    TEST_ASSERT(fixture.emitted[0][sample] == 0);
  }
  for (size_t sample = processing_samples; sample < wire_samples; ++sample) {
    TEST_ASSERT(fixture.emitted[0][sample] == (int16_t)sample);
  }

  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(metrics->processor_failures == 1U);
  TEST_ASSERT(metrics->processor_silence_samples == processing_samples);
  TEST_ASSERT(metrics->clean_samples_produced == processing_samples * 2U);
}

/*
 * A full PCM/WebSocket lane must not preserve the oldest speech until Wi-Fi
 * recovers. Here the second wire copy rejects one frame after 192 older clean
 * samples were already staged. The bridge must abandon that complete failed
 * frame and the remainder of the DSP frame, then resume with sample 1024—not
 * leak any of the 704 stale samples into the first recovered frame.
 */
static void egress_backpressure_abandons_the_whole_stale_suffix(void) {
  struct fixture fixture = {0};
  fixture.fail_copy_call = 2U;
  initialise(&fixture);

  enum iterate_kit_status observed_failure = ITERATE_KIT_OK;
  for (uint32_t sequence = 0U; sequence < 12U; ++sequence) {
    const enum iterate_kit_status status = push_chunk(
        &fixture,
        sequence,
        (uint64_t)(sequence + 1U) * 8000U,
        (size_t)sequence * dma_samples);
    if (status != ITERATE_KIT_OK) {
      observed_failure = status;
    }
  }

  TEST_ASSERT(observed_failure == ITERATE_KIT_BACKPRESSURE);
  TEST_ASSERT(fixture.copied_frames == 3U);
  TEST_ASSERT(fixture.emitted[0][0] == 0);
  TEST_ASSERT(fixture.emitted[1][0] == 768);
  TEST_ASSERT(fixture.emitted_at_us[1] == 68000U);

  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(metrics->egress_copy_failures == 1U);
  TEST_ASSERT(metrics->egress_frames_copied == 3U);
  TEST_ASSERT(metrics->egress_samples_copied == 960U);
  TEST_ASSERT(metrics->clean_samples_discarded == 448U);
  TEST_ASSERT(metrics->egress_partial_samples == 128U);
  TEST_ASSERT(
      metrics->clean_samples_produced ==
      metrics->egress_samples_copied +
          metrics->clean_samples_discarded +
          metrics->egress_partial_samples);
}

/*
 * Normal CoreS3 DMA arrives in 128-sample callbacks, but the portable API must
 * remain correct if a driver coalesces several completions under scheduler
 * load. Once one copy fails, later frames from that same oversized callback
 * are part of the same stale interval and must not leapfrog the rejected one.
 */
static void coalesced_input_cannot_send_past_backpressure(void) {
  struct fixture fixture = {0};
  int16_t near[processing_samples * 3U];
  int16_t reference[processing_samples * 3U] = {0};
  int16_t playout[processing_samples * 3U] = {0};
  fixture.fail_copy_call = 2U;
  initialise(&fixture);
  for (size_t index = 0U;
       index < processing_samples * 3U;
       ++index) {
    near[index] = (int16_t)index;
  }

  TEST_ASSERT(
      iterate_kit_aec_capture_bridge_push_aligned(
          &fixture.bridge,
          0U,
          96000U,
          near,
          reference,
          playout,
          processing_samples * 3U) ==
      ITERATE_KIT_BACKPRESSURE);

  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(fixture.process_calls == 3U);
  TEST_ASSERT(fixture.copy_calls == 2U);
  TEST_ASSERT(fixture.copied_frames == 1U);
  TEST_ASSERT(metrics->egress_copy_failures == 1U);
  TEST_ASSERT(metrics->egress_samples_copied == wire_samples);
  TEST_ASSERT(metrics->clean_samples_discarded == 448U);
  TEST_ASSERT(metrics->egress_partial_samples == 0U);
  TEST_ASSERT(
      metrics->clean_samples_produced ==
      metrics->egress_samples_copied +
          metrics->clean_samples_discarded);
}

/*
 * The device's mic-to-provider latency uses local capture completion time. A
 * regressing timestamp would create negative/huge ages and contaminate the
 * evidence used to blame audio versus network. Reject only that chunk and
 * preserve sequence state so a corrected delivery can resume deterministically.
 */
static void timestamp_regression_is_rejected_without_state_drift(void) {
  struct fixture fixture = {0};
  initialise(&fixture);

  TEST_ASSERT(
      push_chunk(&fixture, 0U, 8000U, 0U) == ITERATE_KIT_OK);
  TEST_ASSERT(
      push_chunk(&fixture, 1U, 7000U, dma_samples) ==
      ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(
      push_chunk(&fixture, 1U, 16000U, dma_samples) ==
      ITERATE_KIT_OK);

  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(metrics->timestamp_regressions == 1U);
  TEST_ASSERT(metrics->input_samples_accepted == 256U);
  TEST_ASSERT(metrics->input_samples_discarded == dma_samples);
  TEST_ASSERT(metrics->input_partial_samples == 0U);
  TEST_ASSERT(metrics->sequence_discontinuities == 0U);
}

/*
 * OBSERVING THE BRIDGE MUST NOT CHANGE IT.
 *
 * metrics() used to assign the two partial-sample members on every call. Both
 * are already written at each fill site, so the assignment changed nothing —
 * but it made reading a health document a mutation of state the audio task
 * owns, and stackchan paid for it: its app loop could not read the bridge
 * without racing that task, so the read was moved onto the task and mirrored
 * through atomics.
 *
 * Reading through a const pointer is the compile-time half of the proof. This
 * is the runtime half, taken mid-frame with both a raw and a clean partial
 * outstanding, which is the only state the old writes could have altered.
 */
static void reading_metrics_does_not_mutate_the_bridge(void) {
  struct fixture fixture = {0};
  initialise(&fixture);

  /* Five 128-sample chunks: one 320-sample wire frame out, partials on both
   * sides of the bridge still filling. */
  for (uint32_t sequence = 0U; sequence < 5U; ++sequence) {
    TEST_ASSERT(
        push_chunk(
            &fixture,
            sequence,
            (uint64_t)(sequence + 1U) * 8000U,
            (size_t)sequence * dma_samples) == ITERATE_KIT_OK);
  }

  const struct iterate_kit_aec_capture_bridge *readonly = &fixture.bridge;
  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(readonly);
  TEST_ASSERT(metrics != NULL);
  TEST_ASSERT(metrics->input_partial_samples != 0U);
  TEST_ASSERT(metrics->egress_partial_samples != 0U);

  const struct iterate_kit_aec_capture_bridge before = fixture.bridge;
  const struct iterate_kit_aec_capture_bridge_metrics snapshot = *metrics;
  for (size_t read = 0U; read < 4U; ++read) {
    TEST_ASSERT(
        iterate_kit_aec_capture_bridge_metrics(readonly) == metrics);
  }
  TEST_ASSERT(memcmp(&before, &fixture.bridge, sizeof(before)) == 0);
  TEST_ASSERT(memcmp(&snapshot, metrics, sizeof(snapshot)) == 0);

  /* The partials the reads did not disturb still complete their frames. */
  TEST_ASSERT(
      push_chunk(&fixture, 5U, 48000U, 5U * dma_samples) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      metrics->egress_samples_copied ==
      snapshot.egress_samples_copied + wire_samples);
}

/* --- the degenerate cadence, which is now three of the four boards -------- */

/*
 * THE SHARED CAPTURE STEP RUNS EVERY BOARD THROUGH THIS BRIDGE, so the claim
 * that a board whose DMA grain, DSP frame and wire frame are all 320 is
 * unaffected has to be a test rather than an argument. Same fixture shape, one
 * cadence.
 */
enum { flat_samples = 320 };

struct flat_fixture {
  struct iterate_kit_aec_capture_bridge bridge;
  int16_t near[flat_samples];
  int16_t reference[flat_samples];
  int16_t playout[flat_samples];
  int16_t clean[flat_samples];
  int16_t egress[flat_samples];
  int16_t emitted[maximum_emitted_frames][flat_samples];
  size_t process_calls;
  size_t copied_frames;
  size_t fail_process_call;
};

static enum iterate_kit_status flat_process(
    void *context,
    const int16_t *near,
    const int16_t *reference,
    const int16_t *playout,
    int16_t *clean,
    size_t sample_count) {
  struct flat_fixture *fixture = context;
  (void)reference;
  (void)playout;
  fixture->process_calls++;
  TEST_ASSERT(sample_count == flat_samples);
  /* What the passthrough processor does: near, verbatim. */
  memcpy(clean, near, sample_count * sizeof(*clean));
  if (fixture->process_calls == fixture->fail_process_call) {
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status flat_reset(void *context) {
  (void)context;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status flat_copy(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us) {
  struct flat_fixture *fixture = context;
  (void)sample_rate_hz;
  (void)captured_through_at_us;
  TEST_ASSERT(sample_count == flat_samples);
  TEST_ASSERT(fixture->copied_frames < maximum_emitted_frames);
  memcpy(
      fixture->emitted[fixture->copied_frames],
      samples,
      sample_count * sizeof(*samples));
  fixture->copied_frames++;
  return ITERATE_KIT_OK;
}

static void flat_initialise(struct flat_fixture *fixture) {
  const struct iterate_kit_aec_capture_bridge_options options = {
    .sample_rate_hz = 16000U,
    .processing_frame_samples = flat_samples,
    .egress_frame_samples = flat_samples,
    .near_frame = fixture->near,
    .reference_frame = fixture->reference,
    .playout_frame = fixture->playout,
    .clean_frame = fixture->clean,
    .processing_frame_capacity = flat_samples,
    .egress_frame = fixture->egress,
    .egress_frame_capacity = flat_samples,
    .processor_context = fixture,
    .process = flat_process,
    .reset_processor = flat_reset,
    .egress_context = fixture,
    .copy_egress = flat_copy,
  };
  TEST_ASSERT(
      iterate_kit_aec_capture_bridge_init(&fixture->bridge, &options) ==
      ITERATE_KIT_OK);
}

static enum iterate_kit_status flat_push(
    struct flat_fixture *fixture, uint32_t sequence, size_t first_sample) {
  int16_t near[flat_samples];
  int16_t reference[flat_samples];
  int16_t playout[flat_samples];
  for (size_t index = 0U; index < flat_samples; ++index) {
    near[index] = (int16_t)(first_sample + index);
    reference[index] = 0;
    playout[index] = 0;
  }
  return iterate_kit_aec_capture_bridge_push_aligned(
      &fixture->bridge,
      sequence,
      (uint64_t)(sequence + 1U) * 20000U,
      near,
      reference,
      playout,
      flat_samples);
}

/*
 * ONE CHUNK IN, ONE IDENTICAL FRAME OUT, NOTHING RETAINED.
 *
 * The whole cost of routing a board that never needed reframing through the
 * bridge: four memcpys and the same processor call. If this ever stops being
 * exact, three boards' uplinks changed and nothing else would say so.
 */
static void flat_cadence_is_an_exact_passthrough(void) {
  struct flat_fixture fixture = {0};
  flat_initialise(&fixture);

  for (uint32_t sequence = 0U; sequence < 5U; ++sequence) {
    TEST_ASSERT(
        flat_push(&fixture, sequence, (size_t)sequence * flat_samples) ==
        ITERATE_KIT_OK);
    /* Emitted on the same call that accepted it: no frame is ever held. */
    TEST_ASSERT(fixture.copied_frames == (size_t)sequence + 1U);
    TEST_ASSERT(fixture.process_calls == (size_t)sequence + 1U);
  }
  for (size_t frame = 0U; frame < 5U; ++frame) {
    for (size_t sample = 0U; sample < flat_samples; ++sample) {
      TEST_ASSERT(
          fixture.emitted[frame][sample] ==
          (int16_t)(frame * flat_samples + sample));
    }
  }
  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(metrics->input_partial_samples == 0U);
  TEST_ASSERT(metrics->egress_partial_samples == 0U);
  TEST_ASSERT(metrics->input_samples_discarded == 0U);
  TEST_ASSERT(metrics->clean_samples_discarded == 0U);
  TEST_ASSERT(metrics->sequence_discontinuities == 0U);
  TEST_ASSERT(metrics->timestamp_regressions == 0U);
}

/*
 * THE ONE DIVERGENCE FROM THE DIRECT PATH, PINNED.
 *
 * The capture step used to return early on a failed process, so the wire
 * timeline simply skipped 20 ms. The bridge writes a complete silent frame
 * instead. A fixed-size frame is the less surprising contract — every consumer
 * downstream assumes 20 ms, and a silently missing frame gets diagnosed as a
 * network fault — and it can never substitute raw microphone.
 *
 * Unreachable behind a passthrough processor, which is why the three boards
 * that gained the bridge cannot observe it. Pinned anyway, because "cannot
 * fail" is a property of today's processor and not of this seam.
 */
static void flat_process_failure_emits_silence_not_a_hole(void) {
  struct flat_fixture fixture = {0};
  fixture.fail_process_call = 2U;
  flat_initialise(&fixture);

  TEST_ASSERT(flat_push(&fixture, 0U, 0U) == ITERATE_KIT_OK);
  TEST_ASSERT(flat_push(&fixture, 1U, flat_samples) == ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(flat_push(&fixture, 2U, 2U * flat_samples) == ITERATE_KIT_OK);

  /* Three frames, not two: the failed one is silence and still on the wire. */
  TEST_ASSERT(fixture.copied_frames == 3U);
  for (size_t sample = 0U; sample < flat_samples; ++sample) {
    TEST_ASSERT(fixture.emitted[1][sample] == 0);
  }
  /* And the frame after it is the real audio, not a shifted timeline. */
  for (size_t sample = 0U; sample < flat_samples; ++sample) {
    TEST_ASSERT(
        fixture.emitted[2][sample] ==
        (int16_t)(2U * flat_samples + sample));
  }
  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&fixture.bridge);
  TEST_ASSERT(metrics->processor_failures == 1U);
  TEST_ASSERT(metrics->processor_silence_samples == flat_samples);
}

int main(void) {
  flat_cadence_is_an_exact_passthrough();
  flat_process_failure_emits_silence_not_a_hole();
  preserves_distinct_reference_and_playout_timelines();
  reframes_without_loss_or_drift();
  sequence_gap_resets_every_partial_epoch();
  sequence_gap_discards_unprocessed_input();
  processor_failure_is_auditable_silence();
  egress_backpressure_abandons_the_whole_stale_suffix();
  coalesced_input_cannot_send_past_backpressure();
  timestamp_regression_is_rejected_without_state_drift();
  reading_metrics_does_not_mutate_the_bridge();
  return 0;
}
