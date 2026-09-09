/* Translated from upstream ESPHome pcm5122/pcm5122.cpp as recorded in board-table task step 17. */
#include "iterate/kit/platforms/pcm5122_registers.h"
#include <string.h>

const struct iterate_kit_register_write *iterate_kit_pcm5122_reset_script(size_t *count) {
  static const struct iterate_kit_register_write writes[] = {{0x01, 0x10}, {0x01, 0x00}};
  if (count != NULL) *count = sizeof(writes) / sizeof(writes[0]);
  return writes;
}

size_t iterate_kit_pcm5122_init_script(uint8_t error_detect, uint8_t pll_reference,
    struct iterate_kit_register_write *out, size_t capacity) {
  if (out == NULL || capacity < ITERATE_KIT_PCM5122_INIT_WRITE_COUNT) return 0;
  const struct iterate_kit_register_write writes[] = {
    {0x00, 0x00}, {0x25, iterate_kit_pcm5122_error_detect_value(error_detect)},
    {0x28, 0x03}, {0x2A, 0x11}, {0x00, 0x01}, {0x02, 0x00},
    {0x00, 0x00}, {0x0D, iterate_kit_pcm5122_pll_reference_value(pll_reference)},
  };
  memcpy(out, writes, sizeof(writes));
  return sizeof(writes) / sizeof(writes[0]);
}

uint8_t iterate_kit_pcm5122_error_detect_value(uint8_t current) {
  return (uint8_t)((current | 0x08U) & ~0x02U);
}

uint8_t iterate_kit_pcm5122_pll_reference_value(uint8_t current) {
  return (uint8_t)((current & ~0x70U) | 0x10U);
}

uint8_t iterate_kit_pcm5122_dvol_for_percent(uint8_t percent) {
  const unsigned int clamped = percent > 100U ? 100U : percent;
  return (uint8_t)(0x30U + ((100U - clamped) * (0x99U - 0x30U) + 50U) / 100U);
}
