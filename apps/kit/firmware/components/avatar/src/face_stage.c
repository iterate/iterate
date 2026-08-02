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

static int32_t clamp_i32(int32_t value, int32_t low, int32_t high)
{
    if (value < low) {
        return low;
    }
    return value > high ? high : value;
}

static uint8_t smoothstep_u8(uint8_t value)
{
    const uint32_t x = value;
    return (uint8_t)(
        (x * x * (765U - 2U * x) + 32512U) / 65025U);
}

static uint8_t cue_envelope(
    const face_stage_cue_t *cue, uint32_t sample_clock)
{
    if (sample_clock < cue->start_sample) {
        return 0U;
    }
    const uint32_t elapsed = sample_clock - cue->start_sample;
    uint8_t envelope;
    if (cue->attack_samples > 0U && elapsed < cue->attack_samples) {
        envelope = (uint8_t)(
            ((uint64_t)elapsed * 255U) / cue->attack_samples);
    } else {
        const uint32_t after_attack =
            elapsed > cue->attack_samples
                ? elapsed - cue->attack_samples
                : 0U;
        if (after_attack <= cue->hold_samples ||
            (cue->flags & FACE_STAGE_FLAG_HOLD_FINAL) != 0U) {
            envelope = 255U;
        } else {
            const uint32_t release_elapsed =
                after_attack - cue->hold_samples;
            if (cue->release_samples == 0U ||
                release_elapsed >= cue->release_samples) {
                return 0U;
            }
            envelope = (uint8_t)(
                255U -
                ((uint64_t)release_elapsed * 255U) /
                    cue->release_samples);
        }
    }
    if (cue->easing == FACE_STAGE_EASE_SMOOTHSTEP) {
        envelope = smoothstep_u8(envelope);
    } else if (cue->easing == FACE_STAGE_EASE_OVERSHOOT &&
               envelope > 160U && envelope < 255U) {
        envelope = (uint8_t)clamp_i32(
            envelope + (255 - envelope) / 3, 0, 255);
    }
    return (uint8_t)(
        ((uint16_t)envelope * cue->intensity + 127U) / 255U);
}

static int8_t mix_i8(
    int8_t current, int8_t target, uint8_t weight, uint8_t blend)
{
    const int32_t scaled = (int32_t)target * weight / 255;
    if (blend == FACE_STAGE_BLEND_ADD) {
        return (int8_t)clamp_i32((int32_t)current + scaled, -127, 127);
    }
    if (blend == FACE_STAGE_BLEND_MAX) {
        return (int8_t)(
            current < scaled ? scaled : current);
    }
    return (int8_t)(
        current + ((int32_t)(target - current) * weight) / 255);
}

static uint8_t mix_u8(
    uint8_t current, uint8_t target, uint8_t weight, uint8_t blend)
{
    const uint32_t scaled = (uint32_t)target * weight / 255U;
    if (blend == FACE_STAGE_BLEND_ADD) {
        return (uint8_t)clamp_i32((int32_t)current + scaled, 0, 255);
    }
    if (blend == FACE_STAGE_BLEND_MAX) {
        return (uint8_t)(current < scaled ? scaled : current);
    }
    return (uint8_t)(
        current + ((int32_t)target - current) * weight / 255);
}

static int8_t gesture_wave(
    const face_stage_cue_t *cue, uint32_t sample_clock)
{
    uint32_t elapsed = sample_clock - cue->start_sample;
    const uint32_t period = 6400U;
    if ((cue->flags & FACE_STAGE_FLAG_LOOP_GESTURE) == 0U &&
        elapsed >= period) {
        return 0;
    }
    elapsed %= period;
    const uint32_t quarter = period / 4U;
    int32_t wave;
    if (elapsed < quarter) {
        wave = (int32_t)(elapsed * 127U / quarter);
    } else if (elapsed < quarter * 3U) {
        wave = 127 - (int32_t)((elapsed - quarter) * 254U /
                               (quarter * 2U));
    } else {
        wave = -127 + (int32_t)((elapsed - quarter * 3U) * 127U /
                                quarter);
    }
    return (int8_t)wave;
}

static void apply_gaze(
    const face_stage_cue_t *cue,
    uint8_t weight,
    face_render_key_t *render_key)
{
    static const int8_t gaze[][2] = {
        [FACE_GAZE_AUTO] = {0, 0},
        [FACE_GAZE_USER] = {0, 0},
        [FACE_GAZE_LEFT] = {-52, 0},
        [FACE_GAZE_RIGHT] = {52, 0},
        [FACE_GAZE_UP] = {0, -44},
        [FACE_GAZE_DOWN] = {0, 44},
        [FACE_GAZE_AWAY] = {64, -18},
    };
    if (cue->gaze_target >=
        sizeof(gaze) / sizeof(gaze[0])) {
        return;
    }
    render_key->controls.look_x = mix_i8(
        render_key->controls.look_x,
        gaze[cue->gaze_target][0], weight, cue->blend_mode);
    render_key->controls.look_y = mix_i8(
        render_key->controls.look_y,
        gaze[cue->gaze_target][1], weight, cue->blend_mode);
}

