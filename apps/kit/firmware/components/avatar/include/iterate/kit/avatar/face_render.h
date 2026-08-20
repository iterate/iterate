#pragma once

#include <stdint.h>

#include "iterate/kit/avatar/face_keyframe.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Shared RGB565 canvas and catalog flags for the portable sprite renderer.
 * A complete frame is half the CoreS3 LCD resolution so embedded targets can
 * scale it 2x without allocating a full-screen intermediate framebuffer.
 *
 * This header deliberately contains only the renderer ABI that exists. The
 * old profile enum and procedural-renderer declarations had no implementation
 * or caller; retaining them made unavailable avatar paths look supported.
 */
enum {
    FACE_RENDER_WIDTH = 160,
    FACE_RENDER_HEIGHT = 120,
    FACE_RENDER_PIXEL_COUNT =
        FACE_RENDER_WIDTH * FACE_RENDER_HEIGHT,
    FACE_RENDER_FRAME_BYTES =
        FACE_RENDER_PIXEL_COUNT * (int)sizeof(uint16_t),
};

enum {
    FACE_RENDER_FLAG_PIXELATED = 1U << 0,
    FACE_RENDER_FLAG_SHADER = 1U << 1,
    FACE_RENDER_FLAG_EYE_FOCUS = 1U << 2,
    FACE_RENDER_FLAG_SPRITE_MOUTH = 1U << 3,
    FACE_RENDER_FLAG_POLYGON_MOUTH = 1U << 4,
    FACE_RENDER_FLAG_IDLE_MOTION = 1U << 5,
    FACE_RENDER_FLAG_HALF_RES = 1U << 6,
    FACE_RENDER_FLAG_NO_MOUTH = 1U << 7,
};

#ifdef __cplusplus
}
#endif
