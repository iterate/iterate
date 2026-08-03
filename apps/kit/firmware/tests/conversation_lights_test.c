#include "iterate/kit/conversation_lights.h"

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

static bool is_colour(
    const struct iterate_kit_rgb8 *pixel,
    uint8_t red,
    uint8_t green,
    uint8_t blue) {
  return pixel->red == red && pixel->green == green && pixel->blue == blue;
}

/*
 * This regression exists because the first HAVPE firmware encoded its visual
 * grammar inside the HAVPE target. StackChan and Stick could be fully online
 * while presenting unrelated or absent status pixels. Pinning one pure output
 * for one semantic input makes device adapters differ only in how they emit
 * the twelve colours, not in what connected/listening/speaking means.
 */
static void renders_one_shared_three_sector_grammar(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .has_wifi_rssi = true,
    .wifi_rssi_dbm = -66,
    .conversation_active = true,
    .media_ready = true,
    .microphone_listening = true,
    .microphone_peak = 5000U,
    .speaker_peak = 1200U,
  };

  iterate_kit_conversation_lights_render(&state, pixels);

  assert(pixels[0].green > 0U && pixels[1].green > 0U);
  assert(is_colour(&pixels[2], 0U, 0U, 0U));
  assert(pixels[3].blue > 0U && pixels[4].blue > 0U);
  assert(is_colour(&pixels[5], 0U, 0U, 0U));
  assert(pixels[6].green > 0U && pixels[7].green > 0U &&
         pixels[8].green > 0U);
  for (uint8_t index = 9U;
       index < ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
}

/*
 * A ready full-duplex device that is currently silent is still listening.
 * Keeping one dim green pixel distinguishes that valid state from a dead media
 * lane; the Stick's simulated grid must preserve the same distinction as the
 * physical HAVPE and StackChan LEDs.
 */
static void distinguishes_listening_silence_from_idle(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .conversation_active = true,
    .media_ready = true,
    .microphone_listening = true,
  };

  iterate_kit_conversation_lights_render(&state, pixels);
  assert(is_colour(&pixels[3], 0U, 0U, 0U));
  assert(pixels[6].green > 0U);

  state.conversation_active = false;
  iterate_kit_conversation_lights_render(&state, pixels);
  for (uint8_t index = 3U; index < 9U; ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
}

/*
 * Stick is half duplex: an open call is not microphone capture until FRONT is
 * held. Reusing HAVPE's always-listening baseline there would give the same
 * green feedback for two materially different privacy/audio states. The
 * shared semantic model therefore carries listening explicitly rather than
 * making each adapter reinterpret `conversation_active`.
 */
static void keeps_half_duplex_microphone_dark_until_capture(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .conversation_active = true,
    .media_ready = true,
    .microphone_listening = false,
    .microphone_peak = 5000U,
  };

  iterate_kit_conversation_lights_render(&state, pixels);
  for (uint8_t index = 6U; index < 9U; ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
}

/*
 * A broken media socket must never look like quiet listening. Both audio
 * sectors become red so a physical run can attribute “nothing happened” to a
 * failed lane without serial logs or a camera-based UI oracle.
 */
static void makes_media_failure_unambiguously_red(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .conversation_active = true,
    .media_failed = true,
  };

  iterate_kit_conversation_lights_render(&state, pixels);
  for (uint8_t index = 3U; index < 9U; ++index) {
    assert(pixels[index].red > 0U);
    assert(pixels[index].green == 0U && pixels[index].blue == 0U);
  }
}

/*
 * Restart arming is safety feedback, not ordinary status. It must dominate
 * every sector so no adapter can leave stale network/audio pixels visible
 * while the user is deciding whether to release a destructive gesture.
 */
static void restart_arm_supersedes_all_status(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .conversation_active = true,
    .media_ready = true,
    .microphone_listening = true,
    .microphone_peak = UINT32_MAX,
    .speaker_peak = UINT32_MAX,
    .restart_armed = true,
  };

  iterate_kit_conversation_lights_render(&state, pixels);
  for (uint8_t index = 0U;
       index < ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    assert(pixels[index].red > 0U && pixels[index].blue > 0U);
    assert(pixels[index].green == 0U);
  }
}

int main(void) {
  renders_one_shared_three_sector_grammar();
  distinguishes_listening_silence_from_idle();
  keeps_half_duplex_microphone_dark_until_capture();
  makes_media_failure_unambiguously_red();
  restart_arm_supersedes_all_status();
  return 0;
}
