#ifndef ITERATE_KIT_AUDIO_INTENT_RECONCILER_H
#define ITERATE_KIT_AUDIO_INTENT_RECONCILER_H

#include "iterate/kit/audio.h"
#include "iterate/kit/device_events.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Board-owner operations behind one audio-policy intent reconciler.
 *
 * The lower audio owner normally exposes a one-slot SPSC command mailbox. A
 * control event must therefore never assume that one rejected stop will be
 * replayed for it: device-event handlers consume each event exactly once. The
 * reconciler retains only the newest desired boolean and retries it from the
 * cooperative owner loop. It does not retain PCM, command history, or timing.
 */
struct iterate_kit_audio_intent_ops {
  void *context;
  enum iterate_kit_status (*request_uplink_active)(
      void *context, bool active);
  void (*request_playback_reset)(void *context);
};

struct iterate_kit_audio_intent_metrics {
  uint32_t intent_edges;
  uint32_t commands_accepted;
  uint32_t command_backpressure;
  uint32_t command_failures;
  uint32_t playback_resets;
  bool desired_uplink_active;
  bool command_pending;
  bool failed;
};

struct iterate_kit_audio_intent_reconciler {
  struct iterate_kit_audio_intent_ops ops;
  enum iterate_kit_audio_mode mode;
  uint32_t intent_edges;
  uint32_t commands_accepted;
  uint32_t command_backpressure;
  uint32_t command_failures;
  uint32_t playback_resets;
  enum iterate_kit_status failure;
  bool desired_uplink_active;
  bool applied_uplink_active;
  bool command_pending;
  bool has_applied_state;
  bool initialized;
};

enum iterate_kit_status iterate_kit_audio_intent_reconciler_init(
    struct iterate_kit_audio_intent_reconciler *reconciler,
    enum iterate_kit_audio_mode mode,
    const struct iterate_kit_audio_intent_ops *ops);

/**
 * Device-event handler suitable for a profile control-driver callback.
 *
 * It records desired state only. In PTT mode press/release owns publication;
 * in full-duplex AEC mode conversation start/end owns one continuous server-
 * VAD stream and PTT events are rejected. The caller must invoke poll() from
 * the same cooperative owner after draining its bounded event batch. This
 * separation lets a burst collapse to the safe final state and keeps the RPC
 * path independent of audio-task scheduling.
 */
enum iterate_kit_status iterate_kit_audio_intent_reconciler_handle(
    void *context, const struct iterate_kit_device_event *event);

/** Makes at most one nonblocking lower-owner request. */
enum iterate_kit_status iterate_kit_audio_intent_reconciler_poll(
    struct iterate_kit_audio_intent_reconciler *reconciler);

void iterate_kit_audio_intent_reconciler_metrics(
    const struct iterate_kit_audio_intent_reconciler *reconciler,
    struct iterate_kit_audio_intent_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
