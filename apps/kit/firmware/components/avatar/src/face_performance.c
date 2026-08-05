#include "iterate/kit/avatar/face_performance.h"

#include <stddef.h>
#include <string.h>

#include "iterate/kit/avatar/face_pose.h"
#include "iterate/kit/avatar/face_stage.h"

typedef struct {
    int8_t head_yaw;
    int8_t head_pitch;
    int8_t head_roll;
    int8_t body_lean_x;
    int8_t body_lean_y;
    int8_t gaze_x;
    int8_t gaze_y;
    int8_t brow;
    int8_t brow_inner;
    int8_t eye_open;
    int8_t squint;
    int8_t valence;
    int8_t arousal;
    int8_t attention;
    uint8_t wave;
} performance_delta_t;

enum {
    PERFORMANCE_WAVE_HOLD = 0,
    PERFORMANCE_WAVE_GESTURE = 1,
    PERFORMANCE_SAMPLE_RATE = 16000,
};

static const face_performance_profile_t DEFAULT_PROFILE = {
    .seed = 0x53544143U,
    .motion_gain = 255U,
    .gaze_gain = 255U,
    .expression_gain = 208U,
    .blink_gain = 224U,
};

static const uint8_t IDLE_CLIPS[] = {
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
};

static const uint8_t LISTEN_CLIPS[] = {
    FACE_PERFORMANCE_LISTEN_FOCUS,
    FACE_PERFORMANCE_LISTEN_ACK_NOD,
    FACE_PERFORMANCE_LISTEN_HEAD_TILT,
    FACE_PERFORMANCE_LISTEN_LEAN_IN,
    FACE_PERFORMANCE_LISTEN_TRACK,
    FACE_PERFORMANCE_LISTEN_SLOW_BLINK,
    FACE_PERFORMANCE_LISTEN_EMPATHY,
    FACE_PERFORMANCE_LISTEN_BRIGHTEN,
};

static const uint8_t THINK_CLIPS[] = {
    FACE_PERFORMANCE_THINK_SEARCH,
    FACE_PERFORMANCE_THINK_LOOK_UP,
    FACE_PERFORMANCE_THINK_TILT,
    FACE_PERFORMANCE_THINK_SQUINT,
    FACE_PERFORMANCE_THINK_SETTLE,
};

static const uint8_t SPEAK_CLIPS[] = {
    FACE_PERFORMANCE_SPEAK_SMALL_NOD,
    FACE_PERFORMANCE_SPEAK_TURN,
    FACE_PERFORMANCE_SPEAK_SETTLE,
};

static uint32_t mix_u32(uint32_t value)
{
    value ^= value >> 16U;
    value *= 0x7feb352dU;
    value ^= value >> 15U;
    value *= 0x846ca68bU;
    value ^= value >> 16U;
    return value;
}

static int32_t clamp_i32(int32_t value, int32_t low, int32_t high)
{
    if (value < low) {
        return low;
    }
    return value > high ? high : value;
}

static int8_t add_i8(int8_t current, int32_t delta)
{
    return (int8_t)clamp_i32((int32_t)current + delta, -127, 127);
}

static uint8_t add_u8(uint8_t current, int32_t delta)
{
    return (uint8_t)clamp_i32((int32_t)current + delta, 0, 255);
}

static uint8_t max_u8(uint8_t left, uint8_t right)
{
    return left > right ? left : right;
}

static int8_t max_i8(int8_t left, int8_t right)
{
    return left > right ? left : right;
}

static uint8_t smoothstep_u8(uint8_t value)
{
    const uint32_t x = value;
    return (uint8_t)(
        (x * x * (765U - 2U * x) + 32512U) / 65025U);
}

static uint32_t activity_window(uint8_t activity)
{
    switch (activity) {
    case FACE_ACTIVITY_LISTENING:
        return 6U * PERFORMANCE_SAMPLE_RATE;
    case FACE_ACTIVITY_THINKING:
        return 5U * PERFORMANCE_SAMPLE_RATE;
    case FACE_ACTIVITY_SPEAKING:
        return 8U * PERFORMANCE_SAMPLE_RATE;
    case FACE_ACTIVITY_IDLE:
    default:
        return 12U * PERFORMANCE_SAMPLE_RATE;
    }
}

