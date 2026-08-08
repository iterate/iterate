#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "iterate/kit/avatar/face_keyframe.h"

int main(void)
{
    assert(sizeof(face_keyframe_t) == FACE_KEYFRAME_BYTES);
    assert(sizeof(face_render_key_t) == FACE_RENDER_KEY_BYTES);

    face_pose_t source;
    memset(&source, 0, sizeof(source));
    source.mouth_open = 240;
    source.mouth_width = 180;
    source.mouth_round = 31;
    source.mouth_press = 12;
    source.mouth_teeth = 90;
    source.eye_open = 42;
    source.gaze_x = -7;
    source.gaze_y = 5;
    source.activity = FACE_ACTIVITY_SPEAKING;
    source.speaking = true;
    source.viseme = FACE_VISEME_TH;
    source.phoneme = 7U;
    source.confidence = 211;
    source.level = 4096;

    face_keyframe_t keyframe;
    memset(&keyframe, 0, sizeof(keyframe));
    face_keyframe_from_pose(&source, &keyframe);
    assert(keyframe.mouth_open == source.mouth_open);
    assert(keyframe.eye_left_open == source.eye_open);
    assert(keyframe.eye_right_open == source.eye_open);
    assert(keyframe.look_x == source.gaze_x);
    assert(keyframe.look_y == source.gaze_y);
    assert(
        (keyframe.flags & FACE_KEYFRAME_FLAG_SPEAKING) != 0);
    assert(
        (keyframe.flags & FACE_KEYFRAME_FLAG_BLINKING) != 0);

    face_pose_t decoded;
    memset(&decoded, 0, sizeof(decoded));
    face_pose_apply_keyframe(&decoded, &keyframe);
    assert(decoded.mouth_open == source.mouth_open);
    assert(decoded.mouth_width == source.mouth_width);
    assert(decoded.eye_open == source.eye_open);
    assert(decoded.gaze_x == source.gaze_x);
    assert(decoded.activity == source.activity);
    assert(decoded.speaking);
    assert(decoded.viseme == FACE_VISEME_NONE);

    face_render_key_t render_key;
    memset(&render_key, 0, sizeof(render_key));
    face_render_key_from_pose(&source, &render_key);
    assert(
        memcmp(&render_key.controls, &keyframe, sizeof(keyframe)) == 0);
    assert(render_key.viseme == source.viseme);
    assert(render_key.phoneme == source.phoneme);
    assert(render_key.viseme_weight == source.confidence);
    assert(render_key.audio_level == 127);
    assert(render_key.viseme_set == FACE_VISEME_SET_OVR15);
    assert(render_key.viseme_secondary == FACE_VISEME_NONE);
    assert(render_key.speech_phase == FACE_SPEECH_ACTIVE);
    assert(render_key.affect_arousal == 127);
    assert(render_key.expression_weight == 255U);
    assert(render_key.attention == 192U);
    assert(
        render_key.schema_version == FACE_RENDER_KEY_SCHEMA_VERSION);

    memset(&decoded, 0, sizeof(decoded));
    face_pose_apply_render_key(&decoded, &render_key);
    assert(decoded.mouth_open == source.mouth_open);
    assert(decoded.viseme == source.viseme);
    assert(decoded.phoneme == source.phoneme);
    assert(decoded.confidence == source.confidence);
    assert(decoded.level >= 4080 && decoded.level <= 4112);

    puts("face_keyframe_test: PASS");
    return 0;
}
