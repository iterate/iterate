#ifndef ITERATE_KIT_PCM_PLAYBACK_INTERRUPTION_H
#define ITERATE_KIT_PCM_PLAYBACK_INTERRUPTION_H

#include "iterate/kit/pcm_generation_fence.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct iterate_kit_pcm_playback_interruption_options {
  iterate_kit_pcm_generation_fence_reset_fn reset;
  void *reset_context;
  iterate_kit_pcm_generation_fence_notify_fn notify_consumer;
  void *notify_consumer_context;
};

struct iterate_kit_pcm_playback_interruption_metrics {
  struct iterate_kit_pcm_generation_fence_metrics fence;
  uint32_t active_token;
  uint32_t admission_backpressure;
  bool active;
};

/**
 * Constant-space handshake for one assistant-speech interruption.
 *
 * A control/WebSocket owner calls request() and retains the returned token.
 * The priority playback owner calls service() at its next hardware boundary;
 * only that owner is allowed to destroy retained samples and queued downlink.
 * The control owner polls the token and may acknowledge userspace only after
 * poll() returns OK. No side waits, allocates, or calls into the other task.
 *
 * There is one in-flight token and no retry queue. An interruption describes
 * the desired *current* speaker state, so accumulating several reset jobs
 * would spend CPU on obsolete lifecycle work and delay fresh response audio.
 * A caller that receives BACKPRESSURE must keep the existing operation as the
 * authoritative barrier rather than enqueueing another one elsewhere.
 */
struct iterate_kit_pcm_playback_interruption {
  struct iterate_kit_pcm_generation_fence fence;
  uint32_t next_token;
  uint32_t active_token;
  uint32_t admission_backpressure;
  bool active;
  bool initialized;
};

enum iterate_kit_status iterate_kit_pcm_playback_interruption_init(
    struct iterate_kit_pcm_playback_interruption *interruption,
    const struct iterate_kit_pcm_playback_interruption_options *options);

/** Control-owner admission. OK means queued, not physically complete. */
enum iterate_kit_status iterate_kit_pcm_playback_interruption_request(
    struct iterate_kit_pcm_playback_interruption *interruption,
    uint32_t *token);

/** Control-owner completion poll for the exact admitted token. */
enum iterate_kit_status iterate_kit_pcm_playback_interruption_poll(
    struct iterate_kit_pcm_playback_interruption *interruption,
    uint32_t token);

/** Playback-owner service; UNAVAILABLE means there is no pending reset. */
enum iterate_kit_status iterate_kit_pcm_playback_interruption_service(
    struct iterate_kit_pcm_playback_interruption *interruption);

void iterate_kit_pcm_playback_interruption_metrics(
    const struct iterate_kit_pcm_playback_interruption *interruption,
    struct iterate_kit_pcm_playback_interruption_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
