#include "iterate/kit/platforms/pcm5122_registers.h"
#include <assert.h>
#include <string.h>

/* Independent literal writes from board-table task step 17. */
static void iterate_kit_pcm5122_test_script(void) {
  size_t count;
  const struct iterate_kit_register_write *reset = iterate_kit_pcm5122_reset_script(&count);
  const struct iterate_kit_register_write expected_reset[] = {{0x01, 0x10}, {0x01, 0}};
  assert(count == 2);
  assert(memcmp(reset, expected_reset, sizeof(expected_reset)) == 0);
  assert(iterate_kit_pcm5122_reset_script(NULL) == reset);
  assert(ITERATE_KIT_PCM5122_RESET_SETTLE_MS == 20);
  struct iterate_kit_register_write writes[8];
  count = iterate_kit_pcm5122_init_script(0xFF, 0xFF, writes, 8);
  assert(count == 8);
  const uint8_t expected[][2] = {
    {0, 0}, {0x25, 0xFD}, {0x28, 0x03}, {0x2A, 0x11},
    {0, 1}, {0x02, 0}, {0, 0}, {0x0D, 0x9F},
  };
  uint8_t recorded[8][2];
  for (size_t i = 0; i < count; ++i) {
    recorded[i][0] = writes[i].address;
    recorded[i][1] = writes[i].value;
  }
  assert(memcmp(recorded, expected, sizeof(expected)) == 0);
  const struct iterate_kit_register_write before = writes[0];
  assert(iterate_kit_pcm5122_init_script(0, 0, writes, 7) == 0);
  assert(memcmp(&writes[0], &before, sizeof(before)) == 0);
  assert(iterate_kit_pcm5122_init_script(0, 0, NULL, 8) == 0);
}

static void iterate_kit_pcm5122_test_values(void) {
  const uint8_t volume[][2] = {{0, 0x99}, {50, 0x65}, {100, 0x30}, {101, 0x30}, {255, 0x30}};
  for (size_t i = 0; i < sizeof(volume) / sizeof(volume[0]); ++i) {
    assert(iterate_kit_pcm5122_dvol_for_percent(volume[i][0]) == volume[i][1]);
  }
  const uint8_t rmw[][3] = {
    /* current, error detect, PLL reference */
    {0, 0x08, 0x10}, {0xFF, 0xFD, 0x9F}, {0x02, 0x08, 0x12},
    {0x70, 0x78, 0x10}, {0xA5, 0xAD, 0x95}, {0x18, 0x18, 0x18},
  };
  for (size_t i = 0; i < sizeof(rmw) / sizeof(rmw[0]); ++i) {
    assert(iterate_kit_pcm5122_error_detect_value(rmw[i][0]) == rmw[i][1]);
    assert(iterate_kit_pcm5122_pll_reference_value(rmw[i][0]) == rmw[i][2]);
  }
}

int main(void) {
  iterate_kit_pcm5122_test_script();
  iterate_kit_pcm5122_test_values();
  return 0;
}
