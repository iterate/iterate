#ifndef ITERATE_KIT_PCM_GENERATION_FENCE_H
#define ITERATE_KIT_PCM_GENERATION_FENCE_H

#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum iterate_kit_status
(*iterate_kit_pcm_generation_fence_reset_fn)(void *context);
typedef void (*iterate_kit_pcm_generation_fence_notify_fn)(void *context);

struct iterate_kit_pcm_generation_fence_options {
  /*
   * Runs only on the physical playback owner. It must synchronously make old
   * retained samples, application-lane items, and hardware-visible playback
   * state unreachable before returning OK. A failure is terminal for the
   * fence: admitting a later socket after an incomplete purge is unsafe.
   */
  iterate_kit_pcm_generation_fence_reset_fn reset;
  void *reset_context;

  /*
   * Optional constant-space wake issued after a command is published. The
   * command ring, not the notification, owns delivery; coalescing task wakes
   * is therefore harmless. A deterministic host owner may leave it NULL.
   */
  iterate_kit_pcm_generation_fence_notify_fn notify_consumer;
  void *notify_consumer_context;
};

struct iterate_kit_pcm_generation_fence_metrics {
  uint32_t requests;
  uint32_t completions;
  uint32_t failures;
  uint32_t target_backpressure;
  uint32_t protocol_failures;
  uint32_t accepted_generation;
  bool accepted_connected;
  bool request_pending;
  enum iterate_kit_status last_failure;
};

struct iterate_kit_pcm_generation_fence_command {
  uint32_t sequence;
  uint32_t generation;
  uint8_t connected;
};

/**
 * One-command handshake between a socket/application owner and playback.
 *
 * Emptying a software queue is insufficient at a WebSocket generation edge:
 * a speaker owner may retain a frame suffix and cyclic DMA may still select
 * old descriptors. poll() therefore keeps receive admission closed while one
 * exact `{generation, connected}` target crosses a one-slot SPSC mailbox.
 * service() runs the physical purge on the playback owner and release-publishes
 * its result. Only a successful acknowledgement makes a later poll return OK.
 *
 * There is deliberately no queue of generation changes. The transport holds
 * one target until acknowledgement, so a second target while work is pending
 * is an ownership defect and explicit BACKPRESSURE. Queueing several resets
 * would preserve obsolete lifecycle work and delay current audio recovery.
 *
 * Exactly one application owner calls poll(); exactly one playback owner calls
 * service(). Calls allocate nothing and wait on no lock. The reset callback's
 * own physical work is bounded by the platform and happens only at lifecycle
 * edges, never once per PCM frame.
 */
struct iterate_kit_pcm_generation_fence {
  struct iterate_kit_pcm_generation_fence_options options;
  struct iterate_kit_spsc_ring commands;
  struct iterate_kit_pcm_generation_fence_command command_storage[1];
  size_t command_lengths[1];

  /*
   * Application-owner protocol state. The accepted tuple and pending flag are
   * also sampled by the diagnostics owner, so every access to those four
   * words is atomic even though only the application owner may mutate them.
   * This avoids turning an otherwise harmless metrics scrape into undefined C
   * behaviour; it does not make poll() safe for multiple application owners.
   */
  uint32_t next_sequence;
  uint32_t pending_sequence;
  uint32_t pending_generation;
  uint32_t pending_connected;
  uint32_t request_pending;
  uint32_t accepted_generation;
  uint32_t accepted_connected;
  uint32_t accepted_valid;

  /* Consumer completion publication and sticky terminal result. */
  uint32_t completion_sequence;
  int32_t completion_result;
  int32_t terminal_failure;

  /* Relaxed atomic diagnostics; these do not transfer protocol ownership. */
  uint32_t requests;
  uint32_t completions;
  uint32_t failures;
  uint32_t target_backpressure;
  uint32_t protocol_failures;
  bool initialized;
};

enum iterate_kit_status iterate_kit_pcm_generation_fence_init(
    struct iterate_kit_pcm_generation_fence *fence,
    const struct iterate_kit_pcm_generation_fence_options *options);

/** Application-side, nonblocking admission poll. */
enum iterate_kit_status iterate_kit_pcm_generation_fence_poll(
    struct iterate_kit_pcm_generation_fence *fence,
    uint32_t generation,
    bool connected);

/** Playback-owner service; UNAVAILABLE means there was no command. */
enum iterate_kit_status iterate_kit_pcm_generation_fence_service(
    struct iterate_kit_pcm_generation_fence *fence);

void iterate_kit_pcm_generation_fence_metrics(
    const struct iterate_kit_pcm_generation_fence *fence,
    struct iterate_kit_pcm_generation_fence_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
