#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/avatar/face_doze.h"
#include "iterate/kit/avatar/face_render.h"
#include "iterate/kit/avatar/face_stage.h"

static uint16_t pixels[FACE_RENDER_PIXEL_COUNT];
static uint16_t awake_pixels[FACE_RENDER_PIXEL_COUNT];

static void doze_key_is_unmistakably_not_speaking(void)
{
    face_render_key_t key = {0};
    key.controls.eye_left_open = 255U;
    key.controls.eye_right_open = 220U;
    key.controls.mouth_open = 190U;
    key.controls.mouth_width = 180U;
    key.controls.mouth_round = 120U;
    key.controls.flags = FACE_KEYFRAME_FLAG_SPEAKING;
    key.speech_phase = FACE_SPEECH_ACTIVE;
    key.audio_level = 160U;

    /*
     * Conversation end can race the latest PCM-derived speaking pose. The
     * doze state must override every retained articulation field or a sleeping
     * device can freeze with an open mouth/eye and still look engaged.
     */
    face_doze_prepare_render_key(&key);

    assert(key.controls.eye_left_open == 0U);
    assert(key.controls.eye_right_open == 0U);
    assert(key.controls.mouth_open == 0U);
    assert(key.controls.mouth_width == 0U);
    assert(key.controls.mouth_round == 0U);
    assert((key.controls.flags & FACE_KEYFRAME_FLAG_SPEAKING) == 0U);
    assert((key.controls.flags & FACE_KEYFRAME_FLAG_BLINKING) != 0U);
    assert(key.speech_phase == FACE_SPEECH_IDLE);
    assert(key.audio_level == 0U);
    assert(key.stage_expression == FACE_EXPRESSION_SLEEPY);
    assert(key.expression_weight == UINT8_MAX);
}

static void doze_overlay_is_a_bounded_visible_sprite(void)
{
    memset(pixels, 0, sizeof(pixels));

    /*
     * Closed lids alone were not visually decisive on the physical StackChan.
     * Assert actual post-render pixels for both Z glyphs, plus neighbouring
     * untouched pixels, so a later atlas or status-HUD refactor cannot quietly
     * regress the device to an ambiguous neutral face.
     */
    assert(face_doze_apply_overlay(
        pixels, FACE_RENDER_PIXEL_COUNT, 123456U));
    assert(pixels[6U * FACE_RENDER_WIDTH + 137U] == UINT16_C(0x7bef));
    assert(pixels[7U * FACE_RENDER_WIDTH + 143U] == UINT16_C(0x7bef));
    assert(pixels[8U * FACE_RENDER_WIDTH + 141U] == UINT16_C(0x7bef));
    assert(pixels[12U * FACE_RENDER_WIDTH + 137U] == UINT16_C(0x7bef));
    assert(pixels[20U * FACE_RENDER_WIDTH + 129U] == UINT16_C(0x7bef));
    assert(pixels[24U * FACE_RENDER_WIDTH + 133U] == UINT16_C(0x7bef));
    assert(pixels[5U * FACE_RENDER_WIDTH + 137U] == 0U);
    assert(pixels[6U * FACE_RENDER_WIDTH + 136U] == 0U);

    /* A truncated caller buffer must fail before writing a partial face. */
    memset(pixels, 0, sizeof(pixels));
    assert(!face_doze_apply_overlay(
        pixels, FACE_RENDER_PIXEL_COUNT - 1U, 0U));
    assert(pixels[6U * FACE_RENDER_WIDTH + 137U] == 0U);
}

static void every_avatar_renders_a_distinct_closed_eye_pose(void)
{
    face_render_key_t awake = {0};
    awake.controls.eye_left_open = UINT8_MAX;
    awake.controls.eye_right_open = UINT8_MAX;

    /*
     * Checking only the input key would allow a later registry/performance
     * refactor to reopen the eyes after the doze module has done its work. The
     * user-visible invariant is stronger: every selectable atlas must emit a
     * different face image for the held blink pose before the Z overlay is
     * applied. Comparing the same atlas at the same clock isolates the eyelid
     * selection from breathing, idle sequences, and overlay pixels.
     */
    for (size_t index = 0U;
         index < face_avatar_registry_count();
         ++index) {
        face_render_key_t dozing = awake;
        face_doze_prepare_render_key(&dozing);
        assert(face_avatar_registry_render_snapshot_at(
            index,
            &awake,
            543210U,
            awake_pixels,
            FACE_RENDER_PIXEL_COUNT));
        assert(face_avatar_registry_render_snapshot_at(
            index,
            &dozing,
            543210U,
            pixels,
            FACE_RENDER_PIXEL_COUNT));
        assert(memcmp(pixels, awake_pixels, sizeof(pixels)) != 0);
    }
}

/* The frame every board draws: the pose's key, and dozing, the sleepy key with the Z over it. */
static void a_pose_renders_as_the_key_then_the_doze(void)
{
    static uint16_t expected[FACE_RENDER_PIXEL_COUNT];
    face_avatar_registry_t registry = {0};
    face_render_key_t key;
    face_render_key_t expected_key;
    face_pose_t pose = {0};
    pose.eye_open = 200U;
    pose.mouth_open = 120U;
    pose.level = 900U;
    assert(face_avatar_registry_init(&registry));

    for (int dozing = 0; dozing <= 1; ++dozing) {
        face_render_key_from_pose(&pose, &expected_key);
        if (dozing) face_doze_prepare_render_key(&expected_key);
        assert(face_avatar_registry_render(
            &registry, &expected_key, 4321U, expected, FACE_RENDER_PIXEL_COUNT));
        if (dozing) {
            assert(face_doze_apply_overlay(
                expected, FACE_RENDER_PIXEL_COUNT, 4321U));
        }
        assert(face_avatar_registry_render_pose(
            &registry, &pose, dozing != 0, 4321U, &key, pixels,
            FACE_RENDER_PIXEL_COUNT));
        assert(memcmp(&key, &expected_key, sizeof(key)) == 0);
        assert(memcmp(pixels, expected, sizeof(pixels)) == 0);
    }
    /* A buffer too small for the frame fails it; no board shows half a doze. */
    assert(!face_avatar_registry_render_pose(
        &registry, &pose, true, 4321U, &key, pixels,
        FACE_RENDER_PIXEL_COUNT - 1U));
}

int main(void)
{
    doze_key_is_unmistakably_not_speaking();
    doze_overlay_is_a_bounded_visible_sprite();
    every_avatar_renders_a_distinct_closed_eye_pose();
    a_pose_renders_as_the_key_then_the_doze();
    puts("face_doze_test: PASS");
    return 0;
}
