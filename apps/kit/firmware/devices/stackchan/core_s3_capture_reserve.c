#include "core_s3_capture_reserve.h"

#include <limits.h>
#include <string.h>

#if defined(ESP_PLATFORM)
#include "esp_attr.h"
#define ITERATE_KIT_CORE_S3_ISR_ATTR IRAM_ATTR
#else
#define ITERATE_KIT_CORE_S3_ISR_ATTR
#endif

/*
 * These counters may be written in interrupt context and read by diagnostics
 * while the device runs for days. A wrapping fault counter would manufacture
 * apparent recovery, so update to UINT32_MAX with a bounded lock-free CAS.
 * Contention is limited to another increment/snapshot; no loop depends on a
 * network, task, or hardware event.
 */
static void atomic_saturating_increment(
    volatile uint32_t *value) {
  uint32_t current =
      __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             current + 1U,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static void atomic_saturating_add(
    volatile uint32_t *value,
    uint32_t amount) {
  uint32_t current =
      __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX) {
    const uint32_t next =
        amount > UINT32_MAX - current
        ? UINT32_MAX
        : current + amount;
    if (__atomic_compare_exchange_n(
            value,
            &current,
            next,
            false,
            __ATOMIC_RELAXED,
            __ATOMIC_RELAXED)) {
      return;
    }
  }
}

/*
 * Metrics with exactly one ISR writer use ordinary saturating arithmetic. The
 * diagnostic side only performs atomic loads, so a compare/exchange loop in
 * the callback would buy no ownership safety while expanding the IRAM call
 * graph and worst-case interrupt work.
 */
