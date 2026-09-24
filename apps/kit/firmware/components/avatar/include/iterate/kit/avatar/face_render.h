#pragma once

#include <stdint.h>

#include "iterate/kit/avatar/face_keyframe.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Shared RGB565 canvas for the portable sprite renderer. A complete frame is
 * half the CoreS3 LCD resolution so embedded targets can scale it 2x without
 * allocating a full-screen intermediate framebuffer.
 */
enum {
    FACE_RENDER_WIDTH = 160,
    FACE_RENDER_HEIGHT = 120,
    FACE_RENDER_PIXEL_COUNT =
        FACE_RENDER_WIDTH * FACE_RENDER_HEIGHT,
    FACE_RENDER_FRAME_BYTES =
        FACE_RENDER_PIXEL_COUNT * (int)sizeof(uint16_t),
};

#ifdef __cplusplus
}
#endif
