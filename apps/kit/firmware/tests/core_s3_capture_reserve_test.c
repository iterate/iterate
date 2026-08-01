#include "iterate/kit/platforms/core_s3_capture_reserve.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *current_test = "test initialization";

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(
      stderr,
      "%s:%d: %s assertion failed: %s\n",
      file,
      line,
      current_test,
      expression);
  abort();
}

#define TEST_ASSERT(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)
#define RUN_TEST(function) \
  do { \
    current_test = #function; \
    function(); \
  } while (false)

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

/*
 * The IDF ISR borrows a DMA pointer only until its callback returns. A reserve
 * which stores that pointer, or publishes its slot before the copy completes,
 * will eventually feed overwritten samples to AEC under ordinary scheduling.
 * This round trip proves the portable seam owns all 1,024 bytes and preserves
 * the physical completion metadata which later drives delay diagnostics.
 */
static void accepted_dma_is_copied_and_delivered_in_order(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);

  int16_t first[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  int16_t second[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(first, 100);
  fill_dma(second, 2000);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 41U, 8000U, first, sizeof(first)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 42U, 16000U, second, sizeof(second)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  memset(first, 0, sizeof(first));
  memset(second, 0, sizeof(second));

  struct iterate_kit_core_s3_capture_chunk chunk;
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  TEST_ASSERT(chunk.sequence == 41U);
  TEST_ASSERT(chunk.captured_through_at_us == 8000U);
  TEST_ASSERT(chunk.interleaved[0] == 100);
  TEST_ASSERT(
      chunk.interleaved[
          ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES - 1U] ==
      611);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  TEST_ASSERT(chunk.sequence == 42U);
  TEST_ASSERT(chunk.interleaved[0] == 2000);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY);

  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  TEST_ASSERT(metrics.chunks_accepted == 2U);
  TEST_ASSERT(metrics.chunks_delivered == 2U);
  TEST_ASSERT(metrics.maximum_depth == 2U);
  TEST_ASSERT(metrics.current_depth == 0U);
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
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];

  for (uint32_t index = 0U;
       index < ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS;
       ++index) {
    fill_dma(dma, (int16_t)(index * 100));
    TEST_ASSERT(
        iterate_kit_core_s3_capture_reserve_push_raw(
            &reserve,
            100U + index,
            (uint64_t)(index + 1U) * 8000U,
            dma,
            sizeof(dma)) ==
        ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  }
  fill_dma(dma, 9000);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 108U, 72000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_FULL);

  struct iterate_kit_core_s3_capture_chunk chunk;
  memset(&chunk, 0x5a, sizeof(chunk));
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY);

  fill_dma(dma, 12000);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 109U, 80000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  TEST_ASSERT(chunk.sequence == 109U);
  TEST_ASSERT(chunk.interleaved[0] == 12000);

  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  TEST_ASSERT(metrics.reserve_overflows == 1U);
  TEST_ASSERT(metrics.epoch_resets == 1U);
  TEST_ASSERT(
      metrics.chunks_discarded ==
      ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS + 1U);
  TEST_ASSERT(metrics.chunks_delivered == 1U);
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
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(dma, 700);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 6U, 8000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 8U, 24000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_DISCONTINUITY);

  struct iterate_kit_core_s3_capture_chunk chunk;
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 9U, 32000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);
  TEST_ASSERT(chunk.sequence == 9U);

  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  TEST_ASSERT(metrics.sequence_discontinuities == 1U);
  TEST_ASSERT(metrics.chunks_discarded == 2U);
}

/*
 * A BSP or codec reconfiguration can invalidate acoustic alignment without a
 * malformed buffer or visible sequence gap. The outer owner needs the same
 * policy seam for IDF overflow counters and I2S restarts; keeping it explicit
 * prevents an error log from becoming the only response while stale PCM still
 * drains into AEC.
 */
static void external_discontinuity_destroys_queued_capture(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(dma, 300);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, UINT32_MAX, 8000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  iterate_kit_core_s3_capture_reserve_note_discontinuity(&reserve);

  struct iterate_kit_core_s3_capture_chunk chunk;
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 0U, 16000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK);

  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  TEST_ASSERT(metrics.external_discontinuities == 1U);
  TEST_ASSERT(metrics.epoch_resets == 1U);
  TEST_ASSERT(metrics.chunks_discarded == 1U);
}

/*
 * A short/oversized callback means the TDM shape is no longer proven. Copying
 * a prefix and zero-filling the rest would hide a driver contract break as bad
 * AEC, so malformed input must be rejected and poison any earlier partial
 * epoch before the owner can observe it.
 */
static void malformed_dma_poison_is_observable(void) {
  struct iterate_kit_core_s3_capture_reserve reserve;
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_init(&reserve) ==
      ITERATE_KIT_OK);
  int16_t dma[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
  fill_dma(dma, 30);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 1U, 8000U, dma, sizeof(dma)) ==
      ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED);
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_push_raw(
          &reserve, 2U, 16000U, dma, sizeof(dma) - 2U) ==
      ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_INVALID);

  struct iterate_kit_core_s3_capture_chunk chunk;
  TEST_ASSERT(
      iterate_kit_core_s3_capture_reserve_take(
          &reserve, &chunk) ==
      ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH);
  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &reserve, &metrics);
  TEST_ASSERT(metrics.shape_errors == 1U);
  TEST_ASSERT(metrics.chunks_discarded == 2U);
}

int main(void) {
  RUN_TEST(accepted_dma_is_copied_and_delivered_in_order);
  RUN_TEST(overflow_discards_the_whole_stale_epoch);
  RUN_TEST(dma_sequence_gap_poison_is_fail_closed);
  RUN_TEST(external_discontinuity_destroys_queued_capture);
  RUN_TEST(malformed_dma_poison_is_observable);
  puts("CoreS3 capture reserve tests passed");
  return 0;
}
