#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "iterate/kit/avatar/face_stage.h"

int main(void)
{
    assert(sizeof(face_stage_cue_t) == FACE_STAGE_CUE_BYTES);
    face_render_key_t key;
    memset(&key, 0, sizeof(key));
    key.controls.mouth_open = 173U;
    key.controls.mouth_width = 141U;
    key.controls.expression = FACE_ACTIVITY_LISTENING;
    key.viseme = FACE_VISEME_TH;
    key.viseme_weight = 210U;
    key.schema_version = FACE_RENDER_KEY_SCHEMA_VERSION;

    const face_stage_cue_t cue = {
        .start_sample = 1600U,
        .attack_samples = 1600U,
        .hold_samples = 3200U,
        .release_samples = 1600U,
        .cue_id = 17U,
        .expression = FACE_EXPRESSION_WARM,
        .gesture = FACE_GESTURE_NOD,
        .gaze_target = FACE_GAZE_USER,
        .blend_mode = FACE_STAGE_BLEND_REPLACE,
        .easing = FACE_STAGE_EASE_SMOOTHSTEP,
        .interrupt_mode = FACE_STAGE_INTERRUPT_BLEND,
        .intensity = 220U,
        .valence = 62,
        .arousal = 130U,
    };

    assert(!face_stage_cue_apply(&cue, 1599U, &key));
    assert(face_stage_cue_apply(&cue, 2400U, &key));
    assert(key.controls.mouth_open == 173U);
    assert(key.controls.mouth_width == 141U);
    assert(key.viseme == FACE_VISEME_TH);
    assert(key.viseme_weight == 210U);
    assert(key.mouth_corner_left > 0);
    assert(key.mouth_corner_right > 0);
    assert(key.affect_valence > 0);
    assert(key.controls.expression == FACE_ACTIVITY_LISTENING);
    assert(key.stage_expression == FACE_EXPRESSION_WARM);

    const int8_t attack_corner = key.mouth_corner_left;
    assert(face_stage_cue_apply(&cue, 4000U, &key));
    assert(key.mouth_corner_left > attack_corner);

    face_render_key_t ended;
    memset(&ended, 0, sizeof(ended));
    assert(!face_stage_cue_apply(&cue, 8001U, &ended));

    puts("face_stage_test: PASS");
    return 0;
}
