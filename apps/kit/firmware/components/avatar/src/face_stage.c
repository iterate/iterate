#include "iterate/kit/avatar/face_stage.h"

#include <stddef.h>

typedef struct {
    int8_t mouth_corner;
    uint8_t cheek;
    uint8_t squint;
    int8_t brow_inner;
    int8_t brow_outer;
    int8_t head_roll;
    int8_t valence;
    uint8_t arousal;
    uint8_t attention;
} expression_target_t;

static const expression_target_t EXPRESSION_TARGETS[FACE_EXPRESSION_COUNT] = {
    [FACE_EXPRESSION_NEUTRAL] = {0, 0, 0, 0, 0, 0, 0, 72, 164},
    [FACE_EXPRESSION_WARM] = {36, 38, 20, 10, 8, 0, 52, 112, 220},
    [FACE_EXPRESSION_JOY] = {78, 88, 68, 22, 18, 0, 94, 184, 226},
    [FACE_EXPRESSION_CONCERN] = {-24, 20, 14, 58, -22, -5, -52, 126, 232},
    [FACE_EXPRESSION_SURPRISE] = {8, 0, 0, 78, 64, 0, 18, 232, 255},
    [FACE_EXPRESSION_THOUGHTFUL] = {-6, 8, 22, 18, 8, 8, 4, 92, 212},
    [FACE_EXPRESSION_SKEPTICAL] = {-12, 12, 42, -14, 32, -12, -18, 104, 230},
    [FACE_EXPRESSION_DETERMINED] = {-8, 28, 54, -34, -26, 0, 12, 166, 248},
    [FACE_EXPRESSION_SLEEPY] = {4, 0, 118, -26, -20, 5, 8, 34, 92},
    [FACE_EXPRESSION_EXCITED] = {62, 48, 14, 52, 42, 0, 86, 250, 255},
    [FACE_EXPRESSION_EMBARRASSED] = {24, 116, 56, 24, 12, 7, 28, 176, 178},
};

bool face_stage_apply_held_expression(
    face_expression_t expression,
    face_render_key_t *render_key)
{
    if (expression >= FACE_EXPRESSION_COUNT || render_key == NULL) {
        return false;
    }
    const expression_target_t *target = &EXPRESSION_TARGETS[expression];
    uint8_t left_squint = target->squint;
    uint8_t right_squint = target->squint;
    int8_t outer_left = target->brow_outer;
    int8_t outer_right = target->brow_outer;
    /* Three expressions are asymmetric: one eye and one brow lead. */
    if (expression == FACE_EXPRESSION_THOUGHTFUL) {
        left_squint = 12U;
        right_squint = 46U;
        outer_left = 18;
        outer_right = -4;
    } else if (expression == FACE_EXPRESSION_SKEPTICAL) {
        left_squint = 24U;
        right_squint = 94U;
        outer_left = -18;
        outer_right = 52;
    } else if (expression == FACE_EXPRESSION_EMBARRASSED) {
        left_squint = 78U;
        right_squint = 42U;
        outer_left = 26;
        outer_right = 2;
    }
    render_key->stage_expression = (uint8_t)expression;
    render_key->expression_weight = UINT8_MAX;
    render_key->mouth_corner_left = target->mouth_corner;
    render_key->mouth_corner_right = target->mouth_corner;
    render_key->cheek = target->cheek;
    render_key->eye_left_squint = left_squint;
    render_key->eye_right_squint = right_squint;
    render_key->brow_inner = target->brow_inner;
    render_key->brow_outer_left = outer_left;
    render_key->brow_outer_right = outer_right;
    render_key->head_roll = target->head_roll;
    render_key->affect_valence = target->valence;
    render_key->affect_arousal = target->arousal;
    render_key->attention = target->attention;
    render_key->controls.look_x = 0;
    render_key->controls.look_y = 0;
    return true;
}
