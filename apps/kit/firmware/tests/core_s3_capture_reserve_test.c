#include "core_s3_capture_reserve.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void fill_dma(
    int16_t *samples,
    int16_t base) {
  for (size_t frame = 0U;
       frame < ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES;
       ++frame) {
    for (size_t slot = 0U;
         slot < ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT;
         ++slot) {
      samples[
          frame * ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT + slot] =
          (int16_t)(base + (int16_t)(frame * 4U + slot));
    }
  }
}

static enum iterate_kit_core_s3_capture_push_result push_capture(
    struct iterate_kit_core_s3_capture_reserve *reserve,
    uint32_t sequence,
    uint64_t captured_through_at_us,
    const void *pcm,
    size_t bytes) {
  return iterate_kit_core_s3_capture_reserve_push_raw(
      reserve,
      sequence,
      captured_through_at_us,
      false,
      pcm,
      bytes);
}

/*
 * The IDF ISR borrows a DMA pointer only until its callback returns. A reserve
 * which stores that pointer, or publishes its slot before the copy completes,
 * will eventually feed overwritten samples to AEC under ordinary scheduling.
 * This round trip proves the portable interface owns all 1,024 bytes and preserves
 * the physical completion metadata which later drives delay diagnostics.
 */
static void accepted_dma_is_copied_and_delivered_in_order(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  assert(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);

  int16_t first[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  int16_t second[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(first, 100);
  fill_dma(second, 2000);
  assert(
      push_capture(
          &reserve, 41U, 8000U, first, sizeof(first)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  assert(
      push_capture(
          &reserve, 42U, 16000U, second, sizeof(second)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  memset(first, 0, sizeof(first));
  memset(second, 0, sizeof(second));

  struct iterate_kit_core_s3_capture_chunk chunk;
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  assert(chunk.sequence == 41U);
  assert(chunk.captured_through_at_us == 8000U);
  assert(chunk.interleaved[0] == 100);
  assert(
      chunk.interleaved[
          ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES - 1U] ==
      611);
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  assert(chunk.sequence == 42U);
  assert(chunk.interleaved[0] == 2000);
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY);

  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  assert(metrics.chunks_accepted == 2U);
  assert(metrics.chunks_delivered == 2U);
  assert(metrics.maximum_depth == 2U);
  assert(metrics.current_depth == 0U);
}

/*
 * Far-active selection is capture metadata, not a second stream which capture
 * may wait for. The high-priority owner snapshots the speaker decision made
 * immediately before the matching microphone read. Preserve that decision in
 * the same publication as the RX samples so later scheduling cannot attach a
 * newer speaker state to an older microphone edge.
 */
static void playback_activity_is_owned_by_the_capture_edge(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  assert(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(dma, 500);

  assert(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve,
          1U,
          8000U,
          true,
          dma,
          sizeof(dma)) == ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);

  struct iterate_kit_core_s3_capture_chunk chunk;
  assert(
      iterate_kit_core_s3_capture_reserve_take(&reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  assert(chunk.playback_content_active);
}

/*
 * A starved AEC task can leave all eight 8 ms reserve slots occupied while
 * I2S continues recording. Draining those 64 ms after recovery would make the
 * remote conversation lag and would train AEC across a known timeline hole.
 * The ninth completion therefore poisons the whole queued epoch: the first
 * owner action is RESET, no old chunk is returned, and only a later current
 * completion may start the new epoch.
 */
static void overflow_discards_the_whole_stale_epoch(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  assert(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];

  for (uint32_t index = 0U;
       index < ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS;
       ++index) {
    fill_dma(dma, (int16_t)(index * 100));
    assert(
        push_capture(
            &reserve,
            100U + index,
            (uint64_t)(index + 1U) * 8000U,
            dma,
            sizeof(dma)) ==
        ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  }
  fill_dma(dma, 9000);
  assert(
      push_capture(
          &reserve, 108U, 72000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_FULL);

  struct iterate_kit_core_s3_capture_chunk chunk;
  memset(&chunk, 0x5a, sizeof(chunk));
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH);
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY);

  fill_dma(dma, 12000);
  assert(
      push_capture(
          &reserve, 109U, 80000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  assert(chunk.sequence == 109U);
  assert(chunk.interleaved[0] == 12000);

  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  assert(metrics.reserve_overflows == 1U);
  assert(metrics.epoch_resets == 1U);
  assert(
      metrics.chunks_discarded ==
      ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS + 1U);
  assert(metrics.chunks_delivered == 1U);
}

/*
 * IDF can lose a receive event before this application reserve is full (for
 * example its own event queue overflow). If sequence 8 followed sequence 6,
 * merely passing both to a 512-sample assembler would align unrelated acoustic
 * time. The reserve must turn that gap into the same destructive epoch reset
 * as capacity loss, and it must not let the first post-gap chunk sneak through.
 */
static void dma_sequence_gap_poison_is_fail_closed(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  assert(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(dma, 700);
  assert(
      push_capture(
          &reserve, 6U, 8000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  assert(
      push_capture(
          &reserve, 8U, 24000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_DISCONTINUITY);

  struct iterate_kit_core_s3_capture_chunk chunk;
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH);
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY);
  assert(
      push_capture(
          &reserve, 9U, 32000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  assert(chunk.sequence == 9U);

  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  assert(metrics.sequence_discontinuities == 1U);
  assert(metrics.chunks_discarded == 2U);
}

/*
 * A BSP or codec reconfiguration can invalidate acoustic alignment without a
 * malformed buffer or visible sequence gap. The outer owner needs the same
 * policy hook for IDF overflow counters and I2S restarts; keeping it explicit
 * prevents an error log from becoming the only response while stale PCM still
 * drains into AEC.
 */
static void external_discontinuity_destroys_queued_capture(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  assert(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(dma, 300);
  assert(
      push_capture(
          &reserve, UINT32_MAX, 8000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  iterate_kit_core_s3_capture_reserve_note_discontinuity(&reserve);

  struct iterate_kit_core_s3_capture_chunk chunk;
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH);
  assert(
      push_capture(
          &reserve, 0U, 16000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);

  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  assert(metrics.external_discontinuities == 1U);
  assert(metrics.epoch_resets == 1U);
  assert(metrics.chunks_discarded == 1U);
}

/*
 * A short/oversized callback means the TDM shape is no longer proven. Copying
 * a prefix and zero-filling the rest would hide a driver contract break as bad
 * AEC, so malformed input must be rejected and poison any earlier partial
 * epoch before the owner can observe it.
 */
static void malformed_dma_poison_is_observable(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  assert(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(dma, 30);
  assert(
      push_capture(
          &reserve, 1U, 8000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  assert(
      push_capture(
          &reserve, 2U, 16000U, dma, sizeof(dma) - 2U) ==
      ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_INVALID);

  struct iterate_kit_core_s3_capture_chunk chunk;
  assert(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH);
  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  assert(metrics.shape_errors == 1U);
  assert(metrics.chunks_discarded == 2U);
}

int main(void) {
  accepted_dma_is_copied_and_delivered_in_order();
  playback_activity_is_owned_by_the_capture_edge();
  overflow_discards_the_whole_stale_epoch();
  dma_sequence_gap_poison_is_fail_closed();
  external_discontinuity_destroys_queued_capture();
  malformed_dma_poison_is_observable();
  puts("CoreS3 capture reserve tests passed");
  return 0;
}
