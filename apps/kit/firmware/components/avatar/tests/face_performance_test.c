#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "iterate/kit/avatar/face_performance.h"
#include "iterate/kit/avatar/face_pose.h"
#include "iterate/kit/avatar/face_stage.h"

static face_render_key_t test_key(uint8_t activity)
{
    face_render_key_t key;
    memset(&key, 0, sizeof(key));
    key.controls.eye_left_open = 255U;
    key.controls.eye_right_open = 255U;
    key.controls.expression = activity;
    key.viseme = FACE_VISEME_O;
    key.phoneme = 17U;
    key.viseme_weight = 211U;
    key.audio_level = 133U;
    key.viseme_set = FACE_VISEME_SET_OVR15;
    key.viseme_secondary = FACE_VISEME_E;
    key.viseme_blend = 91U;
    key.speech_phase = FACE_SPEECH_ACTIVE;
    key.expression_weight = 255U;
    key.attention = 100U;
    key.schema_version = FACE_RENDER_KEY_SCHEMA_VERSION;
    key.stage_expression = FACE_EXPRESSION_NEUTRAL;
    return key;
}

static void test_deterministic_and_articulation_safe(void)
{
    face_render_key_t first = test_key(FACE_ACTIVITY_LISTENING);
    face_render_key_t second = first;
    const face_render_key_t source = first;
    face_performance_frame_t first_frame;
    face_performance_frame_t second_frame;

    assert(face_performance_apply(
        NULL, 1234567U, &first, &first_frame));
    assert(face_performance_apply(
        NULL, 1234567U, &second, &second_frame));
    assert(memcmp(&first, &second, sizeof(first)) == 0);
    assert(memcmp(
        &first_frame, &second_frame, sizeof(first_frame)) == 0);
    assert(memcmp(
        &first.controls.mouth_open,
        &source.controls.mouth_open,
        5U) == 0);
    assert(first.controls.expression == source.controls.expression);
    assert(first.controls.flags == source.controls.flags);
    assert(memcmp(&first.viseme, &source.viseme, 8U) == 0);
    assert(first.attention == 255U);
    assert(first.controls.brow >= 42);
    assert(first.brow_inner >= 68);
    assert(first.affect_arousal >= 224U);
}

static void test_stage_direction_wins(void)
{
    face_render_key_t key = test_key(FACE_ACTIVITY_LISTENING);
    key.stage_expression = FACE_EXPRESSION_JOY;
    key.expression_weight = 255U;
    key.affect_valence = 94;
    key.affect_arousal = 184U;
    key.brow_inner = 22;
    key.eye_left_squint = 68U;
    key.eye_right_squint = 68U;
    const int8_t valence = key.affect_valence;
    const uint8_t arousal = key.affect_arousal;
    const int8_t brow = key.brow_inner;
    const uint8_t left_squint = key.eye_left_squint;
    const uint8_t right_squint = key.eye_right_squint;

    for (uint32_t sample = 0U; sample < 400000U; sample += 997U) {
        face_render_key_t frame = key;
        assert(face_performance_apply(NULL, sample, &frame, NULL));
        assert(frame.stage_expression == FACE_EXPRESSION_JOY);
        assert(frame.expression_weight == 255U);
        assert(frame.affect_valence == valence);
        assert(frame.affect_arousal == arousal);
        assert(frame.brow_inner == brow);
        assert(frame.eye_left_squint == left_squint);
        assert(frame.eye_right_squint == right_squint);
    }
}

static size_t collect_scheduled_clips(
    uint8_t activity, uint8_t *seen, size_t capacity)
{
    size_t count = 0U;
    for (uint32_t second = 0U; second < 3600U; ++second) {
        face_render_key_t key = test_key(activity);
        face_performance_frame_t frame;
        assert(face_performance_apply(
            NULL, second * 16000U, &key, &frame));
        if (frame.clip < capacity && seen[frame.clip] == 0U) {
            seen[frame.clip] = 1U;
            ++count;
        }
    }
    return count;
}

static void test_activity_families_are_varied(void)
{
    uint8_t idle_seen[FACE_PERFORMANCE_COUNT] = {0};
    uint8_t listen_seen[FACE_PERFORMANCE_COUNT] = {0};
    uint8_t think_seen[FACE_PERFORMANCE_COUNT] = {0};
    uint8_t speak_seen[FACE_PERFORMANCE_COUNT] = {0};
    assert(collect_scheduled_clips(
        FACE_ACTIVITY_IDLE,
        idle_seen,
        FACE_PERFORMANCE_COUNT) >= 9U);
    assert(collect_scheduled_clips(
        FACE_ACTIVITY_LISTENING,
        listen_seen,
        FACE_PERFORMANCE_COUNT) >= 7U);
    assert(collect_scheduled_clips(
        FACE_ACTIVITY_THINKING,
        think_seen,
        FACE_PERFORMANCE_COUNT) >= 5U);
    assert(collect_scheduled_clips(
        FACE_ACTIVITY_SPEAKING,
        speak_seen,
        FACE_PERFORMANCE_COUNT) >= 3U);
}

static void test_activity_change_is_immediate(void)
{
    const uint32_t clock = 123456U;
    face_render_key_t idle = test_key(FACE_ACTIVITY_IDLE);
    face_render_key_t listening =
        test_key(FACE_ACTIVITY_LISTENING);
    face_performance_frame_t idle_frame;
    face_performance_frame_t listening_frame;
    assert(face_performance_apply(
        NULL, clock, &idle, &idle_frame));
    assert(face_performance_apply(
        NULL, clock, &listening, &listening_frame));
    assert(idle_frame.activity == FACE_ACTIVITY_IDLE);
    assert(listening_frame.activity == FACE_ACTIVITY_LISTENING);
    assert(idle_frame.clip != listening_frame.clip);
    assert(idle.attention < listening.attention);
}

static void test_profile_controls_motion(void)
{
    const face_performance_profile_t still = {
        .seed = 1U,
        .motion_gain = 0U,
        .gaze_gain = 0U,
        .expression_gain = 0U,
        .blink_gain = 0U,
    };
    for (uint32_t sample = 0U; sample < 500000U; sample += 733U) {
        face_render_key_t key = test_key(FACE_ACTIVITY_IDLE);
        const face_render_key_t original = key;
        assert(face_performance_apply(
            &still, sample, &key, NULL));
        assert(key.head_yaw == original.head_yaw);
        assert(key.head_pitch == original.head_pitch);
        assert(key.head_roll == original.head_roll);
        assert(key.body_lean_x == original.body_lean_x);
        assert(key.body_lean_y == original.body_lean_y);
        assert(key.controls.look_x == original.controls.look_x);
        assert(key.controls.look_y == original.controls.look_y);
        assert(key.controls.eye_left_open ==
               original.controls.eye_left_open);
        assert(key.controls.eye_right_open ==
               original.controls.eye_right_open);
    }
}

int main(void)
{
    assert(sizeof(face_performance_profile_t) <= 8U);
    assert(sizeof(face_performance_frame_t) <= 20U);
    test_deterministic_and_articulation_safe();
    test_stage_direction_wins();
    test_activity_families_are_varied();
    test_activity_change_is_immediate();
    test_profile_controls_motion();
    puts("face_performance_test: PASS");
    return 0;
}
