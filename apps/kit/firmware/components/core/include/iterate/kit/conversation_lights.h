#ifndef ITERATE_KIT_CONVERSATION_LIGHTS_H
#define ITERATE_KIT_CONVERSATION_LIGHTS_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ITERATE_KIT_CONVERSATION_LIGHT_COUNT = 12,
  ITERATE_KIT_CONVERSATION_LIGHT_SECTOR_COUNT = 3,
};

struct iterate_kit_rgb8 {
  uint8_t red;
  uint8_t green;
  uint8_t blue;
};

/*
 * There was a third state, DISCONNECTED, and no board could ever reach it:
 * all four map `link_ready` to CONNECTED or CONNECTING, because a device that
 * cannot see the network is still trying to and saying "offline" about it was
 * a promise the fleet never kept. Its status word, its dark-red network
 * sector and its banner colour are gone with it.
 */
enum iterate_kit_network_state {
  ITERATE_KIT_NETWORK_CONNECTING = 0,
  ITERATE_KIT_NETWORK_CONNECTED,
};

/**
 * How far up the ladder to a conversation this device has actually got.
 *
 * THE THREE NETWORK PIXELS USED TO BE WI-FI SIGNAL STRENGTH, and signal
 * strength is the wrong question. A board with three bars of Wi-Fi and no
 * capability mounted looks identical to one that can talk, and the difference
 * is the entire user-visible failure: you press the button and nothing
 * happens. What a person needs to see is how much of the chain is up.
 *
 * Each rung strictly contains the ones below it, so the count is meaningful on
 * its own and a renderer never has to encode a combination. RSSI keeps its
 * precision in `health()`, where a number belongs.
 */
enum iterate_kit_reach {
  /** Nothing to talk to: no session to /api. */
  ITERATE_KIT_REACH_NONE = 0,
  /** One: the Cap'n Web session to /api is up and this device is mounted. */
  ITERATE_KIT_REACH_API,
  /** Two: a conversation stream exists and this device is subscribed to it. */
  ITERATE_KIT_REACH_STREAM,
  /** Three: a provider session is live — speaking now will be heard. */
  ITERATE_KIT_REACH_SESSION,
};

/**
 * One disposable semantic snapshot for every conversation-status renderer.
 *
 * This is intentionally facts rather than pixels or device-driver state. A
 * physical LED ring, StackChan's two strips, and a tiny on-screen grid must all
 * answer the same questions even though their output APIs differ. The caller
 * owns timing and samples RSSI/audio elsewhere; this model owns no clock,
 * GPIO, Wi-Fi, audio, task, queue, or heap allocation.
 *
 * The output grammar reserves three pixels each for network, assistant output,
 * microphone/listening, and future use. Keeping the fourth quarter dark until
 * it has an agreed meaning avoids silently shipping device-specific semantics.
 */
struct iterate_kit_conversation_visual_state {
  enum iterate_kit_network_state network;
  /** How much of the chain to a live conversation is up; three pixels of it. */
  enum iterate_kit_reach reach;
  bool has_wifi_rssi;
  int32_t wifi_rssi_dbm;
  bool conversation_active;
  bool media_ready;
  bool media_failed;
  /**
   * The microphone is open and what it hears is being kept.
   *
   * TRUE FROM THE PRESS, not from the moment a call goes live. A held button
   * means the person has started talking, and the frames from that instant are
   * queued until there is somewhere to send them — so this says "you are being
   * heard", which is the promise the meter below it makes.
   *
   * The converse is the rule that matters: while the device is speaking and
   * not listening, there must be NO microphone indication at all. A level
   * meter moving at somebody who is not being recorded is a lie the hardware
   * tells confidently.
   */
  bool microphone_listening;
  uint32_t microphone_peak;
  uint32_t speaker_peak;
  bool restart_armed;
};

/**
 * The ladder from three facts every board already knows.
 *
 * Here rather than in each device because the containment rule — a rung is
 * only reached if every rung below it is — is the property the count depends
 * on, and four copies of it is four chances to publish "session but no
 * stream", which is three pixels that mean nothing.
 *
 * `session_active` without `stream_ready` is impossible on real hardware; if
 * it is ever passed, the answer is the highest rung that is honestly whole.
 */
enum iterate_kit_reach iterate_kit_reach_from(
    bool api_ready, bool stream_ready, bool session_active);

/**
 * Renders exactly twelve logical RGB pixels from one semantic snapshot.
 *
 * Output is always fully initialized, including for a NULL input. Adapters may
 * scale brightness or convert colour depth at their hardware boundary, but
 * must not reinterpret sectors or retain old pixels between calls.
 */
void iterate_kit_conversation_lights_render(
    const struct iterate_kit_conversation_visual_state *state,
    struct iterate_kit_rgb8
        pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]);

/**
 * Reports whether two snapshots produce exactly the same logical lights.
 *
 * This is view equality, not telemetry equality: two RSSI readings inside the
 * same displayed band are deliberately equal. Display adapters should use
 * this at their invalidation boundary so high-resolution diagnostic noise
 * cannot trigger pointless SPI traffic or visible flicker. Precise readings
 * remain available through metrics and are not discarded by this function.
 */
bool iterate_kit_conversation_lights_equal(
    const struct iterate_kit_conversation_visual_state *left,
    const struct iterate_kit_conversation_visual_state *right);

#ifdef __cplusplus
}
#endif

#endif