bool face_stage_cue_apply(
    const face_stage_cue_t *cue,
    uint32_t sample_clock,
    face_render_key_t *render_key)
{
    if (cue == NULL || render_key == NULL ||
        cue->expression >= FACE_EXPRESSION_COUNT ||
        sample_clock < cue->start_sample) {
        return false;
    }
    const uint8_t weight = cue_envelope(cue, sample_clock);
    if (weight == 0U) {
        return false;
    }
    const expression_target_t *target =
        &EXPRESSION_TARGETS[cue->expression];
    uint8_t left_squint = target->squint;
    uint8_t right_squint = target->squint;
    int8_t outer_left = target->brow_outer;
    int8_t outer_right = target->brow_outer;
    if (cue->expression == FACE_EXPRESSION_THOUGHTFUL) {
        left_squint = 12U;
        right_squint = 46U;
        outer_left = 18;
        outer_right = -4;
    } else if (cue->expression == FACE_EXPRESSION_SKEPTICAL) {
        left_squint = 24U;
        right_squint = 94U;
        outer_left = -18;
        outer_right = 52;
    } else if (cue->expression == FACE_EXPRESSION_EMBARRASSED) {
        left_squint = 78U;
        right_squint = 42U;
        outer_left = 26;
        outer_right = 2;
    }
    render_key->stage_expression = cue->expression;
    render_key->expression_weight = weight;
    render_key->mouth_corner_left = mix_i8(
        render_key->mouth_corner_left,
        target->mouth_corner, weight, cue->blend_mode);
    render_key->mouth_corner_right = mix_i8(
        render_key->mouth_corner_right,
        target->mouth_corner, weight, cue->blend_mode);
    render_key->cheek = mix_u8(
        render_key->cheek, target->cheek, weight, cue->blend_mode);
    render_key->eye_left_squint = mix_u8(
        render_key->eye_left_squint,
        left_squint, weight, cue->blend_mode);
    render_key->eye_right_squint = mix_u8(
        render_key->eye_right_squint,
        right_squint, weight, cue->blend_mode);
    render_key->brow_inner = mix_i8(
        render_key->brow_inner,
        target->brow_inner, weight, cue->blend_mode);
    render_key->brow_outer_left = mix_i8(
        render_key->brow_outer_left,
        outer_left, weight, cue->blend_mode);
    render_key->brow_outer_right = mix_i8(
        render_key->brow_outer_right,
        outer_right, weight, cue->blend_mode);
    render_key->head_roll = mix_i8(
        render_key->head_roll,
        target->head_roll, weight, cue->blend_mode);
    render_key->affect_valence = mix_i8(
        render_key->affect_valence,
        cue->valence != 0 ? cue->valence : target->valence,
        weight, cue->blend_mode);
    render_key->affect_arousal = mix_u8(
        render_key->affect_arousal,
        cue->arousal != 0U ? cue->arousal : target->arousal,
        weight, cue->blend_mode);
    render_key->attention = mix_u8(
        render_key->attention,
        target->attention, weight, cue->blend_mode);
    apply_gaze(cue, weight, render_key);

    const int8_t wave = gesture_wave(cue, sample_clock);
    const int8_t gesture =
        (int8_t)((int32_t)wave * weight / 255);
    switch (cue->gesture) {
    case FACE_GESTURE_NOD:
        render_key->head_pitch = mix_i8(
            render_key->head_pitch, gesture / 2,
            weight, FACE_STAGE_BLEND_ADD);
        break;
    case FACE_GESTURE_SHAKE:
        render_key->head_yaw = mix_i8(
            render_key->head_yaw, gesture / 2,
            weight, FACE_STAGE_BLEND_ADD);
        break;
    case FACE_GESTURE_TILT:
        render_key->head_roll = mix_i8(
            render_key->head_roll, gesture / 3,
            weight, FACE_STAGE_BLEND_ADD);
        break;
    case FACE_GESTURE_LEAN_IN:
        render_key->body_lean_y = mix_i8(
            render_key->body_lean_y, 44,
            weight, FACE_STAGE_BLEND_ADD);
        break;
    case FACE_GESTURE_BOUNCE:
        render_key->body_lean_y = mix_i8(
            render_key->body_lean_y, gesture / 4,
            weight, FACE_STAGE_BLEND_ADD);
        break;
    default:
        break;
    }
    return true;
}
