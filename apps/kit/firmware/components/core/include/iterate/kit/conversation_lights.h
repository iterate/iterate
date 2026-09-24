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
 * No DISCONNECTED state: a device that cannot see the network is still trying
 * to. OFFLINE is not that. It is the voice loop's verdict that it has tried
 * for long enough to say so (iterate/kit/connectivity.h), and it is what lets a
 * board with nothing but a ring look different from one still coming up.
 */
enum iterate_kit_network_state {
  ITERATE_KIT_NETWORK_CONNECTING = 0,
  ITERATE_KIT_NETWORK_CONNECTED,
  /** No mount for long enough that a press is refused; see connectivity.h. */
  ITERATE_KIT_NETWORK_OFFLINE,
};

/**
 * How far up the ladder to a conversation this device has actually got.
 *
 * THE THREE NETWORK PIXELS ARE NOT WI-FI SIGNAL STRENGTH, because signal
 * strength is the wrong question. A board with three bars of Wi-Fi and no
 * capability mounted would look identical to one that can talk, and the
 * difference is the entire user-visible failure: you press the button and
 * nothing happens. What a person needs to see is how much of the chain is up.
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
  /** Three: a GPT-Live session is live — speaking now will be heard. */
  ITERATE_KIT_REACH_SESSION,
};

/**
 * One disposable semantic snapshot for every conversation-status renderer.
 *
 * This is intentionally facts rather than pixels or device-driver state. A
 * physical LED ring, StackChan's two strips, and a tiny on-screen grid must all
 * answer the same questions even though their output APIs differ. The caller
 * owns timing and samples audio elsewhere; this model owns no clock,
 * GPIO, Wi-Fi, audio, task, queue, or heap allocation.
 *
 * The diagnostic renderer reserves three pixels each for network, assistant
 * output, microphone/listening, and future use. Physical rings use the same
 * facts through conversation_ring's softer, continuous animation.
 */
struct iterate_kit_conversation_visual_state {
  enum iterate_kit_network_state network;
  /** How much of the chain to a live conversation is up; three pixels of it. */
  enum iterate_kit_reach reach;
  bool conversation_active;
  bool media_ready;
  bool media_failed;
  /** Hardware microphone rail is cut: steady dim red, except during a fault. */
  bool microphone_muted;
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
 * on, and a copy per board is a chance per board to publish "session but no
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
 * Reports whether two snapshots produce exactly the same logical lights;
 * display adapters should use this at their invalidation boundary.
 */
bool iterate_kit_conversation_lights_equal(
    const struct iterate_kit_conversation_visual_state *left,
    const struct iterate_kit_conversation_visual_state *right);

#ifdef __cplusplus
}
#endif

#endif
