#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
  RLCD_DISPLAY_WIDTH = 400,
  RLCD_DISPLAY_HEIGHT = 300,
  RLCD_DISPLAY_BITMAP_BYTES = RLCD_DISPLAY_WIDTH * RLCD_DISPLAY_HEIGHT / 8,
};

bool rlcd_display_start(void);
bool rlcd_display_show(const char *title, const char *status);
/** Draw a 400x300 row-major 1bpp bitmap. The high bit is the leftmost pixel;
 * one means black. The board maps it to the panel's unusual column/page wire
 * format here, so callers never need controller-specific coordinates. */
bool rlcd_display_show_bitmap(const uint8_t *bitmap, size_t length);
