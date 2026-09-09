#include "iterate/kit/platforms/led_ring_pixels.h"
#include <assert.h>
#include <string.h>

/** Check sector boundaries, not just the total pixel count: each light fans
 * out to adjacent LEDs, rather than repeating the whole twelve-light cycle.
 */
static void repeat_table(void) {
  struct iterate_kit_rgb8 lights[12];
  for (uint8_t i = 0; i < 12; ++i) lights[i] = (struct iterate_kit_rgb8){i, 22, 33};
  const struct {
    uint8_t pixels;
    uint8_t index;
    uint8_t light;
  } cases[] = {
    {12, 0, 0}, {12, 11, 11},
    {24, 0, 0}, {24, 1, 0}, {24, 2, 1}, {24, 5, 2}, {24, 6, 3}, {24, 23, 11},
    {36, 2, 0}, {36, 3, 1}, {36, 35, 11},
    {252, 20, 0}, {252, 21, 1}, {252, 251, 11},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    struct iterate_kit_rgb8 pixels[252] = {{0}};
    assert(iterate_kit_led_ring_repeat(lights, cases[i].pixels, pixels));
    assert(pixels[cases[i].index].red == cases[i].light);
    assert(pixels[cases[i].index].green == 22);
    assert(pixels[cases[i].index].blue == 33);
  }
  const uint8_t invalid[] = {0, 1, 11, 13, 23, 253, 255};
  for (size_t i = 0; i < sizeof(invalid); ++i) {
    struct iterate_kit_rgb8 pixel = {123, 123, 123};
    assert(!iterate_kit_led_ring_repeat(lights, invalid[i], &pixel));
    assert(pixel.red == 123 && pixel.green == 123 && pixel.blue == 123);
  }
}

/** A black cache is not proof of a painted ring; subsequent RGB changes at
 * either end of the ring must invalidate it, including green/blue-only ones.
 */
static void dirty_table(void) {
  const struct {
    bool painted;
    uint8_t index;
    struct iterate_kit_rgb8 value;
    bool dirty;
  } cases[] = {
    {false, 0, {0, 0, 0}, true},
    {true, 0, {0, 0, 0}, false},
    {true, 0, {1, 0, 0}, true},
    {true, 11, {0, 1, 0}, true},
    {true, 6, {0, 0, 1}, true},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    struct iterate_kit_rgb8 shown[12] = {{0}};
    struct iterate_kit_rgb8 next[12] = {{0}};
    next[cases[i].index] = cases[i].value;
    assert(iterate_kit_led_ring_dirty(cases[i].painted, shown, next) == cases[i].dirty);
    memcpy(shown, next, sizeof(shown));
    assert(!iterate_kit_led_ring_dirty(true, shown, next));
  }
}

int main(void) {
  repeat_table();
  dirty_table();
  return 0;
}