static uint32_t clip_duration(uint8_t clip)
{
    switch (clip) {
    case FACE_PERFORMANCE_IDLE_SLOW_BLINK:
    case FACE_PERFORMANCE_LISTEN_SLOW_BLINK:
        return 2U * PERFORMANCE_SAMPLE_RATE;
    case FACE_PERFORMANCE_IDLE_SOFTEN:
    case FACE_PERFORMANCE_IDLE_SETTLE:
    case FACE_PERFORMANCE_THINK_SETTLE:
        return 3U * PERFORMANCE_SAMPLE_RATE;
    case FACE_PERFORMANCE_IDLE_BREATHE:
    case FACE_PERFORMANCE_IDLE_STRETCH:
        return 5U * PERFORMANCE_SAMPLE_RATE / 2U;
    case FACE_PERFORMANCE_LISTEN_ACK_NOD:
    case FACE_PERFORMANCE_SPEAK_SMALL_NOD:
        return 7U * PERFORMANCE_SAMPLE_RATE / 4U;
    default:
        return 9U * PERFORMANCE_SAMPLE_RATE / 4U;
    }
}

static const uint8_t *activity_clips(
    uint8_t activity, size_t *count)
{
    switch (activity) {
    case FACE_ACTIVITY_LISTENING:
        *count = sizeof(LISTEN_CLIPS) / sizeof(LISTEN_CLIPS[0]);
        return LISTEN_CLIPS;
    case FACE_ACTIVITY_THINKING:
        *count = sizeof(THINK_CLIPS) / sizeof(THINK_CLIPS[0]);
        return THINK_CLIPS;
    case FACE_ACTIVITY_SPEAKING:
        *count = sizeof(SPEAK_CLIPS) / sizeof(SPEAK_CLIPS[0]);
        return SPEAK_CLIPS;
    case FACE_ACTIVITY_IDLE:
    default:
        *count = sizeof(IDLE_CLIPS) / sizeof(IDLE_CLIPS[0]);
        return IDLE_CLIPS;
    }
}

static uint8_t event_envelope(
    uint32_t elapsed, uint32_t duration)
{
    const uint32_t attack = duration / 4U;
    const uint32_t release = duration / 3U;
    const uint32_t release_start = duration - release;
    uint8_t value;
    if (elapsed >= duration) {
        return 0U;
    }
    if (elapsed < attack) {
        value = (uint8_t)(
            ((uint64_t)elapsed * 255U) / attack);
    } else if (elapsed < release_start) {
        value = 255U;
    } else {
        value = (uint8_t)(
            ((uint64_t)(duration - elapsed) * 255U) /
            release);
    }
    return smoothstep_u8(value);
}

/*
 * Zero-ended triangle gesture: 0 -> +127 -> 0 -> -127 -> 0. Multiplying it
 * by the event envelope makes nods and speaking beats settle cleanly.
 */
static int16_t gesture_amount(uint8_t phase, uint8_t envelope)
{
    int32_t wave;
    if (phase < 64U) {
        wave = (int32_t)phase * 127 / 64;
    } else if (phase < 128U) {
        wave = (int32_t)(128U - phase) * 127 / 64;
    } else if (phase < 192U) {
        wave = -(int32_t)(phase - 128U) * 127 / 64;
    } else {
        wave = -(int32_t)(256U - phase) * 127 / 64;
    }
    return (int16_t)(wave * envelope / 127);
}

static int32_t scaled_delta(
    int32_t value, int32_t amount, uint8_t gain)
{
    return value * amount * gain / (255 * 255);
}

