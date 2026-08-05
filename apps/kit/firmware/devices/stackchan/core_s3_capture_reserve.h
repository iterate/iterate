#ifndef ITERATE_KIT_PLATFORMS_CORE_S3_CAPTURE_RESERVE_H
#define ITERATE_KIT_PLATFORMS_CORE_S3_CAPTURE_RESERVE_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * These are measured CoreS3/ES7210 contracts, not adjustable buffering knobs:
 * the audited BSP completes 128 sample frames per DMA descriptor and exposes
 * four 16-bit TDM slots. One callback therefore borrows exactly 1,024 bytes.
 * Changing any value requires re-validating the BSP configuration and physical
 * slot mapping rather than merely making this copy compile.
 */
#define ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES 128U
#define ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT 4U
#define ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES \
  (ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES * \
   ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT)
#define ITERATE_KIT_CORE_S3_DMA_BYTES \
  (ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES * sizeof(int16_t))

/*
 * Eight 8 ms chunks are 64 ms / two measured 512-sample ESP-SR AEC frames.
 * That reserve is deliberately generous enough for bounded Wi-Fi scheduler
 * interference without becoming an outage-history FIFO. If the ninth chunk
 * arrives, all eight queued chunks are destroyed before AEC can see them.
 * Static PCM cost is exactly 8,192 bytes plus metadata and indices.
 */
#define ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS 8U

struct iterate_kit_core_s3_capture_chunk {
  uint32_t sequence;
  uint64_t captured_through_at_us;
  /*
   * This is metadata from the playback owner, not another PCM timeline. The
   * owner renders and writes one speaker edge immediately before reading the
   * matching microphone edge, so it can attach whether that edge contained
   * response audio without making capture wait for a TX-completion callback.
   * A stale or conservative true only selects the already-current AEC output;
   * it can never queue, delay, or suppress the captured edge itself.
   */
  bool playback_content_active;
  int16_t interleaved[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES];
};

enum iterate_kit_core_s3_capture_push_result {
  ITERATE_KIT_CORE_S3_CAPTURE_ACCEPTED = 0,
  ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_FULL,
  ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_INVALID,
  ITERATE_KIT_CORE_S3_CAPTURE_DROPPED_DISCONTINUITY,
};

enum iterate_kit_core_s3_capture_take_result {
  ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY = 0,
  ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK,
  ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH,
};

struct iterate_kit_core_s3_capture_reserve_metrics {
  uint32_t chunks_accepted;
  uint32_t chunks_delivered;
  uint32_t chunks_discarded;
  uint32_t reserve_overflows;
  uint32_t shape_errors;
  uint32_t sequence_discontinuities;
  uint32_t external_discontinuities;
  uint32_t epoch_resets;
  uint32_t current_depth;
  uint32_t maximum_depth;
};

/**
 * One-producer/one-consumer raw CoreS3 DMA scheduling reserve.
 *
 * The I2S ISR is the sole producer. It performs one fixed 1,024-byte memcpy,
 * writes completion metadata, and publishes one monotonically advancing write
 * count. It does not deinterleave, allocate, log, retry, call DSP, or wait.
 * The high-priority audio owner is the sole consumer and copies one published
 * raw chunk before extracting near/reference slots outside interrupt context.
 * `__atomic` acquire/release operations make the PCM copy visible before its
 * write count; mutable indices never have two writers.
 *
 * `poisoned` is a sticky discontinuity barrier shared by both contexts. A full
 * reserve, malformed descriptor, sequence gap, IDF overflow, or I2S reset sets
 * it. take() must then return RESET_EPOCH after advancing past every queued
 * pre-loss chunk. The caller resets `aec_capture_bridge` before taking again.
 * This intentionally trades samples for current conversation time: there is no
 * recovery path which drains stale microphone audio after scheduling recovers.
 *
 * All storage is inline and all operations are allocation-free and bounded.
 * Metrics are saturating atomic observations suitable for another task to
 * snapshot. `current_depth` is a concurrent snapshot, not a transactional view.
 */
struct iterate_kit_core_s3_capture_reserve {
  struct iterate_kit_core_s3_capture_chunk
      chunks[ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS];

  /* Producer publishes; consumer only loads. */
  volatile uint32_t write_count;
  /* Consumer publishes; producer only loads. */
  volatile uint32_t read_count;
  volatile uint32_t poisoned;

  /* These two fields are touched only by the single ISR producer. */
  uint32_t producer_last_sequence;
  bool producer_sequence_valid;

  volatile uint32_t chunks_accepted;
  volatile uint32_t chunks_delivered;
  /* Split by writer so the ISR never needs a compare/exchange metrics loop. */
  volatile uint32_t producer_chunks_discarded;
  volatile uint32_t consumer_chunks_discarded;
  volatile uint32_t reserve_overflows;
  volatile uint32_t shape_errors;
  volatile uint32_t sequence_discontinuities;
  volatile uint32_t external_discontinuities;
  volatile uint32_t epoch_resets;
  volatile uint32_t maximum_depth;
  bool initialized;
};

enum iterate_kit_status iterate_kit_core_s3_capture_reserve_init(
    struct iterate_kit_core_s3_capture_reserve *reserve);

/**
 * Copies one borrowed BSP DMA descriptor into reserve-owned storage.
 *
 * This function is intended for the CoreS3 I2S callback and must remain in an
 * IRAM-safe call graph in the final ELF. A non-ACCEPTED result is an explicit
 * loss outcome; the callback should still wake the owner so RESET_EPOCH is
 * applied promptly. uint32 sequence wrap is contiguous by modular arithmetic.
 */
enum iterate_kit_core_s3_capture_push_result
iterate_kit_core_s3_capture_reserve_push_raw(
    struct iterate_kit_core_s3_capture_reserve *reserve,
    uint32_t sequence,
    uint64_t captured_through_at_us,
    bool playback_content_active,
    const void *pcm,
    size_t bytes);

/**
 * Retrieves at most one chunk, or applies one destructive loss barrier.
 *
 * RESET_EPOCH never returns usable PCM in `chunk`; the caller must reset its
 * acoustic/DSP epoch and invoke take() again. The consumer linearizes a chunk
 * by removing it from the reserve before the final poison check, so a later
 * producer overflow can only apply to chunks which remain queued after it.
 */
enum iterate_kit_core_s3_capture_take_result
iterate_kit_core_s3_capture_reserve_take(
    struct iterate_kit_core_s3_capture_reserve *reserve,
    struct iterate_kit_core_s3_capture_chunk *chunk);

/**
 * Poisons queued capture after a discontinuity observed outside the raw tap,
 * such as an IDF RX event-queue overflow. The single audio owner calls this;
 * it does not reset producer sequence state or touch either ring index.
 */
void iterate_kit_core_s3_capture_reserve_note_discontinuity(
    struct iterate_kit_core_s3_capture_reserve *reserve);

void iterate_kit_core_s3_capture_reserve_metrics_snapshot(
    const struct iterate_kit_core_s3_capture_reserve *reserve,
    struct iterate_kit_core_s3_capture_reserve_metrics *snapshot);

#ifdef __cplusplus
}
#endif

#endif
