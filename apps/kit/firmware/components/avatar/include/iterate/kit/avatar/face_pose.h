#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    FACE_ACTIVITY_IDLE = 0,
    FACE_ACTIVITY_LISTENING,
    FACE_ACTIVITY_THINKING,
    FACE_ACTIVITY_SPEAKING,
} face_activity_t;

/*
 * Shared semantic pose. Algorithms produce this compact representation;
 * renderers decide how to draw it. Values use 0..255 so the audio task never
 * needs renderer-specific floating point or heap allocation.
 */
typedef struct {
    uint32_t frame_index;
    uint32_t playout_samples;
    uint16_t level;
    uint8_t mouth_open;
    uint8_t mouth_width;
    uint8_t mouth_round;
    uint8_t mouth_press;
    uint8_t mouth_teeth;
    uint8_t eye_open;
    int8_t gaze_x;
    int8_t gaze_y;
    uint8_t activity;
    bool speaking;
} face_pose_t;

