#pragma once

#include <stdbool.h>
#include <stdint.h>

enum {
    FACE_VISEME_AA = 0,
    FACE_VISEME_E = 1,
    FACE_VISEME_I = 2,
    FACE_VISEME_O = 3,
    FACE_VISEME_U = 4,
    FACE_VISEME_PP = 5,
    FACE_VISEME_SS = 6,
    FACE_VISEME_TH = 7,
    FACE_VISEME_DD = 8,
    FACE_VISEME_FF = 9,
    FACE_VISEME_KK = 10,
    FACE_VISEME_NN = 11,
    FACE_VISEME_RR = 12,
    FACE_VISEME_CH = 13,
    FACE_VISEME_SIL = 14,
    FACE_VISEME_COUNT = 15,
    FACE_VISEME_NONE = 255,
    FACE_PHONEME_NONE = 255,
};

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
    uint8_t viseme;
    uint8_t phoneme;
    uint8_t confidence;
    uint8_t activity;
    bool speaking;
} face_pose_t;

/* Compatibility name retained while existing firmware callers migrate. */
typedef face_pose_t face_animator_state_t;
