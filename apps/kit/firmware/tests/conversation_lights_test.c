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
    .reach = ITERATE_KIT_REACH_STREAM,
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
  assert(pixels[3].blue > 0U);
  assert(pixels[6].green > 0U);

  /*
   * Ending the call is no longer what darkens the microphone — that used to be
   * asserted here and it is the assumption this sector was changed to drop.
   * Listening outlives the call in both directions: a press listens before one
   * exists, and a call ending does not un-hear what is still being captured.
   * The SPEAKER goes dark, because there is nothing left to play.
   */
  state.conversation_active = false;
  iterate_kit_conversation_lights_render(&state, pixels);
  for (uint8_t index = 3U; index < 6U; ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
  assert(pixels[6].green > 0U);

  /* Not listening and no call: now everything below the ladder is dark. */
  state.microphone_listening = false;
  iterate_kit_conversation_lights_render(&state, pixels);
  for (uint8_t index = 3U; index < 9U; ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
}

/*
 * Stick is deliberately silent between manual PTT turns, but that silence
 * must not look identical to a call whose /pcm lane never connected. The
 * speaker sector therefore carries one dim blue readiness pixel for the
 * lifetime of an active, media-ready call. Amplitude may grow that meter; it
 * is not required merely to prove the lane is alive.
 */
static void keeps_one_media_ready_pixel_visible_between_ptt_turns(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .conversation_active = true,
    .media_ready = true,
  };

  iterate_kit_conversation_lights_render(&state, pixels);
  assert(pixels[3].blue > 0U);
  assert(is_colour(&pixels[4], 0U, 0U, 0U));
  assert(is_colour(&pixels[5], 0U, 0U, 0U));
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
 * /pcm is preconnected before a person starts a call. A terminal media fault
 * can therefore happen while the conversation bit is false; hiding it until
 * TOP is pressed made a dead Stick present the same idle ring as a healthy
 * one. Failure is a transport fact, so both audio sectors must stay red even
 * outside a conversation.
 */
static void keeps_media_failure_visible_while_idle(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .conversation_active = false,
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

/*
 * Wi-Fi RSSI naturally moves by a few dB while the device is stationary. The
 * Stick originally compared that raw telemetry and repainted its whole status
 * panel every second, producing visible flicker even though the three network
 * lights had not changed. Output equality is the correct invalidation seam:
 * diagnostics retain precise RSSI while renderers wake only for a visible
 * semantic change.
 */
static void treats_rssi_changes_as_the_same_visual_output(void) {
  const struct iterate_kit_conversation_visual_state first = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .reach = ITERATE_KIT_REACH_API,
    .has_wifi_rssi = true,
    .wifi_rssi_dbm = -73,
  };
  struct iterate_kit_conversation_visual_state second = first;
  second.wifi_rssi_dbm = -77;
  assert(iterate_kit_conversation_lights_equal(&first, &second));

  /*
   * And now every RSSI is the same picture, because these pixels stopped
   * being a signal meter. What changes them is the ladder.
   */
  second.wifi_rssi_dbm = -30;
  assert(iterate_kit_conversation_lights_equal(&first, &second));
  second.reach = ITERATE_KIT_REACH_SESSION;
  assert(!iterate_kit_conversation_lights_equal(&first, &second));
}

/*
 * THE LADDER, one pixel per rung, which is the whole point of the change.
 *
 * Three bars of Wi-Fi over a board that cannot place a call was
 * indistinguishable from a board that could, and the difference is exactly the
 * failure people hit: press the button, nothing happens. Each rung strictly
 * contains the ones below it so the COUNT is the message.
 */
static void the_network_pixels_count_how_far_up_the_ladder_we_are(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .reach = ITERATE_KIT_REACH_API,
  };

  iterate_kit_conversation_lights_render(&state, pixels);
  assert(pixels[0].green > 0U);
  assert(is_colour(&pixels[1], 0U, 0U, 0U));
  assert(is_colour(&pixels[2], 0U, 0U, 0U));

  state.reach = ITERATE_KIT_REACH_STREAM;
  iterate_kit_conversation_lights_render(&state, pixels);
  assert(pixels[0].green > 0U && pixels[1].green > 0U);
  assert(is_colour(&pixels[2], 0U, 0U, 0U));

  state.reach = ITERATE_KIT_REACH_SESSION;
  iterate_kit_conversation_lights_render(&state, pixels);
  assert(pixels[0].green > 0U && pixels[1].green > 0U &&
         pixels[2].green > 0U);

  /* Online with nothing reachable is amber, not dark and not green. */
  state.reach = ITERATE_KIT_REACH_NONE;
  iterate_kit_conversation_lights_render(&state, pixels);
  assert(pixels[0].red > 0U && pixels[0].green > 0U);
  assert(is_colour(&pixels[1], 0U, 0U, 0U));
}

