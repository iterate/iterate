#include "iterate/kit/conversation_ring.h"

#include <assert.h>
#include <string.h>

static const struct iterate_kit_conversation_visual_state ready = {
  .network = ITERATE_KIT_NETWORK_CONNECTED,
  .reach = ITERATE_KIT_REACH_STREAM,
  .media_ready = true,
};

static unsigned int brightness(const struct iterate_kit_rgb8 pixels[12]) {
  unsigned int sum = 0U;
  for (unsigned int i = 0U; i < 12U; ++i) {
    sum += pixels[i].red + pixels[i].green + pixels[i].blue;
  }
  return sum;
}

static void ready_is_a_still_faint_white_ring(void) {
  struct iterate_kit_conversation_ring animation = {0};
  struct iterate_kit_rgb8 pixels[12];
  for (uint32_t ms = 0U; ms < 10000U; ms += 50U) {
    iterate_kit_conversation_ring_animate(&animation, &ready, ms, pixels);
    for (unsigned int i = 0U; i < 12U; ++i) {
      assert(pixels[i].red > 0U && pixels[i].red <= 4U);
      assert(pixels[i].red == pixels[i].green && pixels[i].green == pixels[i].blue);
    }
  }
}

static void capture_stays_visible_before_connection_and_between_words(void) {
  struct iterate_kit_conversation_visual_state state = {.microphone_listening = true};
  struct iterate_kit_conversation_ring quiet_animation = {0}, loud_animation = {0};
  struct iterate_kit_rgb8 quiet[12], loud[12];
  for (uint32_t ms = 0U; ms < 10000U; ms += 50U) {
    state.microphone_peak = 0U;
    iterate_kit_conversation_ring_animate(&quiet_animation, &state, ms, quiet);
    state.microphone_peak = 8000U;
    iterate_kit_conversation_ring_animate(&loud_animation, &state, ms, loud);
    for (unsigned int i = 0U; i < 12U; ++i) assert(quiet[i].blue >= 4U);
    assert(brightness(loud) > brightness(quiet));
  }
}

static void both_audio_sources_contribute_and_decay_gently(void) {
  struct iterate_kit_conversation_visual_state state = ready;
  state.conversation_active = true;
  state.microphone_listening = true;
  struct iterate_kit_conversation_ring animation = {0};
  struct iterate_kit_rgb8 silence[12], microphone[12], both[12], release[12];
  for (uint32_t ms = 0U; ms < 1000U; ms += 50U) {
    iterate_kit_conversation_ring_animate(&animation, &state, ms, silence);
  }
  state.microphone_peak = 8000U;
  iterate_kit_conversation_ring_animate(&animation, &state, 1000U, microphone);
  assert(brightness(microphone) > brightness(silence));
  state.speaker_peak = 12000U;
  iterate_kit_conversation_ring_animate(&animation, &state, 1050U, both);
  assert(both[6].blue > microphone[6].blue);
  /* Direction remains legible by hue even with both PCM streams moving. */
  assert(both[0].green > both[0].red && both[0].green > both[0].blue);
  assert(both[6].blue > both[6].red && both[6].blue > both[6].green);
  assert(animation.microphone > 0.0f && animation.speaker > 0.0f);
  const float peak = animation.speaker;
  state.microphone_peak = state.speaker_peak = 0U;
  iterate_kit_conversation_ring_animate(&animation, &state, 1100U, release);
  assert(animation.speaker > 0.0f && animation.speaker < peak);
  assert(brightness(release) > brightness(silence));
  for (uint32_t ms = 1150U; ms < 4000U; ms += 50U) {
    iterate_kit_conversation_ring_animate(&animation, &state, ms, release);
  }
  assert(animation.microphone < 0.001f && animation.speaker < 0.001f);
  for (unsigned int i = 0U; i < 12U; ++i) assert(release[i].red >= 5U);
}

