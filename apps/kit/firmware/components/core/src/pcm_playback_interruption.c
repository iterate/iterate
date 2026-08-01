#include "iterate/kit/pcm_playback_interruption.h"

#include <limits.h>
#include <string.h>

static uint32_t atomic_load_relaxed(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
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

enum iterate_kit_status iterate_kit_pcm_playback_interruption_init(
    struct iterate_kit_pcm_playback_interruption *interruption,
    const struct iterate_kit_pcm_playback_interruption_options *options) {
  struct iterate_kit_pcm_generation_fence_options fence_options;
  enum iterate_kit_status status;
  if (interruption == NULL || options == NULL || options->reset == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(interruption, 0, sizeof(*interruption));
  fence_options = (struct iterate_kit_pcm_generation_fence_options){
    .reset = options->reset,
    .reset_context = options->reset_context,
    .notify_consumer = options->notify_consumer,
    .notify_consumer_context = options->notify_consumer_context,
  };
  status = iterate_kit_pcm_generation_fence_init(
      &interruption->fence, &fence_options);
  if (status != ITERATE_KIT_OK) {
    memset(interruption, 0, sizeof(*interruption));
    return status;
  }
  interruption->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_playback_interruption_request(
    struct iterate_kit_pcm_playback_interruption *interruption,
    uint32_t *token) {
  uint32_t candidate;
  enum iterate_kit_status status;
  if (interruption == NULL || token == NULL || !interruption->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *token = 0U;
  if (interruption->active) {
    atomic_saturating_increment(
        &interruption->admission_backpressure);
    return ITERATE_KIT_BACKPRESSURE;
  }
  if (interruption->next_token == UINT32_MAX) {
    return ITERATE_KIT_LIMIT;
  }

  candidate = interruption->next_token + 1U;
  status = iterate_kit_pcm_generation_fence_poll(
      &interruption->fence, candidate, true);
  if (status != ITERATE_KIT_UNAVAILABLE) {
    /*
     * A new monotonically increasing target cannot already be acknowledged.
     * Any real fence failure is preserved verbatim; an impossible OK instead
     * becomes a state error so it cannot be mistaken for a completed reset.
     */
    return status == ITERATE_KIT_OK
        ? ITERATE_KIT_STATE_ERROR
        : status;
  }
  interruption->next_token = candidate;
  interruption->active_token = candidate;
  interruption->active = true;
  *token = candidate;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_playback_interruption_poll(
    struct iterate_kit_pcm_playback_interruption *interruption,
    uint32_t token) {
  enum iterate_kit_status status;
  if (interruption == NULL || !interruption->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!interruption->active || token != interruption->active_token) {
    return ITERATE_KIT_STATE_ERROR;
  }
  status = iterate_kit_pcm_generation_fence_poll(
      &interruption->fence, token, true);
  if (status != ITERATE_KIT_UNAVAILABLE) {
    /*
     * The caller has now observed the only terminal result for this token.
     * Releasing the admission slot here—not in service()—prevents the audio
     * owner from racing a second request ahead of completion consumption.
     */
    interruption->active = false;
  }
  return status;
}

enum iterate_kit_status iterate_kit_pcm_playback_interruption_service(
    struct iterate_kit_pcm_playback_interruption *interruption) {
  if (interruption == NULL || !interruption->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return iterate_kit_pcm_generation_fence_service(
      &interruption->fence);
}

void iterate_kit_pcm_playback_interruption_metrics(
    const struct iterate_kit_pcm_playback_interruption *interruption,
    struct iterate_kit_pcm_playback_interruption_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (interruption == NULL || !interruption->initialized) {
    return;
  }
  iterate_kit_pcm_generation_fence_metrics(
      &interruption->fence, &metrics->fence);
  metrics->active_token = interruption->active_token;
  metrics->admission_backpressure =
      atomic_load_relaxed(&interruption->admission_backpressure);
  metrics->active = interruption->active;
}