/*
 * A PRESS IS ALREADY LISTENING, before there is a call to listen into.
 *
 * The microphone sector used to live under `conversation_active`, so the
 * seconds between the button going down and the provider answering showed
 * nothing — during which the device IS capturing and queueing. Somebody
 * talking into that gap had no way to know they were being heard.
 */
static void a_press_lights_the_microphone_before_the_call_exists(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state pressed = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .reach = ITERATE_KIT_REACH_API,
    .conversation_active = false,
    .media_ready = false,
    .microphone_listening = true,
    .microphone_peak = 6000U,
  };

  iterate_kit_conversation_lights_render(&pressed, pixels);
  assert(pixels[6].green > 0U && pixels[7].green > 0U &&
         pixels[8].green > 0U);
  /* Nothing is playing yet, so the speaker sector stays dark. */
  assert(is_colour(&pixels[3], 0U, 0U, 0U));
}

/*
 * AND THE CONVERSE, which is the rule that actually matters: a device that is
 * speaking and not listening shows no microphone at all. A level meter moving
 * at somebody who is not being recorded is a lie the hardware tells
 * confidently, and this is the only test that can catch it.
 */
static void a_device_that_is_speaking_shows_no_microphone_level(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state speaking = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .reach = ITERATE_KIT_REACH_SESSION,
    .conversation_active = true,
    .media_ready = true,
    .microphone_listening = false,
    /* The room is loud — somebody is talking over the answer. */
    .microphone_peak = 30000U,
    .speaker_peak = 5000U,
  };

  iterate_kit_conversation_lights_render(&speaking, pixels);
  for (uint8_t index = 6U; index < 9U; ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
  assert(pixels[3].blue > 0U);
}

/*
 * Media still coming up must not paint the microphone either. It used to fill
 * both sectors amber, which put a "pending" block exactly where the listening
 * answer belongs.
 */
static void media_coming_up_does_not_claim_the_microphone(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state starting = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .reach = ITERATE_KIT_REACH_SESSION,
    .conversation_active = true,
    .media_ready = false,
    .microphone_listening = false,
  };

  iterate_kit_conversation_lights_render(&starting, pixels);
  assert(pixels[3].red > 0U);
  for (uint8_t index = 6U; index < 9U; ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
}

/*
 * The rung is the highest one that is WHOLE. A device cannot honestly show
 * three lights because a provider session exists while its stream does not —
 * the count is only readable if each rung implies the ones beneath it.
 */
static void a_rung_is_only_reached_when_everything_below_it_is(void) {
  assert(iterate_kit_reach_from(false, false, false) == ITERATE_KIT_REACH_NONE);
  assert(iterate_kit_reach_from(true, false, false) == ITERATE_KIT_REACH_API);
  assert(iterate_kit_reach_from(true, true, false) == ITERATE_KIT_REACH_STREAM);
  assert(iterate_kit_reach_from(true, true, true) == ITERATE_KIT_REACH_SESSION);

  /* Impossible inputs answer with the truth, never the flattering rung. */
  assert(iterate_kit_reach_from(false, true, true) == ITERATE_KIT_REACH_NONE);
  assert(iterate_kit_reach_from(true, false, true) == ITERATE_KIT_REACH_API);
}

int main(void) {
  renders_one_shared_three_sector_grammar();
  distinguishes_listening_silence_from_idle();
  keeps_one_media_ready_pixel_visible_between_ptt_turns();
  keeps_half_duplex_microphone_dark_until_capture();
  makes_media_failure_unambiguously_red();
  keeps_media_failure_visible_while_idle();
  restart_arm_supersedes_all_status();
  treats_rssi_changes_as_the_same_visual_output();
  the_network_pixels_count_how_far_up_the_ladder_we_are();
  a_rung_is_only_reached_when_everything_below_it_is();
  a_press_lights_the_microphone_before_the_call_exists();
  a_device_that_is_speaking_shows_no_microphone_level();
  media_coming_up_does_not_claim_the_microphone();
  return 0;
}
