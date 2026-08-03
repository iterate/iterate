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

enum iterate_kit_network_state {
  ITERATE_KIT_NETWORK_DISCONNECTED = 0,
  ITERATE_KIT_NETWORK_CONNECTING,
  ITERATE_KIT_NETWORK_CONNECTED,
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
  bool has_wifi_rssi;
  int32_t wifi_rssi_dbm;
  bool conversation_active;
  bool media_ready;
  bool media_failed;
  bool microphone_listening;
  uint32_t microphone_peak;
  uint32_t speaker_peak;
  bool restart_armed;
};

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

#ifdef __cplusplus
}
#endif

#endif
