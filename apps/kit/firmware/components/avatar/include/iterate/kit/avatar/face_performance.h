#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_keyframe.h"

/*
 * Renderer-neutral ambient acting.
 *
 * This layer sits between a producer of face_render_key_t records and any
 * renderer. It adds sparse, slow, deterministic listening/idle/thinking
 * performances without owning audio state, allocating memory, or changing
 * articulation. The same function is therefore usable from ESP-IDF and WASM.
 *
 * AI-authored stage directions remain a separate, stronger layer. Ambient
 * head/gaze motion continues under an authored emotion, while upper-face
 * expression is automatically attenuated when a non-neutral stage cue has
 * high weight.
 */
typedef struct {
    uint32_t seed;
    uint8_t motion_gain;
    uint8_t gaze_gain;
    uint8_t expression_gain;
    uint8_t blink_gain;
} face_performance_profile_t;

typedef enum {
    FACE_PERFORMANCE_NONE = 0,

    FACE_PERFORMANCE_IDLE_GLANCE,
    FACE_PERFORMANCE_IDLE_TILT,
    FACE_PERFORMANCE_IDLE_SETTLE,
    FACE_PERFORMANCE_IDLE_LOOK_UP,
    FACE_PERFORMANCE_IDLE_SOFTEN,
    FACE_PERFORMANCE_IDLE_SLOW_BLINK,
    FACE_PERFORMANCE_IDLE_STRETCH,
    FACE_PERFORMANCE_IDLE_CURIOUS,
    FACE_PERFORMANCE_IDLE_BREATHE,
    FACE_PERFORMANCE_IDLE_SIDE_EYE,

    FACE_PERFORMANCE_LISTEN_FOCUS,
    FACE_PERFORMANCE_LISTEN_ACK_NOD,
    FACE_PERFORMANCE_LISTEN_HEAD_TILT,
    FACE_PERFORMANCE_LISTEN_LEAN_IN,
    FACE_PERFORMANCE_LISTEN_TRACK,
    FACE_PERFORMANCE_LISTEN_SLOW_BLINK,
    FACE_PERFORMANCE_LISTEN_EMPATHY,
    FACE_PERFORMANCE_LISTEN_BRIGHTEN,

    FACE_PERFORMANCE_THINK_SEARCH,
    FACE_PERFORMANCE_THINK_LOOK_UP,
    FACE_PERFORMANCE_THINK_TILT,
    FACE_PERFORMANCE_THINK_SQUINT,
    FACE_PERFORMANCE_THINK_SETTLE,

    FACE_PERFORMANCE_SPEAK_SMALL_NOD,
    FACE_PERFORMANCE_SPEAK_TURN,
    FACE_PERFORMANCE_SPEAK_SETTLE,

    FACE_PERFORMANCE_COUNT,
} face_performance_clip_t;

/*
 * Optional deterministic trace output for tests and tooling. `clip` is the
 * performance scheduled for the current activity window; `active` and
 * `envelope` say whether its sparse event is currently visible.
 */
typedef struct {
    uint32_t epoch;
    uint32_t event_start;
    uint8_t activity;
    uint8_t clip;
    uint8_t active;
    uint8_t envelope;
    uint8_t phase;
    int8_t direction;
    uint8_t reserved[2];
} face_performance_frame_t;

enum {
    FACE_PERFORMANCE_PROFILE_BYTES = 8,
};

_Static_assert(
    sizeof(face_performance_profile_t) == FACE_PERFORMANCE_PROFILE_BYTES,
    "ambient performance profile must remain tiny");

/*
 * Apply one pure sample-clock-addressed performance frame in place.
 *
 * Dense speech articulation is immutable here: mouth controls (bytes 0..4),
 * activity/flags (10..11), and viseme/audio/speech fields (12..19) are left
 * untouched. Eye, gaze, and brow controls in the same compact prefix are
 * intentionally available to the performance layer.
 */
bool face_performance_apply(
    const face_performance_profile_t *profile,
    uint32_t sample_clock,
    face_render_key_t *render_key,
    face_performance_frame_t *frame);