static void ITERATE_KIT_CORE_S3_ISR_ATTR producer_increment(
    volatile uint32_t *value) {
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

static void ITERATE_KIT_CORE_S3_ISR_ATTR producer_note_maximum(
    volatile uint32_t *maximum,
    uint32_t candidate) {
  if (candidate > *maximum) {
    *maximum = candidate;
  }
}

static void ITERATE_KIT_CORE_S3_ISR_ATTR poison(
    struct iterate_kit_core_s3_capture_reserve *reserve) {
  /*
   * A sticky bit, rather than a wrapping generation counter, means arbitrarily
   * many ISR losses while the owner is starved still force a reset. Sequential
   * consistency is reserved for this exceptional barrier so a consumer cannot
   * publish a chunk across an already-linearized loss; ordinary PCM publication
   * uses cheaper acquire/release operations.
   */
  __atomic_store_n(&reserve->poisoned, 1U, __ATOMIC_SEQ_CST);
}

static uint32_t bounded_depth(
    uint32_t write_count,
    uint32_t read_count) {
  const uint32_t depth = write_count - read_count;
  return depth > ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS
      ? ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS
      : depth;
}

static uint32_t discard_queued(
    struct iterate_kit_core_s3_capture_reserve *reserve) {
  const uint32_t read_count =
      __atomic_load_n(&reserve->read_count, __ATOMIC_RELAXED);
  const uint32_t write_count =
      __atomic_load_n(&reserve->write_count, __ATOMIC_ACQUIRE);
  const uint32_t discarded = bounded_depth(write_count, read_count);

  /*
   * Only the consumer writes read_count. Publishing the new read cursor frees
   * all pre-snapshot slots at once. A producer which races this store either
   * observes the old full reserve and leaves poison set for another reset, or
   * observes the new cursor and publishes only post-reset current PCM.
   */
  __atomic_store_n(
      &reserve->read_count, write_count, __ATOMIC_RELEASE);
  atomic_saturating_add(
      &reserve->consumer_chunks_discarded, discarded);
  return discarded;
}

static bool take_poison(
    struct iterate_kit_core_s3_capture_reserve *reserve) {
  return __atomic_exchange_n(
      &reserve->poisoned, 0U, __ATOMIC_SEQ_CST) != 0U;
}

enum iterate_kit_status iterate_kit_core_s3_capture_reserve_init(
    struct iterate_kit_core_s3_capture_reserve *reserve) {
  if (reserve == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(reserve, 0, sizeof(*reserve));
  reserve->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_core_s3_capture_push_result
ITERATE_KIT_CORE_S3_ISR_ATTR
iterate_kit_core_s3_capture_reserve_push_raw(
    struct iterate_kit_core_s3_capture_reserve *reserve,
    uint32_t sequence,
    uint64_t captured_through_at_us,
    bool playback_content_active,
    const void *pcm,
    size_t bytes) {
  if (reserve == NULL || !reserve->initialized) {
    return ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_INVALID;
  }

  /*
   * Track every callback sequence, including a dropped callback. Otherwise a
   * full reserve would report both the real capacity loss and a synthetic gap
   * on the first recovered chunk. uint32 overflow intentionally maps MAX -> 0.
   */
  if (reserve->producer_sequence_valid &&
      sequence != reserve->producer_last_sequence + 1U) {
    reserve->producer_last_sequence = sequence;
    producer_increment(&reserve->sequence_discontinuities);
    producer_increment(&reserve->producer_chunks_discarded);
    poison(reserve);
    return ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_DISCONTINUITY;
  }
  reserve->producer_last_sequence = sequence;
  reserve->producer_sequence_valid = true;

  if (pcm == NULL || bytes != ITERATE_KIT_CORE_S3_DMA_BYTES) {
    producer_increment(&reserve->shape_errors);
    producer_increment(&reserve->producer_chunks_discarded);
    poison(reserve);
    return ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_INVALID;
  }

  const uint32_t write_count =
      __atomic_load_n(&reserve->write_count, __ATOMIC_RELAXED);
  const uint32_t read_count =
      __atomic_load_n(&reserve->read_count, __ATOMIC_ACQUIRE);
  if (write_count - read_count >=
      ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS) {
    /*
     * Never overwrite the oldest slot and never wait for the task. Marking the
     * whole epoch unusable makes the eventual recovery current; a conventional
     * drop-new FIFO would first drain the exact stale speech which caused the
     * user-visible delay.
     */
    producer_increment(&reserve->reserve_overflows);
    producer_increment(&reserve->producer_chunks_discarded);
    poison(reserve);
    return ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_FULL;
  }

  struct iterate_kit_core_s3_capture_chunk *chunk =
      &reserve->chunks[
          write_count % ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS];
  chunk->sequence = sequence;
  chunk->captured_through_at_us = captured_through_at_us;
  chunk->playback_content_active = playback_content_active;
  memcpy(chunk->interleaved, pcm, ITERATE_KIT_CORE_S3_DMA_BYTES);

  /*
   * Release publication is the ISR's ownership handoff. The owner cannot see
   * this count without also seeing the complete metadata and 1,024-byte copy.
   */
  __atomic_store_n(
      &reserve->write_count, write_count + 1U, __ATOMIC_RELEASE);
  producer_increment(&reserve->chunks_accepted);
  producer_note_maximum(
      &reserve->maximum_depth,
      write_count + 1U - read_count);
  return ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED;
}

enum iterate_kit_core_s3_capture_take_result
iterate_kit_core_s3_capture_reserve_take(
    struct iterate_kit_core_s3_capture_reserve *reserve,
    struct iterate_kit_core_s3_capture_chunk *chunk) {
  if (reserve == NULL || !reserve->initialized || chunk == NULL) {
    return ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH;
  }

  if (take_poison(reserve)) {
    (void)discard_queued(reserve);
    atomic_saturating_increment(&reserve->epoch_resets);
    return ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH;
  }

  const uint32_t read_count =
      __atomic_load_n(&reserve->read_count, __ATOMIC_RELAXED);
  const uint32_t write_count =
      __atomic_load_n(&reserve->write_count, __ATOMIC_ACQUIRE);
  if (read_count == write_count) {
    return ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY;
  }

  memcpy(
      chunk,
      &reserve->chunks[
          read_count % ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS],
      sizeof(*chunk));
  __atomic_store_n(
      &reserve->read_count, read_count + 1U, __ATOMIC_RELEASE);

  if (take_poison(reserve)) {
    /*
     * The copied chunk has left the queue but has not been returned to AEC.
     * Count it as discarded, clear every still-queued predecessor of the loss,
     * and make RESET_EPOCH the only observable result of this call.
     */
    atomic_saturating_increment(
        &reserve->consumer_chunks_discarded);
    (void)discard_queued(reserve);
    atomic_saturating_increment(&reserve->epoch_resets);
    return ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH;
  }

  atomic_saturating_increment(&reserve->chunks_delivered);
  return ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK;
}

void iterate_kit_core_s3_capture_reserve_note_discontinuity(
    struct iterate_kit_core_s3_capture_reserve *reserve) {
  if (reserve == NULL || !reserve->initialized) {
    return;
  }
  atomic_saturating_increment(
      &reserve->external_discontinuities);
  poison(reserve);
}

void iterate_kit_core_s3_capture_reserve_metrics_snapshot(
    const struct iterate_kit_core_s3_capture_reserve *reserve,
    struct iterate_kit_core_s3_capture_reserve_metrics *snapshot) {
  if (snapshot == NULL) {
    return;
  }
  memset(snapshot, 0, sizeof(*snapshot));
  if (reserve == NULL || !reserve->initialized) {
    return;
  }

  snapshot->chunks_accepted =
      __atomic_load_n(&reserve->chunks_accepted, __ATOMIC_RELAXED);
  snapshot->chunks_delivered =
      __atomic_load_n(&reserve->chunks_delivered, __ATOMIC_RELAXED);
  const uint32_t producer_discarded =
      __atomic_load_n(
          &reserve->producer_chunks_discarded, __ATOMIC_RELAXED);
  const uint32_t consumer_discarded =
      __atomic_load_n(
          &reserve->consumer_chunks_discarded, __ATOMIC_RELAXED);
  snapshot->chunks_discarded =
      consumer_discarded > UINT32_MAX - producer_discarded
      ? UINT32_MAX
      : producer_discarded + consumer_discarded;
  snapshot->reserve_overflows =
      __atomic_load_n(&reserve->reserve_overflows, __ATOMIC_RELAXED);
  snapshot->shape_errors =
      __atomic_load_n(&reserve->shape_errors, __ATOMIC_RELAXED);
  snapshot->sequence_discontinuities =
      __atomic_load_n(
          &reserve->sequence_discontinuities, __ATOMIC_RELAXED);
  snapshot->external_discontinuities =
      __atomic_load_n(
          &reserve->external_discontinuities, __ATOMIC_RELAXED);
  snapshot->epoch_resets =
      __atomic_load_n(&reserve->epoch_resets, __ATOMIC_RELAXED);
  snapshot->maximum_depth =
      __atomic_load_n(&reserve->maximum_depth, __ATOMIC_RELAXED);
  const uint32_t read_count =
      __atomic_load_n(&reserve->read_count, __ATOMIC_ACQUIRE);
  const uint32_t write_count =
      __atomic_load_n(&reserve->write_count, __ATOMIC_ACQUIRE);
  snapshot->current_depth = bounded_depth(write_count, read_count);
}
