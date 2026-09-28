#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "iterate/kit/avatar/face_stage.h"

int main(void)
{
    face_render_key_t key;
    memset(&key, 0, sizeof(key));
    key.controls.mouth_open = 173U;
    key.controls.mouth_width = 141U;
    key.controls.expression = FACE_ACTIVITY_LISTENING;
    key.controls.look_x = -40;
    key.controls.look_y = 22;
    key.audio_level = 90U;
    key.schema_version = FACE_RENDER_KEY_SCHEMA_VERSION;

    /* A held expression owns the face's actions and affect, never the mouth. */
    assert(face_stage_apply_held_expression(FACE_EXPRESSION_WARM, &key));
    assert(key.controls.mouth_open == 173U);
    assert(key.controls.mouth_width == 141U);
    assert(key.audio_level == 90U);
    assert(key.controls.expression == FACE_ACTIVITY_LISTENING);
    assert(key.stage_expression == FACE_EXPRESSION_WARM);
    assert(key.expression_weight == UINT8_MAX);
    assert(key.mouth_corner_left == 36);
    assert(key.mouth_corner_right == 36);
    assert(key.affect_valence == 52);
    assert(key.controls.look_x == 0);
    assert(key.controls.look_y == 0);

    /* Skeptical is asymmetric: its right eye and brow lead. */
    assert(face_stage_apply_held_expression(FACE_EXPRESSION_SKEPTICAL, &key));
    assert(key.eye_right_squint > key.eye_left_squint);
    assert(key.brow_outer_right > key.brow_outer_left);

    const face_render_key_t before = key;
    assert(!face_stage_apply_held_expression(FACE_EXPRESSION_COUNT, &key));
    assert(memcmp(&key, &before, sizeof(key)) == 0);
    assert(!face_stage_apply_held_expression(FACE_EXPRESSION_JOY, NULL));

    puts("face_stage_test: PASS");
    return 0;
}
