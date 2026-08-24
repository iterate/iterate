#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Expands complete RGB565 source rows by an exact integer factor of two in
 * both axes.  The caller deliberately chooses how many rows form one strip:
 * display adapters can therefore trade a small, fixed DMA buffer against SPI
 * transaction overhead without allocating a full scaled framebuffer.
 *
 * Source and destination must not overlap.  The operation allocates nothing
 * and preserves each 16-bit pixel verbatim, which also makes it safe to call
 * after a platform-specific byte-order conversion.
 */
bool face_scale_rgb565_2x_rows(
    const uint16_t *source,
    size_t source_width,
    size_t source_row_count,
    uint16_t *destination,
    size_t destination_pixel_capacity);

#ifdef __cplusplus
}
#endif
