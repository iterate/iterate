#ifndef ITERATE_KIT_PLATFORMS_PCM5122_REGISTERS_H
#define ITERATE_KIT_PLATFORMS_PCM5122_REGISTERS_H

#include "iterate/kit/platforms/register_write.h"
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Reset timing and open-script length from board-table task step 17
 * (upstream ESPHome pcm5122/pcm5122.cpp sequence, with 32-bit ALEN). */
enum {
  ITERATE_KIT_PCM5122_RESET_SETTLE_MS = 20,
  ITERATE_KIT_PCM5122_INIT_WRITE_COUNT = 8,
};
/** Reset writes on page zero; delay 20 ms BETWEEN them. count may be NULL.
 * Source: board-table task step 17 / ESPHome pcm5122/pcm5122.cpp. */
const struct iterate_kit_register_write *iterate_kit_pcm5122_reset_script(size_t *count);
/** Build the complete post-reset sequence from page-zero reads of 0x25 and
 * 0x0D; out holds eight writes. Returns 0 on NULL/short capacity, unchanged.
 * Source: step 17 / ESPHome pcm5122/pcm5122.cpp; ALEN=32-bit deliberately. */
size_t iterate_kit_pcm5122_init_script(uint8_t error_detect, uint8_t pll_reference,
    struct iterate_kit_register_write *out, size_t capacity);
/** Set bit 3, clear bit 1, preserve others; step 17 / ESPHome pcm5122.cpp. */
uint8_t iterate_kit_pcm5122_error_detect_value(uint8_t current);
/** Set bits 6:4 to 001 (BCK), preserve others; step 17 / ESPHome pcm5122.cpp. */
uint8_t iterate_kit_pcm5122_pll_reference_value(uint8_t current);
/** Clamp to 100; map 100..0% to 0x30..0x99, nearest half-dB, ties up.
 * Source: step 17 / ESPHome pcm5122.cpp volume range 0 to -52.5 dB. */
uint8_t iterate_kit_pcm5122_dvol_for_percent(uint8_t percent);

#ifdef __cplusplus
}
#endif
#endif
