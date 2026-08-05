#ifndef ITERATE_KIT_M5STICKS3_BOARD_H
#define ITERATE_KIT_M5STICKS3_BOARD_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Bring up M5Unified for this board and fail closed on identity.
 *
 * M5.begin() is retained for board detection, display/input setup, and its
 * documented M5PM1 GPIO mux. Both generic audio objects are ended
 * immediately: playback uses a direct ESP-IDF channel and must never coexist
 * with M5Unified's mixer task. Returns false when the detected board is not
 * an M5StickS3, so a wrong image cannot drive another board's pins.
 */
bool m5sticks3_board_init(void);

/** Poll M5Unified's buttons; call from the app loop. */
void m5sticks3_board_poll(void);

/** The front button's debounced level: held means the microphone is wanted. */
bool m5sticks3_board_talk_held(void);

/** One latched press of the side button (consumed on read). */
bool m5sticks3_board_take_side_press(void);

/* --- the 240x135 status screen -------------------------------------------- */

enum m5sticks3_ui_state {
  M5STICKS3_UI_IDLE = 0,
  M5STICKS3_UI_CONNECTING,
  M5STICKS3_UI_LISTENING,
  M5STICKS3_UI_SPEAKING,
};

void m5sticks3_ui_set_state(enum m5sticks3_ui_state state);
void m5sticks3_ui_set_status(const char *status);
void m5sticks3_ui_set_call_active(bool active);
void m5sticks3_ui_set_link_ready(bool ready);

/**
 * The user's call INTENT, owned locally exactly like the Waveshare port:
 * the bridge ending a call clears the belief, never the intent, so transient
 * server-side call loss reconnects instead of waiting for another press.
 */
void m5sticks3_ui_request_call(bool wanted);
bool m5sticks3_ui_call_requested(void);

/** Throttled repaint of whatever changed; call from the app loop only. */
/**
 * Frames of the avatar actually pushed to the panel, and renders refused.
 *
 * A face is the one part of this device a person judges by eye, which makes it
 * the easiest thing to believe is working when it is not — so it gets a number
 * like everything else. Zero while the device is up means no face is being
 * drawn, whatever the screen appears to show.
 */
uint32_t m5sticks3_board_face_frames(void);
uint32_t m5sticks3_board_face_failures(void);

void m5sticks3_ui_tick(void);

#ifdef __cplusplus
}
#endif

#endif
