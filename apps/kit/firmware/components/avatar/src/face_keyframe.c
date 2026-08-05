#include "iterate/kit/avatar/face_keyframe.h"

#include <string.h>

void face_keyframe_from_pose(
    const face_pose_t *pose, face_keyframe_t *keyframe)
{
    if (pose == NULL || keyframe == NULL) {
        return;
    }
    keyframe->mouth_open = pose->mouth_open;
    keyframe->mouth_width = pose->mouth_width;
    keyframe->mouth_round = pose->mouth_round;
    keyframe->mouth_press = pose->mouth_press;
    keyframe->mouth_teeth = pose->mouth_teeth;
    keyframe->eye_left_open = pose->eye_open;
    keyframe->eye_right_open = pose->eye_open;
    keyframe->look_x = pose->gaze_x;
    keyframe->look_y = pose->gaze_y;
    keyframe->brow = 0;
    keyframe->expression = pose->activity;
    keyframe->flags =
        (uint8_t)(pose->speaking ? FACE_KEYFRAME_FLAG_SPEAKING : 0U);
    if (pose->eye_open < 64U) {
        keyframe->flags |= FACE_KEYFRAME_FLAG_BLINKING;
    }
}

void face_pose_apply_keyframe(
    face_pose_t *pose, const face_keyframe_t *keyframe)
{
    if (pose == NULL || keyframe == NULL) {
        return;
    }
    pose->mouth_open = keyframe->mouth_open;
    pose->mouth_width = keyframe->mouth_width;
    pose->mouth_round = keyframe->mouth_round;
    pose->mouth_press = keyframe->mouth_press;
    pose->mouth_teeth = keyframe->mouth_teeth;
    pose->eye_open = (uint8_t)(
        ((uint16_t)keyframe->eye_left_open +
         (uint16_t)keyframe->eye_right_open) /
        2U);
    pose->gaze_x = keyframe->look_x;
    pose->gaze_y = keyframe->look_y;
    pose->activity = keyframe->expression;
    pose->speaking =
        (keyframe->flags & FACE_KEYFRAME_FLAG_SPEAKING) != 0;
    pose->viseme = FACE_VISEME_NONE;
    pose->phoneme = FACE_PHONEME_NONE;
    pose->confidence = 0;
}

void face_render_key_from_pose(
    const face_pose_t *pose, face_render_key_t *render_key)
{
    if (pose == NULL || render_key == NULL) {
        return;
    }
    memset(render_key, 0, sizeof(*render_key));
    face_keyframe_from_pose(pose, &render_key->controls);
    render_key->viseme = pose->viseme;
    render_key->phoneme = pose->phoneme;
    render_key->viseme_weight = pose->confidence;
    const uint32_t compressed_level =
        ((uint32_t)pose->level * 255U + 4095U) / 8192U;
    render_key->audio_level = (uint8_t)(
        compressed_level > 255U ? 255U : compressed_level);
    render_key->viseme_set = FACE_VISEME_SET_OVR15;
    render_key->viseme_secondary = FACE_VISEME_NONE;
    render_key->speech_phase =
        pose->speaking ? FACE_SPEECH_ACTIVE : FACE_SPEECH_IDLE;
    render_key->affect_arousal = render_key->audio_level;
    render_key->expression_weight = 255U;
    render_key->attention = 192U;
    render_key->schema_version = FACE_RENDER_KEY_SCHEMA_VERSION;
}

void face_pose_apply_render_key(
    face_pose_t *pose, const face_render_key_t *render_key)
{
    if (pose == NULL || render_key == NULL) {
        return;
    }
    face_pose_apply_keyframe(pose, &render_key->controls);
    pose->viseme = render_key->viseme;
    pose->phoneme = render_key->phoneme;
    pose->confidence = render_key->viseme_weight;
    pose->level = (uint16_t)(
        ((uint32_t)render_key->audio_level * 8192U + 127U) / 255U);
}
