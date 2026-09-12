#ifndef ITERATE_KIT_CONVERSATION_RING_H
#define ITERATE_KIT_CONVERSATION_RING_H

#include "iterate/kit/conversation_lights.h"

#ifdef __cplusplus
extern "C" {
#endif

/** App-owned animation memory. Zero-initialize once; no audio task touches it. */
struct iterate_kit_conversation_ring {
  uint32_t updated_at_ms;
  bool initialized;
  float microphone;
  float speaker;
  float presence;
};

/**
 * A quiet physical ring: white when ready, breathing during capture, with
 * broad microphone and local-playout blooms. Silence never hides open capture.
 * Uses measured peaks only; this does not infer speech, turns, or thinking.
 * Muting and faults clear decorative history immediately. The caller supplies
 * monotonic milliseconds and emits the twelve logical pixels at about 20 Hz.
 * Larger rings repeat adjacent pixels; screens retain the diagnostic renderer.
 */
void iterate_kit_conversation_ring_animate(
    struct iterate_kit_conversation_ring *animation,
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]);

#ifdef __cplusplus
}
#endif
#endif
