#ifndef ITERATE_KIT_PLATFORMS_M5STICKS3_VISUAL_LAYOUT_HPP
#define ITERATE_KIT_PLATFORMS_M5STICKS3_VISUAL_LAYOUT_HPP

#include <array>
#include <cstdint>

namespace iterate::kit::platforms {

struct VisualRect {
  std::uint16_t x;
  std::uint16_t y;
  std::uint16_t width;
  std::uint16_t height;
};

struct M5StickS3VisualLayout {
  static constexpr std::uint16_t displayWidth = 240U;
  static constexpr std::uint16_t displayHeight = 135U;

  VisualRect avatar;
  VisualRect sidebar;
  std::array<VisualRect, 12U> statusRing;

  /*
   * The face is rendered natively at 160x120 then enlarged to 180x135 by the
   * panel adapter. A 20-pixel rail on the left is the complete status surface;
   * there is deliberately no footer. Keeping the geometry in a pure constexpr
   * seam lets host tests protect that product hierarchy without M5GFX or a
   * connected board.
   *
   * The twelve 3-pixel cells trace a hollow 4x4 grid clockwise, preserving the
   * same sector order as HAVPE's ring (network, speaker, microphone, reserved)
   * without competing visually with the character. An independently ordered
   * bar would be marginally simpler, but would make the same state mean
   * different things across devices.
   */
  static constexpr M5StickS3VisualLayout make() {
    constexpr std::uint16_t cell = 3U;
    constexpr std::uint16_t stride = 4U;
    constexpr std::uint16_t ringX = 2U;
    constexpr std::uint16_t ringY = 2U;

    return {
        {40U, 0U, 180U, 135U},
        {0U, 0U, 20U, 135U},
        {
            VisualRect{ringX, ringY, cell, cell},
            VisualRect{ringX + stride, ringY, cell, cell},
            VisualRect{ringX + (2U * stride), ringY, cell, cell},
            VisualRect{ringX + (3U * stride), ringY, cell, cell},
            VisualRect{ringX + (3U * stride), ringY + stride, cell, cell},
            VisualRect{ringX + (3U * stride), ringY + (2U * stride), cell, cell},
            VisualRect{ringX + (3U * stride), ringY + (3U * stride), cell, cell},
            VisualRect{ringX + (2U * stride), ringY + (3U * stride), cell, cell},
            VisualRect{ringX + stride, ringY + (3U * stride), cell, cell},
            VisualRect{ringX, ringY + (3U * stride), cell, cell},
            VisualRect{ringX, ringY + (2U * stride), cell, cell},
            VisualRect{ringX, ringY + stride, cell, cell},
        },
    };
  }
};

}  // namespace iterate::kit::platforms

#endif
