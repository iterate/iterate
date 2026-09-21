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
};

size_t iterate_kit_screen_frame_bytes(uint16_t width, uint16_t height,
                                    enum iterate_kit_screen_format format);
bool iterate_kit_screen_init(struct iterate_kit_screen *screen,
                            const struct iterate_kit_screen_driver *driver,
                            uint8_t *buffer, size_t capacity);
struct iterate_kit_module iterate_kit_screen_module(struct iterate_kit_screen *screen);
