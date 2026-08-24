#include "iterate/kit/avatar/face_scale.h"

#include <assert.h>
#include <stdint.h>

static void exact_pixels_are_duplicated_on_both_axes(void) {
  const uint16_t source[] = {
      0x1122U, 0x3344U, 0x5566U,
      0x7788U, 0x99AAU, 0xBBCDU,
  };
  uint16_t destination[24] = {0U};
  const uint16_t expected[] = {
      0x1122U, 0x1122U, 0x3344U, 0x3344U, 0x5566U, 0x5566U,
      0x1122U, 0x1122U, 0x3344U, 0x3344U, 0x5566U, 0x5566U,
      0x7788U, 0x7788U, 0x99AAU, 0x99AAU, 0xBBCDU, 0xBBCDU,
      0x7788U, 0x7788U, 0x99AAU, 0x99AAU, 0xBBCDU, 0xBBCDU,
  };

  assert(face_scale_rgb565_2x_rows(source, 3U, 2U, destination, 24U));
  for (size_t index = 0U; index < 24U; ++index) {
    /*
     * Byte-for-byte duplication matters here: colour conversion or filtering
     * would make the physical panel differ from screenshot/simulator oracles.
     */
    assert(destination[index] == expected[index]);
  }
}

static void capacity_failure_does_not_partially_mutate_output(void) {
  const uint16_t source[] = {0x1234U, 0x5678U};
  uint16_t destination[8];
  for (size_t index = 0U; index < 8U; ++index) {
    destination[index] = 0xCAFEU;
  }

  /*
   * A strip-capacity mismatch is a build/configuration defect.  Failing before
   * the first write prevents a half-updated DMA strip from ever reaching the
   * screen if dimensions drift during a future portability refactor.
   */
  assert(!face_scale_rgb565_2x_rows(source, 2U, 1U, destination, 7U));
  for (size_t index = 0U; index < 8U; ++index) {
    assert(destination[index] == 0xCAFEU);
  }
}

static void invalid_and_overflowing_shapes_fail_closed(void) {
  uint16_t source = 0x1234U;
  uint16_t destination[4] = {0U};

  assert(!face_scale_rgb565_2x_rows(NULL, 1U, 1U, destination, 4U));
  assert(!face_scale_rgb565_2x_rows(&source, 1U, 1U, NULL, 4U));
  assert(!face_scale_rgb565_2x_rows(&source, 0U, 1U, destination, 4U));
  assert(!face_scale_rgb565_2x_rows(&source, 1U, 0U, destination, 4U));
  assert(!face_scale_rgb565_2x_rows(&source, 1U, 1U, &source, 4U));
  assert(!face_scale_rgb565_2x_rows(
      &source, SIZE_MAX, 2U, destination, 4U));
}

int main(void) {
  exact_pixels_are_duplicated_on_both_axes();
  capacity_failure_does_not_partially_mutate_output();
  invalid_and_overflowing_shapes_fail_closed();
  return 0;
}
