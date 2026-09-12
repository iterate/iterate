#include "iterate/kit/conversation_ring.h"

#include <math.h>
#include <stddef.h>

/* An eight-octave display range, with a fixed codec-noise floor. This is a
 * visual scale, not VAD or an adaptive gain control. */
static float audio_level(uint32_t peak) {
  if (peak <= 128U) return 0.0f;
  if (peak >= 32768U) return 1.0f;
  return log2f((float)peak / 128.0f) / 8.0f;
}

static float follow(float value, float target, float elapsed_ms) {
  const float time_ms = target > value ? 45.0f : 320.0f;
  return value + (target - value) * (elapsed_ms / (time_ms + elapsed_ms));
}

void iterate_kit_conversation_ring_animate(
    struct iterate_kit_conversation_ring *animation,
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]) {
  if (animation == NULL || pixels == NULL) return;
  const uint32_t elapsed = animation->initialized
      ? now_ms - animation->updated_at_ms : 50U;
  animation->initialized = true;
  animation->updated_at_ms = now_ms;
  /* A paused app must not replay old animation history on its return. */
  const float dt = (float)(elapsed > 1000U ? 1000U : elapsed);

  if (state == NULL || state->media_failed || state->microphone_muted ||
      state->restart_armed) {
    animation->microphone = 0.0f;
    animation->speaker = 0.0f;
    animation->presence = 0.0f;
    struct iterate_kit_rgb8 colour = {0U, 0U, 0U};
    if (state != NULL) {
      if (state->media_failed) colour = (struct iterate_kit_rgb8){18U, 1U, 0U};
      else if (state->microphone_muted) colour = (struct iterate_kit_rgb8){5U, 0U, 0U};
      else colour = (struct iterate_kit_rgb8){14U, 0U, 10U};
    }
    for (uint8_t i = 0U; i < ITERATE_KIT_CONVERSATION_LIGHT_COUNT; ++i) pixels[i] = colour;
    return;
  }

  const bool listening = state->microphone_listening;
  const bool active = listening || state->conversation_active;
  const bool ready = state->network == ITERATE_KIT_NETWORK_CONNECTED &&
      state->media_ready && state->reach >= ITERATE_KIT_REACH_STREAM;
  /* Closing capture removes its indication immediately, including its decay.
   * Speaker history is likewise scoped to the current activation. */
  animation->microphone = listening
      ? follow(animation->microphone, audio_level(state->microphone_peak), dt) : 0.0f;
  animation->speaker = state->conversation_active
      ? follow(animation->speaker, audio_level(state->speaker_peak), dt) : 0.0f;
  animation->presence = listening
      ? follow(animation->presence, 1.0f, dt) : 0.0f;

  /* A still, faint white ready ring avoids visible 8-bit shimmer at the very
   * bottom of a WS2812's range. Only open capture breathes (5 seconds).
   * Its floor is immediate on capture, including while the call is opening. */
  const float phase = (float)(now_ms % 5000U) * (6.2831853f / 5000.0f);
  const float breath = 0.5f - 0.5f * cosf(phase);
  const float presence = listening && animation->presence < 0.4f
      ? 0.4f : animation->presence;
  const float base = 3.0f + presence * (3.0f + 2.0f * breath);
  const float mic = animation->microphone;
  const float speaker = animation->speaker;

  for (uint8_t i = 0U; i < ITERATE_KIT_CONVERSATION_LIGHT_COUNT; ++i) {
    const float angle = (float)i * (6.2831853f / 12.0f);
    /* Broad opposed pools, not counting bars or chasing individual LEDs.
     * A little overlap lets simultaneous input/output remain one whole ring. */
    const float lobe = 0.5f + 0.5f * cosf(angle);
    const float mic_glow = mic * (0.25f + 0.75f * lobe * lobe);
    const float speaker_glow = speaker * (0.25f + 0.75f * (1.0f - lobe) * (1.0f - lobe));
    /* Sea-green input and blue-violet output remain distinct over the white
     * floor. The first room trial's near-white pair was too hard to tell apart. */
    float red = base + 3.0f * mic_glow + 15.0f * speaker_glow;
    float green = base + 25.0f * mic_glow + 9.0f * speaker_glow;
    float blue = base + 14.0f * mic_glow + 33.0f * speaker_glow;
    if (!ready) {
      /* Gentle amber beneath the audio: connection progress must never paint
       * over capture that is already saving the user's opening words. */
      const float amber = 2.0f + 2.0f * breath;
      red += amber;
      green += amber * 0.35f;
      if (!active) blue = 0.0f;
    }
    pixels[i] = (struct iterate_kit_rgb8){
      (uint8_t)(red + 0.5f), (uint8_t)(green + 0.5f), (uint8_t)(blue + 0.5f),
    };
  }
}