static performance_delta_t clip_delta(
    uint8_t clip, int8_t direction)
{
    const int32_t side = direction < 0 ? -1 : 1;
    performance_delta_t delta;
    memset(&delta, 0, sizeof(delta));
    switch (clip) {
    case FACE_PERFORMANCE_IDLE_GLANCE:
        delta.head_yaw = (int8_t)(side * 54);
        delta.body_lean_x = (int8_t)(side * 28);
        delta.gaze_x = (int8_t)(side * 62);
        break;
    case FACE_PERFORMANCE_IDLE_TILT:
        delta.head_roll = (int8_t)(side * 28);
        delta.head_yaw = (int8_t)(side * 22);
        delta.brow = 10;
        delta.valence = 8;
        break;
    case FACE_PERFORMANCE_IDLE_SETTLE:
        delta.head_pitch = 40;
        delta.body_lean_y = 36;
        delta.eye_open = -36;
        delta.arousal = -32;
        break;
    case FACE_PERFORMANCE_IDLE_LOOK_UP:
        delta.head_pitch = -46;
        delta.gaze_y = -62;
        delta.brow = 22;
        delta.brow_inner = 14;
        delta.arousal = 12;
        break;
    case FACE_PERFORMANCE_IDLE_SOFTEN:
        delta.head_roll = (int8_t)(side * 12);
        delta.eye_open = -28;
        delta.squint = 18;
        delta.valence = 48;
        delta.arousal = 36;
        delta.attention = 22;
        break;
    case FACE_PERFORMANCE_IDLE_SLOW_BLINK:
        delta.head_pitch = 22;
        delta.eye_open = -127;
        delta.squint = 72;
        delta.valence = 14;
        break;
    case FACE_PERFORMANCE_IDLE_STRETCH:
        delta.head_pitch = -42;
        delta.body_lean_y = -58;
        delta.body_lean_x = (int8_t)(side * 18);
        delta.eye_open = -18;
        delta.arousal = 30;
        break;
    case FACE_PERFORMANCE_IDLE_CURIOUS:
        delta.head_yaw = (int8_t)(side * 36);
        delta.head_roll = (int8_t)(-side * 24);
        delta.gaze_x = (int8_t)(side * 42);
        delta.brow = 24;
        delta.brow_inner = 18;
        delta.arousal = 28;
        delta.attention = 36;
        break;
    case FACE_PERFORMANCE_IDLE_BREATHE:
        delta.head_pitch = 18;
        delta.body_lean_y = 44;
        delta.eye_open = -16;
        delta.valence = 18;
        break;
    case FACE_PERFORMANCE_IDLE_SIDE_EYE:
        delta.head_yaw = (int8_t)(-side * 24);
        delta.gaze_x = (int8_t)(side * 82);
        delta.eye_open = -14;
        delta.squint = 28;
        break;
    case FACE_PERFORMANCE_LISTEN_FOCUS:
        delta.head_pitch = -34;
        delta.body_lean_y = 28;
        delta.brow = 16;
        delta.brow_inner = 12;
        delta.arousal = 20;
        delta.attention = 60;
        break;
    case FACE_PERFORMANCE_LISTEN_ACK_NOD:
        delta.head_pitch = 68;
        delta.body_lean_y = 22;
        delta.brow = 8;
        delta.valence = 20;
        delta.attention = 48;
        delta.wave = PERFORMANCE_WAVE_GESTURE;
        break;
    case FACE_PERFORMANCE_LISTEN_HEAD_TILT:
        delta.head_roll = (int8_t)(side * 34);
        delta.head_yaw = (int8_t)(side * 22);
        delta.brow = 16;
        delta.valence = 16;
        delta.attention = 42;
        break;
    case FACE_PERFORMANCE_LISTEN_LEAN_IN:
        delta.head_pitch = -24;
        delta.body_lean_y = 64;
        delta.eye_open = 14;
        delta.brow = 10;
        delta.attention = 70;
        break;
    case FACE_PERFORMANCE_LISTEN_TRACK:
        delta.head_yaw = (int8_t)(side * 48);
        delta.body_lean_x = (int8_t)(side * 22);
        delta.gaze_x = (int8_t)(side * 58);
        delta.attention = 44;
        break;
    case FACE_PERFORMANCE_LISTEN_SLOW_BLINK:
        delta.head_pitch = 28;
        delta.eye_open = -118;
        delta.squint = 64;
        delta.valence = 24;
        delta.attention = 32;
        break;
    case FACE_PERFORMANCE_LISTEN_EMPATHY:
        delta.head_roll = (int8_t)(side * 22);
        delta.head_pitch = 18;
        delta.eye_open = -22;
        delta.brow_inner = 26;
        delta.valence = 34;
        delta.arousal = 24;
        delta.attention = 56;
        break;
    case FACE_PERFORMANCE_LISTEN_BRIGHTEN:
        delta.head_pitch = -36;
        delta.body_lean_y = 28;
        delta.brow = 26;
        delta.brow_inner = 18;
        delta.valence = 52;
        delta.arousal = 52;
        delta.attention = 62;
        break;
    case FACE_PERFORMANCE_THINK_SEARCH:
        delta.head_yaw = (int8_t)(side * 58);
        delta.gaze_x = (int8_t)(side * 76);
        delta.gaze_y = -26;
        delta.brow_inner = 18;
        delta.squint = 24;
        break;
    case FACE_PERFORMANCE_THINK_LOOK_UP:
        delta.head_pitch = -52;
        delta.gaze_y = -78;
        delta.head_roll = (int8_t)(side * 12);
        delta.brow = 20;
        delta.brow_inner = 16;
        break;
    case FACE_PERFORMANCE_THINK_TILT:
        delta.head_roll = (int8_t)(side * 42);
        delta.head_yaw = (int8_t)(side * 30);
        delta.eye_open = -20;
        delta.brow_inner = 24;
        delta.valence = -8;
        break;
    case FACE_PERFORMANCE_THINK_SQUINT:
        delta.head_yaw = (int8_t)(side * 30);
        delta.gaze_x = (int8_t)(side * 52);
        delta.eye_open = -38;
        delta.squint = 70;
        delta.brow_inner = -18;
        delta.arousal = 18;
        break;
    case FACE_PERFORMANCE_THINK_SETTLE:
        delta.head_pitch = 40;
        delta.body_lean_y = 32;
        delta.gaze_y = 28;
        delta.eye_open = -28;
        delta.arousal = -18;
        break;
    case FACE_PERFORMANCE_SPEAK_SMALL_NOD:
        delta.head_pitch = 42;
        delta.body_lean_y = 14;
        delta.wave = PERFORMANCE_WAVE_GESTURE;
        break;
    case FACE_PERFORMANCE_SPEAK_TURN:
        delta.head_yaw = (int8_t)(side * 34);
        delta.body_lean_x = (int8_t)(side * 16);
        delta.gaze_x = (int8_t)(side * 24);
        break;
    case FACE_PERFORMANCE_SPEAK_SETTLE:
        delta.head_pitch = 28;
        delta.body_lean_y = 34;
        delta.eye_open = -12;
        break;
    default:
        break;
    }
    return delta;
}

