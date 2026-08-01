#include "iterate/kit/pcm_generation_fence.h"

#include <limits.h>
#include <string.h>

/*
 * The ring carries the command from application -> playback. Completion uses
 * a release/acquire sequence because it travels in the opposite direction;
 * adding a second ring would spend more storage and introduce a completion
 * queue even though the protocol permits exactly one outstanding target.
 */

static uint32_t atomic_load_acquire(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

static uint32_t atomic_load_relaxed(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static int32_t atomic_load_i32_acquire(const int32_t *value) {
  return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

static void atomic_store_release(uint32_t *value, uint32_t next) {
  __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

static void atomic_store_relaxed(uint32_t *value, uint32_t next) {
  __atomic_store_n(value, next, __ATOMIC_RELAXED);
}

static void atomic_store_i32_relaxed(int32_t *value, int32_t next) {
  __atomic_store_n(value, next, __ATOMIC_RELAXED);
}

static void atomic_store_i32_release(int32_t *value, int32_t next) {
  __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

static void atomic_saturating_increment(uint32_t *value) {
  uint32_t current = atomic_load_relaxed(value);
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

enum iterate_kit_status iterate_kit_pcm_generation_fence_init(
    struct iterate_kit_pcm_generation_fence *fence,
    const struct iterate_kit_pcm_generation_fence_options *options) {
  enum iterate_kit_status status;
  if (fence == NULL || options == NULL || options->reset == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(fence, 0, sizeof(*fence));
  fence->options = *options;
  status = iterate_kit_spsc_ring_init(
      &fence->commands,
      fence->command_storage,
      sizeof(fence->command_storage[0]),
      1U,
      fence->command_lengths);
  if (status != ITERATE_KIT_OK) {
    memset(fence, 0, sizeof(*fence));
    return status;
  }
  fence->initialized = true;
  return ITERATE_KIT_OK;
}

static bool target_matches(
    uint32_t left_generation,
    uint32_t left_connected,
    uint32_t right_generation,
    bool right_connected) {
  return left_generation == right_generation &&
      (left_connected != 0U) == right_connected;
}

static enum iterate_kit_status consume_completion(
    struct iterate_kit_pcm_generation_fence *fence) {
  if (atomic_load_relaxed(&fence->request_pending) == 0U ||
      atomic_load_acquire(&fence->completion_sequence) !=
          fence->pending_sequence) {
    return ITERATE_KIT_UNAVAILABLE;
  }

  /*
   * The acquire above makes the consumer's preceding result write visible.
   * Clear application-owned pending state only after copying that result; the
   * one-slot command may already be free, but a new target cannot be issued
   * until its predecessor's outcome has been classified here.
   */
  const enum iterate_kit_status result =
      (enum iterate_kit_status)atomic_load_i32_acquire(
          &fence->completion_result);
  if (result == ITERATE_KIT_OK) {
    atomic_store_relaxed(
        &fence->accepted_generation, fence->pending_generation);
    atomic_store_relaxed(
        &fence->accepted_connected, fence->pending_connected);
    /* Publish the tuple only after both constituent words are visible. */
    atomic_store_release(&fence->accepted_valid, 1U);
    atomic_store_relaxed(&fence->request_pending, 0U);
    return ITERATE_KIT_OK;
  }
  atomic_store_relaxed(&fence->request_pending, 0U);
  atomic_store_i32_release(&fence->terminal_failure, (int32_t)result);
  return result;
}

enum iterate_kit_status iterate_kit_pcm_generation_fence_poll(
    struct iterate_kit_pcm_generation_fence *fence,
    uint32_t generation,
    bool connected) {
  void *slot = NULL;
  size_t capacity = 0U;
  enum iterate_kit_status status;
  if (fence == NULL || !fence->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  const enum iterate_kit_status terminal =
      (enum iterate_kit_status)atomic_load_i32_acquire(
          &fence->terminal_failure);
  if (terminal != ITERATE_KIT_OK) {
    return terminal;
  }

  status = consume_completion(fence);
  if (status != ITERATE_KIT_UNAVAILABLE && status != ITERATE_KIT_OK) {
    return status;
  }
  if (atomic_load_acquire(&fence->accepted_valid) != 0U &&
      target_matches(
          atomic_load_relaxed(&fence->accepted_generation),
          atomic_load_relaxed(&fence->accepted_connected),
          generation,
          connected)) {
    return ITERATE_KIT_OK;
  }
  if (atomic_load_relaxed(&fence->request_pending) != 0U) {
    if (!target_matches(
            fence->pending_generation,
            fence->pending_connected,
            generation,
            connected)) {
      atomic_saturating_increment(&fence->target_backpressure);
      return ITERATE_KIT_BACKPRESSURE;
    }
    return ITERATE_KIT_UNAVAILABLE;
  }
  if (fence->next_sequence == UINT32_MAX) {
    return ITERATE_KIT_LIMIT;
  }

  status = iterate_kit_spsc_ring_write_acquire(
      &fence->commands, &slot, &capacity);
  if (status != ITERATE_KIT_OK) {
    if (status == ITERATE_KIT_BACKPRESSURE) {
      atomic_saturating_increment(&fence->protocol_failures);
      return ITERATE_KIT_STATE_ERROR;
    }
    return status;
  }
  if (slot == NULL ||
      capacity != sizeof(struct iterate_kit_pcm_generation_fence_command)) {
    (void)iterate_kit_spsc_ring_write_cancel(&fence->commands);
    atomic_saturating_increment(&fence->protocol_failures);
    return ITERATE_KIT_STATE_ERROR;
  }

  const uint32_t sequence = fence->next_sequence + 1U;
  struct iterate_kit_pcm_generation_fence_command *command = slot;
  *command = (struct iterate_kit_pcm_generation_fence_command){
    .sequence = sequence,
    .generation = generation,
    .connected = connected ? 1U : 0U,
  };
  fence->next_sequence = sequence;
  fence->pending_sequence = sequence;
  fence->pending_generation = generation;
  fence->pending_connected = connected ? 1U : 0U;
  atomic_store_relaxed(&fence->request_pending, 1U);
  status = iterate_kit_spsc_ring_write_publish(
      &fence->commands, sizeof(*command));
  if (status != ITERATE_KIT_OK) {
    atomic_store_relaxed(&fence->request_pending, 0U);
    atomic_saturating_increment(&fence->protocol_failures);
    return status;
  }
  atomic_saturating_increment(&fence->requests);
  if (fence->options.notify_consumer != NULL) {
    fence->options.notify_consumer(
        fence->options.notify_consumer_context);
  }
  return ITERATE_KIT_UNAVAILABLE;
}

enum iterate_kit_status iterate_kit_pcm_generation_fence_service(
    struct iterate_kit_pcm_generation_fence *fence) {
  const void *slot = NULL;
  size_t length = 0U;
  enum iterate_kit_status status;
  if (fence == NULL || !fence->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  status = iterate_kit_spsc_ring_read_acquire(
      &fence->commands, &slot, &length);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (slot == NULL ||
      length != sizeof(struct iterate_kit_pcm_generation_fence_command)) {
    (void)iterate_kit_spsc_ring_read_release(&fence->commands);
    atomic_saturating_increment(&fence->protocol_failures);
    atomic_saturating_increment(&fence->failures);
    /*
     * A malformed owner command cannot be correlated with a safe generation.
     * Make the fence terminal instead of leaving the application waiting on a
     * completion sequence that can now never arrive.
     */
    atomic_store_i32_release(
        &fence->terminal_failure, (int32_t)ITERATE_KIT_STATE_ERROR);
    return ITERATE_KIT_STATE_ERROR;
  }
  const struct iterate_kit_pcm_generation_fence_command command =
      *(const struct iterate_kit_pcm_generation_fence_command *)slot;

  status = fence->options.reset(fence->options.reset_context);
  const enum iterate_kit_status release_status =
      iterate_kit_spsc_ring_read_release(&fence->commands);
  if (release_status != ITERATE_KIT_OK) {
    status = release_status;
    atomic_saturating_increment(&fence->protocol_failures);
  }
  atomic_store_i32_relaxed(&fence->completion_result, (int32_t)status);
  /* Result and completed physical reset precede this release publication. */
  atomic_store_release(&fence->completion_sequence, command.sequence);
  if (status == ITERATE_KIT_OK) {
    atomic_saturating_increment(&fence->completions);
  } else {
    atomic_saturating_increment(&fence->failures);
  }
  return status;
}

void iterate_kit_pcm_generation_fence_metrics(
    const struct iterate_kit_pcm_generation_fence *fence,
    struct iterate_kit_pcm_generation_fence_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (fence == NULL || !fence->initialized) {
    return;
  }
  metrics->requests = atomic_load_relaxed(&fence->requests);
  metrics->completions = atomic_load_relaxed(&fence->completions);
  metrics->failures = atomic_load_relaxed(&fence->failures);
  metrics->target_backpressure =
      atomic_load_relaxed(&fence->target_backpressure);
  metrics->protocol_failures =
      atomic_load_relaxed(&fence->protocol_failures);
  if (atomic_load_acquire(&fence->accepted_valid) != 0U) {
    metrics->accepted_generation =
        atomic_load_relaxed(&fence->accepted_generation);
    metrics->accepted_connected =
        atomic_load_relaxed(&fence->accepted_connected) != 0U;
  }
  metrics->request_pending =
      atomic_load_relaxed(&fence->request_pending) != 0U;
  metrics->last_failure =
      (enum iterate_kit_status)atomic_load_i32_acquire(
          &fence->terminal_failure);
}
