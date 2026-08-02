#ifndef ITERATE_KIT_HAVPE_UI_H
#define ITERATE_KIT_HAVPE_UI_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  HAVPE_UI_RING_LED_COUNT = 12,
  HAVPE_UI_RING_SECTOR_LED_COUNT = 3,
};

struct havpe_ui_rgb {
  uint8_t red;
  uint8_t green;
  uint8_t blue;
};

enum havpe_ui_network_state {
  HAVPE_UI_NETWORK_DISCONNECTED = 0,
  HAVPE_UI_NETWORK_CONNECTING,
  HAVPE_UI_NETWORK_CONNECTED,
};

/**
 * One disposable snapshot of facts owned elsewhere.
 *
 * The renderer has no clock, GPIO, Wi-Fi, audio, RMT, or heap dependency. That
 * is deliberate: presentation must remain testable on the host, while the
 * target retains sole ownership of sampling cadence and physical side effects.
 * The first nine pixels are three independent sectors; the last three stay
 * dark so another signal can be added without changing today's visual grammar.
 */
struct havpe_ring_ui_input {
  enum havpe_ui_network_state network;
  bool has_wifi_rssi;
  int32_t wifi_rssi_dbm;
  bool conversation_active;
  bool pcm_ready;
  bool pcm_failed;
  uint32_t microphone_peak;
  uint32_t speaker_peak;
  bool restart_armed;
};

void havpe_ring_ui_render(
    const struct havpe_ring_ui_input *input,
    struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT]);

enum havpe_center_button_action {
  HAVPE_CENTER_BUTTON_ACTION_NONE = 0,
  HAVPE_CENTER_BUTTON_ACTION_TOGGLE_CONVERSATION,
  HAVPE_CENTER_BUTTON_ACTION_RESTART_ARMED,
  HAVPE_CENTER_BUTTON_ACTION_RESTART,
};

/**
 * Gesture state layered after electrical debounce.
 *
 * A short press toggles a call on release. A long press first becomes visibly
 * armed, then requests reboot only after release. HAVPE's center button is
 * GPIO0, an ESP32-S3 boot strap: restarting while it is still held low can
 * enter the ROM downloader instead of the application. Keeping this policy in
 * a clock-driven model makes that hardware safety property host-testable.
 */
struct havpe_center_button_gesture {
  uint64_t pressed_at_ms;
  bool held;
  bool restart_armed;
  bool suppress_until_release;
};

void havpe_center_button_gesture_init(
    struct havpe_center_button_gesture *gesture,
    bool initially_pressed,
    uint64_t now_ms);

enum havpe_center_button_action havpe_center_button_gesture_update(
    struct havpe_center_button_gesture *gesture,
    bool pressed_edge,
    bool released_edge,
    uint64_t now_ms,
    uint32_t restart_hold_ms);

#ifdef __cplusplus
}
#endif

#endif
