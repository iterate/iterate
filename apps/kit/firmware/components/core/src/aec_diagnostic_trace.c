#include "iterate/kit/aec_diagnostic_trace.h"

#include <limits.h>
#include <stdbool.h>
#include <string.h>

/*
 * The control owner briefly claims IDLE before publishing ARMED. The audio
 * owner treats this internal value like IDLE. Without it, ARMED could become
 * visible before generation/offset metadata was reset, creating a rare trace
 * whose first frame is written at the previous generation's end offset.
 */
#define TRACE_STATE_PREPARING UINT32_MAX

static void atomic_saturating_increment(volatile uint32_t *value) {
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
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

static bool storage_is_distinct(
    const struct iterate_kit_aec_diagnostic_trace_options *options) {
  /*
   * The API contract forbids every overlap, while base equality catches the
   * realistic configuration failure without risky pointer-range arithmetic.
   * Target arrays are link-visible fixed objects rather than arbitrary slices.
   */
  return options->near_samples != options->reference_samples &&
      options->near_samples != options->linear_samples &&
      options->near_samples != options->clean_samples &&
      options->reference_samples != options->linear_samples &&
      options->reference_samples != options->clean_samples &&
      options->linear_samples != options->clean_samples;
}

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_init(
    struct iterate_kit_aec_diagnostic_trace *trace,
    const struct iterate_kit_aec_diagnostic_trace_options *options) {
  if (trace == NULL || options == NULL ||
      options->sample_rate_hz == 0U ||
      options->frame_samples == 0U ||
      options->capture_samples == 0U ||
      options->capture_samples % options->frame_samples != 0U ||
      options->capture_samples > UINT32_MAX ||
      options->near_samples == NULL ||
      options->reference_samples == NULL ||
      options->linear_samples == NULL ||
      options->clean_samples == NULL ||
      !storage_is_distinct(options)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(trace, 0, sizeof(*trace));
  trace->options = *options;
  trace->initialized = 1U;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_start(
    struct iterate_kit_aec_diagnostic_trace *trace,
    uint32_t *generation) {
  if (trace == NULL || trace->initialized == 0U || generation == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  uint32_t expected = ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_IDLE;
  if (!__atomic_compare_exchange_n(
          &trace->state,
          &expected,
          TRACE_STATE_PREPARING,
          false,
          __ATOMIC_ACQ_REL,
          __ATOMIC_ACQUIRE)) {
    atomic_saturating_increment(&trace->start_rejections);
    return ITERATE_KIT_BACKPRESSURE;
  }

  uint32_t next_generation =
      __atomic_load_n(&trace->generation, __ATOMIC_RELAXED) + 1U;
  if (next_generation == 0U) {
    /* Zero means "no generation has ever run" in snapshots. */
    next_generation = 1U;
  }
  __atomic_store_n(
      &trace->generation, next_generation, __ATOMIC_RELAXED);
  __atomic_store_n(&trace->captured_samples, 0U, __ATOMIC_RELAXED);
  __atomic_store_n(&trace->first_frame_sequence, 0U, __ATOMIC_RELAXED);
  __atomic_store_n(&trace->last_frame_sequence, 0U, __ATOMIC_RELAXED);
  atomic_saturating_increment(&trace->captures_started);
  *generation = next_generation;

  /* Release publishes all generation metadata before audio sees ARMED. */
  __atomic_store_n(
      &trace->state,
      ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ARMED,
      __ATOMIC_RELEASE);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_record(
    struct iterate_kit_aec_diagnostic_trace *trace,
    uint32_t frame_sequence,
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *linear_samples,
    const int16_t *clean_samples,
    size_t sample_count) {
  if (trace == NULL || trace->initialized == 0U ||
      near_samples == NULL || reference_samples == NULL ||
      linear_samples == NULL || clean_samples == NULL ||
      sample_count != trace->options.frame_samples) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  uint32_t state = __atomic_load_n(&trace->state, __ATOMIC_ACQUIRE);
  if (state != ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ARMED &&
      state != ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_CAPTURING) {
    return ITERATE_KIT_UNAVAILABLE;
  }

  uint32_t captured =
      __atomic_load_n(&trace->captured_samples, __ATOMIC_RELAXED);
  if (state == ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ARMED) {
    /*
     * Only the audio owner can advance ARMED, so no lock is required. The
     * release store lets a control-side progress snapshot observe the first
     * sequence together with CAPTURING rather than a half-started frame.
     */
    __atomic_store_n(
        &trace->first_frame_sequence, frame_sequence, __ATOMIC_RELAXED);
    __atomic_store_n(
        &trace->last_frame_sequence, frame_sequence, __ATOMIC_RELAXED);
    __atomic_store_n(
        &trace->state,
        ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_CAPTURING,
        __ATOMIC_RELEASE);
  } else {
    const uint32_t last_sequence =
        __atomic_load_n(&trace->last_frame_sequence, __ATOMIC_RELAXED);
    if (frame_sequence != last_sequence + 1U) {
      atomic_saturating_increment(&trace->captures_aborted);
      __atomic_store_n(
          &trace->state,
          ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ABORTED,
          __ATOMIC_RELEASE);
      return ITERATE_KIT_STATE_ERROR;
    }
    __atomic_store_n(
        &trace->last_frame_sequence, frame_sequence, __ATOMIC_RELAXED);
  }

  /*
   * capture_samples is an exact multiple of frame_samples, established by
   * init. There is therefore no tail branch and no partial DSP frame which a
   * host analyzer could accidentally treat as a different acoustic epoch.
   */
  memcpy(
      trace->options.near_samples + captured,
      near_samples,
      sample_count * sizeof(*near_samples));
  memcpy(
      trace->options.reference_samples + captured,
      reference_samples,
      sample_count * sizeof(*reference_samples));
  memcpy(
      trace->options.linear_samples + captured,
      linear_samples,
      sample_count * sizeof(*linear_samples));
  memcpy(
      trace->options.clean_samples + captured,
      clean_samples,
      sample_count * sizeof(*clean_samples));
  captured += (uint32_t)sample_count;
  __atomic_store_n(
      &trace->captured_samples, captured, __ATOMIC_RELEASE);
  if (captured == trace->options.capture_samples) {
    atomic_saturating_increment(&trace->captures_completed);
    /* READY is the ownership transfer from audio writer to control reader. */
    __atomic_store_n(
        &trace->state,
        ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_READY,
        __ATOMIC_RELEASE);
  }
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_abort(
    struct iterate_kit_aec_diagnostic_trace *trace) {
  if (trace == NULL || trace->initialized == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  const uint32_t state =
      __atomic_load_n(&trace->state, __ATOMIC_ACQUIRE);
  if (state != ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ARMED &&
      state != ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_CAPTURING) {
    /*
     * A second abort must not inflate the failure count, and aborting READY
     * evidence would erase the distinction between a complete and a broken
     * acoustic epoch. Callers therefore get an explicit state error instead
     * of an apparently successful idempotent operation.
     */
    return ITERATE_KIT_STATE_ERROR;
  }

  atomic_saturating_increment(&trace->captures_aborted);
  /*
   * abort() and record() intentionally share one realtime owner. The release
   * store is consequently an ownership hand-off, not an attempted lock: after
   * ABORTED is visible, the control owner may inspect counters and release the
   * generation knowing no frame copy remains in flight.
   */
  __atomic_store_n(
      &trace->state,
      ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ABORTED,
      __ATOMIC_RELEASE);
  return ITERATE_KIT_OK;
}

void iterate_kit_aec_diagnostic_trace_snapshot(
    const struct iterate_kit_aec_diagnostic_trace *trace,
    struct iterate_kit_aec_diagnostic_trace_snapshot *snapshot) {
  if (snapshot == NULL) {
    return;
  }
  memset(snapshot, 0, sizeof(*snapshot));
  if (trace == NULL || trace->initialized == 0U) {
    return;
  }
  snapshot->state = (enum iterate_kit_aec_diagnostic_trace_state)
      __atomic_load_n(&trace->state, __ATOMIC_ACQUIRE);
  snapshot->generation =
      __atomic_load_n(&trace->generation, __ATOMIC_RELAXED);
  snapshot->captured_samples =
      __atomic_load_n(&trace->captured_samples, __ATOMIC_RELAXED);
  snapshot->first_frame_sequence =
      __atomic_load_n(&trace->first_frame_sequence, __ATOMIC_RELAXED);
  snapshot->last_frame_sequence =
      __atomic_load_n(&trace->last_frame_sequence, __ATOMIC_RELAXED);
  snapshot->captures_started =
      __atomic_load_n(&trace->captures_started, __ATOMIC_RELAXED);
  snapshot->captures_completed =
      __atomic_load_n(&trace->captures_completed, __ATOMIC_RELAXED);
  snapshot->captures_aborted =
      __atomic_load_n(&trace->captures_aborted, __ATOMIC_RELAXED);
  snapshot->start_rejections =
      __atomic_load_n(&trace->start_rejections, __ATOMIC_RELAXED);
  snapshot->read_calls =
      __atomic_load_n(&trace->read_calls, __ATOMIC_RELAXED);
}

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_read_planar(
    struct iterate_kit_aec_diagnostic_trace *trace,
    size_t sample_offset,
    size_t sample_count,
    int16_t *destination,
    size_t destination_values) {
  if (trace == NULL || trace->initialized == 0U ||
      destination == NULL || sample_count == 0U ||
      sample_offset > trace->options.capture_samples ||
      sample_count > trace->options.capture_samples - sample_offset ||
      sample_count > SIZE_MAX / 4U ||
      destination_values < sample_count * 4U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (__atomic_load_n(&trace->state, __ATOMIC_ACQUIRE) !=
      ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_READY) {
    return ITERATE_KIT_UNAVAILABLE;
  }

  /*
   * READY sample storage is immutable until this same control owner calls
   * release. Four planar copies are substantially cheaper than interleaving
   * on-device and preserve direct FFT-friendly layout for the host oracle.
   */
  memcpy(
      destination,
      trace->options.near_samples + sample_offset,
      sample_count * sizeof(*destination));
  memcpy(
      destination + sample_count,
      trace->options.reference_samples + sample_offset,
      sample_count * sizeof(*destination));
  memcpy(
      destination + sample_count * 2U,
      trace->options.linear_samples + sample_offset,
      sample_count * sizeof(*destination));
  memcpy(
      destination + sample_count * 3U,
      trace->options.clean_samples + sample_offset,
      sample_count * sizeof(*destination));
  atomic_saturating_increment(&trace->read_calls);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_release(
    struct iterate_kit_aec_diagnostic_trace *trace) {
  if (trace == NULL || trace->initialized == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  uint32_t state = __atomic_load_n(&trace->state, __ATOMIC_ACQUIRE);
  if (state != ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_READY &&
      state != ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ABORTED) {
    return ITERATE_KIT_STATE_ERROR;
  }

  /*
   * Only the control owner reads/releases a terminal generation. A CAS still
   * protects against an accidental double release without placing any work on
   * the realtime record path. Sample bytes are deliberately left intact for
   * post-mortem inspection; start() resets the published length before ARMED.
   */
  if (!__atomic_compare_exchange_n(
          &trace->state,
          &state,
          ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_IDLE,
          false,
          __ATOMIC_ACQ_REL,
          __ATOMIC_ACQUIRE)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return ITERATE_KIT_OK;
}
