#include "iterate/kit/platforms/m5sticks3_visual_layout.hpp"

#include <array>
#include <cassert>
#include <cstddef>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

using iterate::kit::platforms::M5StickS3VisualLayout;
using iterate::kit::platforms::VisualRect;

static bool overlaps(VisualRect left, VisualRect right) {
  return left.x < right.x + right.width &&
      right.x < left.x + left.width &&
      left.y < right.y + right.height &&
      right.y < left.y + left.height;
}

/*
 * The face is the product surface; status is only a narrow left rail. A prior
 * 80-pixel sidebar plus footer made diagnostics visually dominant and forced
 * frequent status repaint over too much of the panel. These bounds protect the
 * physical 240x135 panel while preventing that dashboard layout from creeping
 * back in during future UI changes.
 */
static void places_every_region_inside_the_physical_panel(void) {
  const auto layout = M5StickS3VisualLayout::make();
  assert(layout.sidebar.x == 0U && layout.sidebar.y == 0U);
  assert(layout.sidebar.width <= 24U);
  assert(layout.sidebar.height == M5StickS3VisualLayout::displayHeight);
  assert(layout.avatar.x >= layout.sidebar.width);
  assert(layout.avatar.y == 0U);
  assert(layout.avatar.width >= 180U);
  assert(layout.avatar.height == M5StickS3VisualLayout::displayHeight);
  assert(layout.avatar.x + layout.avatar.width <=
         M5StickS3VisualLayout::displayWidth);
  assert(!overlaps(layout.avatar, layout.sidebar));

  for (const auto &cell : layout.statusRing) {
    assert(cell.x >= layout.sidebar.x);
    assert(cell.y >= layout.sidebar.y);
    assert(cell.x + cell.width <=
           layout.sidebar.x + layout.sidebar.width);
    assert(cell.y + cell.height <=
           layout.sidebar.y + layout.sidebar.height);
    assert(cell.x + cell.width <= M5StickS3VisualLayout::displayWidth);
    assert(cell.y + cell.height <= M5StickS3VisualLayout::displayHeight);
    assert(cell.width <= 4U && cell.height <= 4U);
  }
}

/*
 * A 4x4 perimeter makes the on-screen pixels read as the same ring as HAVPE,
 * not an arbitrary bar graph. Sequential sectors remain contiguous clockwise:
 * network across the top, speaker around the right, microphone along the
 * bottom, and the reserved quarter up the left.
 */
static void maps_twelve_pixels_clockwise_around_a_hollow_grid(void) {
  const auto layout = M5StickS3VisualLayout::make();
  for (std::size_t left = 0U; left < layout.statusRing.size(); ++left) {
    for (std::size_t right = left + 1U;
         right < layout.statusRing.size();
         ++right) {
      assert(!overlaps(layout.statusRing[left], layout.statusRing[right]));
    }
  }

  assert(layout.statusRing[0].y == layout.statusRing[1].y);
  assert(layout.statusRing[0].x < layout.statusRing[1].x);
  assert(layout.statusRing[3].x == layout.statusRing[4].x);
  assert(layout.statusRing[3].y < layout.statusRing[4].y);
  assert(layout.statusRing[6].y == layout.statusRing[7].y);
  assert(layout.statusRing[6].x > layout.statusRing[7].x);
  assert(layout.statusRing[9].x == layout.statusRing[10].x);
  assert(layout.statusRing[9].y > layout.statusRing[10].y);
}

int main() {
  places_every_region_inside_the_physical_panel();
  maps_twelve_pixels_clockwise_around_a_hollow_grid();
  return 0;
}
