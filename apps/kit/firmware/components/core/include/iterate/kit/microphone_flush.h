#ifndef ITERATE_KIT_MICROPHONE_FLUSH_H
#define ITERATE_KIT_MICROPHONE_FLUSH_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/voice_device_profile.h"

/* Native capture queues keep ownership. Call only when the stream can send;
 * advance last_flush_ms only after a successful append. */
static inline size_t iterate_kit_microphone_flush_frames(
    size_t queued, bool capturing, uint64_t last_flush_ms, uint64_t now_ms) {
  if (queued == 0U) return 0U;
  if (capturing && queued < ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND &&
      last_flush_ms != 0U && now_ms >= last_flush_ms &&
      now_ms - last_flush_ms < ITERATE_KIT_VOICE_MIC_FLUSH_MS) return 0U;
  return queued < ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND
      ? queued : ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND;
}

#endif