static void closed_capture_and_ended_calls_discard_audio_history(void) {
  struct iterate_kit_conversation_visual_state state = ready;
  state.microphone_listening = state.conversation_active = true;
  state.microphone_peak = state.speaker_peak = UINT32_MAX;
  struct iterate_kit_conversation_ring animation = {0};
  struct iterate_kit_rgb8 pixels[12];
  iterate_kit_conversation_ring_animate(&animation, &state, 1000U, pixels);
  state.microphone_listening = state.conversation_active = false;
  iterate_kit_conversation_ring_animate(&animation, &state, 1050U, pixels);
  assert(animation.microphone == 0.0f && animation.speaker == 0.0f);
  for (unsigned int i = 0U; i < 12U; ++i) {
    assert(pixels[i].red == pixels[i].green && pixels[i].green == pixels[i].blue);
  }
  /* A call bit alone cannot keep the capture breath alive after gate closure. */
  state.conversation_active = true;
  state.speaker_peak = 0U;
  iterate_kit_conversation_ring_animate(&animation, &state, 1100U, pixels);
  assert(animation.presence == 0.0f);
  for (unsigned int i = 0U; i < 12U; ++i) assert(pixels[i].red == 3U);
}

static void exceptional_states_clear_audio_and_stay_unambiguous(void) {
  struct iterate_kit_conversation_visual_state state = ready;
  state.microphone_listening = state.conversation_active = true;
  state.microphone_peak = state.speaker_peak = UINT32_MAX;
  struct iterate_kit_conversation_ring animation = {0};
  struct iterate_kit_rgb8 pixels[12];
  iterate_kit_conversation_ring_animate(&animation, &state, 0U, pixels);
  state.microphone_muted = true;
  iterate_kit_conversation_ring_animate(&animation, &state, 50U, pixels);
  assert(animation.microphone == 0.0f && animation.speaker == 0.0f);
  for (unsigned int i = 0U; i < 12U; ++i) {
    assert(pixels[i].red > 0U && pixels[i].green == 0U && pixels[i].blue == 0U);
  }
  state.media_failed = true;
  iterate_kit_conversation_ring_animate(&animation, &state, 100U, pixels);
  assert(pixels[0].red > 5U && pixels[0].red > pixels[0].green);
  state.microphone_muted = state.media_failed = false;
  state.restart_armed = true;
  iterate_kit_conversation_ring_animate(&animation, &state, 150U, pixels);
  assert(pixels[0].red > 0U && pixels[0].blue > 0U && pixels[0].green == 0U);
  iterate_kit_conversation_ring_animate(&animation, NULL, 200U, pixels);
  assert(brightness(pixels) == 0U);
}

static void clipping_and_clock_wrap_remain_bounded(void) {
  struct iterate_kit_conversation_visual_state state = ready;
  state.microphone_listening = state.conversation_active = true;
  state.microphone_peak = state.speaker_peak = UINT32_MAX;
  struct iterate_kit_conversation_ring animation = {0};
  struct iterate_kit_rgb8 pixels[12];
  iterate_kit_conversation_ring_animate(&animation, &state, UINT32_MAX - 20U, pixels);
  for (uint32_t ms = 29U; ms < 10000U; ms += 50U) {
    iterate_kit_conversation_ring_animate(&animation, &state, ms, pixels);
    for (unsigned int i = 0U; i < 12U; ++i) {
      assert(pixels[i].red <= 48U && pixels[i].green <= 48U && pixels[i].blue <= 48U);
    }
    assert(animation.microphone >= 0.0f && animation.microphone <= 1.0f);
  }
}

int main(void) {
  ready_is_a_still_faint_white_ring();
  capture_stays_visible_before_connection_and_between_words();
  both_audio_sources_contribute_and_decay_gently();
  closed_capture_and_ended_calls_discard_audio_history();
  exceptional_states_clear_audio_and_stay_unambiguous();
  clipping_and_clock_wrap_remain_bounded();
  return 0;
}
