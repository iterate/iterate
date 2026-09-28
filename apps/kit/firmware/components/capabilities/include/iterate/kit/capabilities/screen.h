#pragma once

#include "iterate/kit/peer.h"

/* Row-major pixels, each row padded to whole bytes. MONO1 is MSB-first,
 * 1=black. GRAY4 is high nibble first, 0=black/15=white. RGB565 is big-endian.
 * These are wire formats; board drivers own controller-native conversion. */
enum iterate_kit_screen_format {
  ITERATE_KIT_SCREEN_MONO1 = 1,
  ITERATE_KIT_SCREEN_GRAY4 = 2,
  ITERATE_KIT_SCREEN_RGB565 = 4,
};
enum iterate_kit_screen_state {
  ITERATE_KIT_SCREEN_IDLE,
  ITERATE_KIT_SCREEN_PENDING,
  ITERATE_KIT_SCREEN_SHOWN,
  ITERATE_KIT_SCREEN_FAILED,
};
struct iterate_kit_screen_driver {
  uint16_t width, height;
  uint8_t formats;
  enum iterate_kit_screen_format preferred_format;
  uint32_t refresh_timeout_ms;
  bool partial_refresh;
  /* submit borrows bytes until state() stops returning PENDING. The module
   * refuses another upload/clear while a driver is reading that buffer. */
  bool (*submit)(void *context, enum iterate_kit_screen_format format,
                 const uint8_t *bytes, size_t length);
  enum iterate_kit_screen_state (*state)(void *context);
  void *context;
};
struct iterate_kit_screen {
  struct iterate_kit_screen_driver driver;
  uint8_t *bitmap;
  size_t capacity, expected_bytes, next_offset;
  char encoded[5500];
  enum iterate_kit_screen_format format;
  uint32_t uploads_started, uploads_completed, upload_failures, bytes_received;
  uint32_t upload_id;
  bool uploading, showing_image, refresh_pending;
  /* The last chunk's answer, owed until the refresh leaves PENDING (screen.c). */
  struct capnweb_responder shown_answer;
  bool shown_answer_owed;
};

size_t iterate_kit_screen_frame_bytes(uint16_t width, uint16_t height,
                                    enum iterate_kit_screen_format format);

/* The status text a 400x300 monochrome board shows while no image is lent. */
enum {
  ITERATE_KIT_SCREEN_STATUS_WIDTH = 400,
  ITERATE_KIT_SCREEN_STATUS_HEIGHT = 300,
  ITERATE_KIT_SCREEN_STATUS_BYTES =
      ITERATE_KIT_SCREEN_STATUS_WIDTH / 8 * ITERATE_KIT_SCREEN_STATUS_HEIGHT,
};
/** Clear `mono1`, a 400x300 MONO1 frame of ITERATE_KIT_SCREEN_STATUS_BYTES, and
 *  draw ITERATE with `title` and `status` beneath it, each line centred, in a
 *  5x7 font of A-Z; any other character is a space, and a line too wide for the
 *  panel is left out. */
void iterate_kit_screen_draw_status(uint8_t *mono1, const char *title, const char *status);
bool iterate_kit_screen_init(struct iterate_kit_screen *screen,
                            const struct iterate_kit_screen_driver *driver,
                            uint8_t *buffer, size_t capacity);
struct iterate_kit_module iterate_kit_screen_module(struct iterate_kit_screen *screen);