static void apply_activity_baseline(face_render_key_t *key)
{
    switch (key->controls.expression) {
    case FACE_ACTIVITY_LISTENING:
        key->attention = 255U;
        if (key->stage_expression != FACE_EXPRESSION_NEUTRAL) {
            break;
        }
        /*
         * Listening is a held performance, not merely another idle label.
         * The high-arousal, raised-brow target selects each atlas's authored
         * attentive expression while the sparse clips below add small nods,
         * tilts, blinks, and gaze tracking. Articulation remains untouched.
         */
        key->controls.eye_left_open =
            max_u8(key->controls.eye_left_open, 248U);
        key->controls.eye_right_open =
            max_u8(key->controls.eye_right_open, 248U);
        key->controls.brow = max_i8(key->controls.brow, 42);
        key->brow_inner = max_i8(key->brow_inner, 68);
        key->affect_valence = max_i8(key->affect_valence, 18);
        key->affect_arousal = max_u8(key->affect_arousal, 224U);
        break;
    case FACE_ACTIVITY_THINKING:
        key->attention = max_u8(key->attention, 176U);
        break;
    case FACE_ACTIVITY_SPEAKING:
        key->attention = max_u8(key->attention, 208U);
        break;
    case FACE_ACTIVITY_IDLE:
    default:
        key->attention = max_u8(key->attention, 144U);
        break;
    }
}

