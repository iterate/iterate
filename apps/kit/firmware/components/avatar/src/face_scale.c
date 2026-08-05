#include "iterate/kit/avatar/face_scale.h"

#include <stdint.h>

bool face_scale_rgb565_2x_rows(
    const uint16_t *source,
    size_t source_width,
    size_t source_row_count,
    uint16_t *destination,
    size_t destination_pixel_capacity) {
  if (source == NULL || destination == NULL || source == destination ||
      source_width == 0U || source_row_count == 0U) {
    return false;
  }

  /*
   * Reject an unrepresentable shape before doing either capacity arithmetic
   * or pointer indexing.  Firmware currently supplies tiny compile-time
   * dimensions, but keeping this primitive total lets host fault tests call
   * it with hostile sizes without converting overflow into memory damage.
   */
  if (source_width > SIZE_MAX / source_row_count) return false;
  const size_t source_pixel_count = source_width * source_row_count;
  if (source_pixel_count > SIZE_MAX / 4U) return false;
  const size_t required_pixels = source_pixel_count * 4U;
  if (destination_pixel_capacity < required_pixels) return false;

  const size_t destination_width = source_width * 2U;
  for (size_t source_y = 0U; source_y < source_row_count; ++source_y) {
    const uint16_t *const source_row = source + source_y * source_width;
    uint16_t *const first_destination_row =
        destination + source_y * 2U * destination_width;
    uint16_t *const second_destination_row =
        first_destination_row + destination_width;
    for (size_t source_x = 0U; source_x < source_width; ++source_x) {
      const uint16_t pixel = source_row[source_x];
      const size_t destination_x = source_x * 2U;
      first_destination_row[destination_x] = pixel;
      first_destination_row[destination_x + 1U] = pixel;
      second_destination_row[destination_x] = pixel;
      second_destination_row[destination_x + 1U] = pixel;
    }
  }
  return true;
}
