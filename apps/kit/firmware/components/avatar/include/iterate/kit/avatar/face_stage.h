#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_keyframe.h"

/*
 * Held emotions. Each one maps to selector coordinates that pick an atlas's
 * matching expression bank (face_sprite_sheet.h), and face_performance.c
 * attenuates its ambient expression while a non-neutral one is held.
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
} face_expression_t;

/*
 * Select one authored expression as a stable state at full weight: its
 * upper/lower-face actions and affect replace the key's, and gaze returns to
 * centre. Articulation bytes remain untouched. Lifecycle UI such as dozing
 * must not duplicate the selector coordinates in the generated atlases:
 * those coordinates are the contract that maps an emotion to each atlas's
 * authored, quantized expression bank.
 */
bool face_stage_apply_held_expression(
    face_expression_t expression,
    face_render_key_t *render_key);