static void apply_delta(
    const performance_delta_t *delta,
    const face_performance_profile_t *profile,
    int32_t motion_amount,
    uint8_t expression_amount,
    face_render_key_t *key)
{
    key->head_yaw = add_i8(
        key->head_yaw,
        scaled_delta(
            delta->head_yaw, motion_amount, profile->motion_gain));
    key->head_pitch = add_i8(
        key->head_pitch,
        scaled_delta(
            delta->head_pitch, motion_amount, profile->motion_gain));
    key->head_roll = add_i8(
        key->head_roll,
        scaled_delta(
            delta->head_roll, motion_amount, profile->motion_gain));
    key->body_lean_x = add_i8(
        key->body_lean_x,
        scaled_delta(
            delta->body_lean_x, motion_amount, profile->motion_gain));
    key->body_lean_y = add_i8(
        key->body_lean_y,
        scaled_delta(
            delta->body_lean_y, motion_amount, profile->motion_gain));
    key->controls.look_x = add_i8(
        key->controls.look_x,
        scaled_delta(
            delta->gaze_x, motion_amount, profile->gaze_gain));
    key->controls.look_y = add_i8(
        key->controls.look_y,
        scaled_delta(
            delta->gaze_y, motion_amount, profile->gaze_gain));

    const int32_t blink_amount = scaled_delta(
        delta->eye_open, expression_amount, profile->blink_gain);
    key->controls.eye_left_open = add_u8(
        key->controls.eye_left_open, blink_amount);
    key->controls.eye_right_open = add_u8(
        key->controls.eye_right_open, blink_amount);

    key->controls.brow = add_i8(
        key->controls.brow,
        scaled_delta(
            delta->brow, expression_amount, profile->expression_gain));
    key->brow_inner = add_i8(
        key->brow_inner,
        scaled_delta(
            delta->brow_inner,
            expression_amount,
            profile->expression_gain));
    const int32_t squint = scaled_delta(
        delta->squint, expression_amount, profile->expression_gain);
    key->eye_left_squint = add_u8(key->eye_left_squint, squint);
    key->eye_right_squint = add_u8(key->eye_right_squint, squint);
    key->affect_valence = add_i8(
        key->affect_valence,
        scaled_delta(
            delta->valence,
            expression_amount,
            profile->expression_gain));
    key->affect_arousal = add_u8(
        key->affect_arousal,
        scaled_delta(
            delta->arousal,
            expression_amount,
            profile->expression_gain));
    key->attention = add_u8(
        key->attention,
        scaled_delta(
            delta->attention,
            expression_amount,
            profile->expression_gain));
}

bool face_performance_apply(
    const face_performance_profile_t *profile,
    uint32_t sample_clock,
    face_render_key_t *render_key,
    face_performance_frame_t *frame)
{
    if (render_key == NULL) {
        return false;
    }
    if (profile == NULL) {
        profile = &DEFAULT_PROFILE;
    }
    if (frame != NULL) {
        memset(frame, 0, sizeof(*frame));
    }

    uint8_t activity = render_key->controls.expression;
    if (activity > FACE_ACTIVITY_SPEAKING) {
        activity = FACE_ACTIVITY_IDLE;
    }
    apply_activity_baseline(render_key);

    const uint32_t window = activity_window(activity);
    const uint32_t epoch = sample_clock / window;
    const uint32_t position = sample_clock % window;
    const uint32_t noise = mix_u32(
        profile->seed ^ ((uint32_t)activity * 0x9e3779b9U) ^
        epoch);
    size_t clip_count;
    const uint8_t *clips = activity_clips(activity, &clip_count);
    const uint8_t clip = clips[noise % clip_count];
    const uint32_t duration = clip_duration(clip);
    const uint32_t margin = PERFORMANCE_SAMPLE_RATE / 2U;
    const uint32_t room = window - duration - margin * 2U;
    const uint32_t event_start =
        margin + (mix_u32(noise ^ 0xa53c91e5U) % (room + 1U));
    const int8_t direction = (noise & 0x100U) != 0U ? 1 : -1;

    uint8_t envelope = 0U;
    uint8_t phase = 0U;
    if (position >= event_start &&
        position < event_start + duration) {
        const uint32_t elapsed = position - event_start;
        envelope = event_envelope(elapsed, duration);
        phase = (uint8_t)(
            ((uint64_t)elapsed * 255U) / duration);
    }

    if (frame != NULL) {
        frame->epoch = epoch;
        frame->event_start = event_start;
        frame->activity = activity;
        frame->clip = clip;
        frame->active = envelope > 0U;
        frame->envelope = envelope;
        frame->phase = phase;
        frame->direction = direction;
    }
    if (envelope == 0U) {
        return true;
    }

    const performance_delta_t delta =
        clip_delta(clip, direction);
    const int32_t motion_amount =
        delta.wave == PERFORMANCE_WAVE_GESTURE
            ? gesture_amount(phase, envelope)
            : envelope;

    /*
     * Neutral stage directions leave full room for ambient expression.
     * Authored non-neutral emotions suppress brow/squint/affect changes in
     * proportion to their weight but do not freeze believable head motion.
     */
    uint8_t expression_amount = envelope;
    if (render_key->stage_expression != FACE_EXPRESSION_NEUTRAL) {
        expression_amount = (uint8_t)(
            (uint16_t)envelope *
            (255U - render_key->expression_weight) /
            255U);
    } else {
        render_key->expression_weight = max_u8(
            render_key->expression_weight,
            (uint8_t)(96U + (uint16_t)envelope * 96U / 255U));
    }
    apply_delta(
        &delta,
        profile,
        motion_amount,
        expression_amount,
        render_key);
    return true;
}
