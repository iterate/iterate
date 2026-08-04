#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_keyframe.h"

/*
 * Sparse, sample-clock-addressed performance directions. These are suitable
 * for AI tool calls, authored timelines, or deterministic fixtures. They are
 * deliberately separate from dense audio articulation: a cue is resolved
 * into face_render_key_t actions without replacing visemes or jaw timing.
 */
typedef enum {
    FACE_EXPRESSION_NEUTRAL = 0,
    FACE_EXPRESSION_WARM,
    FACE_EXPRESSION_JOY,
    FACE_EXPRESSION_CONCERN,
    FACE_EXPRESSION_SURPRISE,
    FACE_EXPRESSION_THOUGHTFUL,
    FACE_EXPRESSION_SKEPTICAL,
    FACE_EXPRESSION_DETERMINED,
    FACE_EXPRESSION_SLEEPY,
    FACE_EXPRESSION_EXCITED,
    FACE_EXPRESSION_EMBARRASSED,
    FACE_EXPRESSION_COUNT,
    FACE_EXPRESSION_CUSTOM = 255,
} face_expression_t;

typedef enum {
    FACE_GESTURE_NONE = 0,
    FACE_GESTURE_NOD,
    FACE_GESTURE_SHAKE,
    FACE_GESTURE_TILT,
    FACE_GESTURE_LEAN_IN,
    FACE_GESTURE_BOUNCE,
} face_gesture_t;

typedef enum {
    FACE_GAZE_AUTO = 0,
    FACE_GAZE_USER,
    FACE_GAZE_LEFT,
    FACE_GAZE_RIGHT,
    FACE_GAZE_UP,
    FACE_GAZE_DOWN,
    FACE_GAZE_AWAY,
} face_gaze_target_t;

typedef enum {
    FACE_STAGE_BLEND_REPLACE = 0,
    FACE_STAGE_BLEND_ADD = 1,
    FACE_STAGE_BLEND_MAX = 2,
} face_stage_blend_t;

typedef enum {
    FACE_STAGE_EASE_LINEAR = 0,
    FACE_STAGE_EASE_SMOOTHSTEP = 1,
    FACE_STAGE_EASE_OVERSHOOT = 2,
} face_stage_easing_t;

typedef enum {
    FACE_STAGE_INTERRUPT_BLEND = 0,
    FACE_STAGE_INTERRUPT_CUT = 1,
    FACE_STAGE_INTERRUPT_QUEUE = 2,
} face_stage_interrupt_t;

enum {
    FACE_STAGE_FLAG_HOLD_FINAL = 1U << 0,
    FACE_STAGE_FLAG_LOOP_GESTURE = 1U << 1,
};

typedef struct {
    uint32_t start_sample;
    uint32_t attack_samples;
    uint32_t hold_samples;
    uint32_t release_samples;
    uint16_t cue_id;
    uint8_t expression;
    uint8_t gesture;
    uint8_t gaze_target;
    uint8_t blend_mode;
    uint8_t easing;
    uint8_t interrupt_mode;
    uint8_t intensity;
    uint8_t flags;
    int8_t valence;
    uint8_t arousal;
    uint8_t dominance;
    uint8_t reserved;
} face_stage_cue_t;

enum {
    FACE_STAGE_CUE_BYTES = 32,
};

_Static_assert(
    sizeof(face_stage_cue_t) == FACE_STAGE_CUE_BYTES,
    "stage cue wire format must remain exactly 32 bytes");

/*
 * Mix one cue into a dense renderer frame. Returns false before the cue or
 * after its release. Applying multiple active cues in timeline order is
 * supported; articulation bytes remain untouched.
 */
bool face_stage_cue_apply(
    const face_stage_cue_t *cue,
    uint32_t sample_clock,
    face_render_key_t *render_key);

/*
 * Select one authored expression as a stable state rather than a timeline.
 * Lifecycle UI such as dozing must not duplicate the selector coordinates
 * emitted by the sprite pipeline: those coordinates are the contract that
 * maps an emotion to each atlas's AI-authored, quantized expression bank.
 */
bool face_stage_apply_held_expression(
    face_expression_t expression,
    face_render_key_t *render_key);
