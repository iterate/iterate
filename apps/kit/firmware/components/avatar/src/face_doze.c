#include "iterate/kit/avatar/face_doze.h"

#include "iterate/kit/avatar/face_render.h"
#include "iterate/kit/avatar/face_stage.h"

/*
 * These are source-frame pixels. StackChan scales them 2x and the Stick scales
 * the same 160x120 product to its panel, so even the smaller mark remains
 * legible without a second target-specific bitmap or framebuffer.
 */
enum {
    DOZE_LARGE_Z_X = 137,
    DOZE_LARGE_Z_Y = 6,
    DOZE_SMALL_Z_X = 129,
    DOZE_SMALL_Z_Y = 20,
};

/*
 * A one-source-pixel diagonal looked like incidental display noise once the
 * 160x120 face was scaled onto the physical panels. These masks make the main
 * mark seven pixels square with a two-pixel stroke and grow the companion to
 * five pixels. Authoring the weight here keeps both targets visually identical
 * and avoids target-side font rendering or another asset allocation.
 */
static const uint8_t LARGE_Z_ROWS[7] = {
    0x7fU,
    0x7fU,
    0x06U,
    0x0cU,
    0x18U,
    0x7fU,
    0x7fU,
};

static const uint8_t SMALL_Z_ROWS[5] = {
    0x1fU,
    0x03U,
    0x06U,
    0x0cU,
    0x1fU,
};

static void draw_mask(
    uint16_t *rgb565,
    uint32_t origin_x,
    uint32_t origin_y,
    const uint8_t *rows,
    uint32_t width,
    uint32_t height,
    uint16_t colour)
{
    for (uint32_t row = 0U; row < height; ++row) {
        for (uint32_t column = 0U; column < width; ++column) {
            const uint8_t bit = (uint8_t)(1U << (width - 1U - column));
            if ((rows[row] & bit) != 0U) {
                rgb565[(origin_y + row) * FACE_RENDER_WIDTH +
                       origin_x + column] = colour;
            }
        }
    }
}

void face_doze_prepare_render_key(face_render_key_t *render_key)
{
    if (render_key == NULL) {
        return;
    }

    /*
     * BLINKING is a held lid-close command in the sprite player, not a request
     * for its ordinary periodic blink. Without the flag, the registry treats
     * two zero eye controls as an uninitialized render key and defensively
     * opens the eyes—the exact failure that made the previous “sleeping” state
     * look awake on the physical device.
     */
    render_key->controls.eye_left_open = 0U;
    render_key->controls.eye_right_open = 0U;
    render_key->controls.mouth_open = 0U;
    render_key->controls.mouth_width = 0U;
    render_key->controls.mouth_round = 0U;
    render_key->controls.flags =
        (uint8_t)((render_key->controls.flags &
                   (uint8_t)~FACE_KEYFRAME_FLAG_SPEAKING) |
                  FACE_KEYFRAME_FLAG_BLINKING);
    render_key->speech_phase = FACE_SPEECH_IDLE;
    render_key->viseme_weight = 0U;
    render_key->audio_level = 0U;

    /*
     * All three published sprite sheets already contain an AI-authored
     * `sleepy` bank that passed the original native-grid snap and locked-
     * palette quantization pipeline. Selecting that bank preserves each
     * character's own eyelid design; a generic rectangle painted here would
     * merely imitate art that is already compiled into flash.
     */
    (void)face_stage_apply_held_expression(
        FACE_EXPRESSION_SLEEPY, render_key);
}

bool face_doze_apply_overlay(
    uint16_t *rgb565,
    size_t pixel_capacity,
    uint32_t sample_clock)
{
    (void)sample_clock;
    if (rgb565 == NULL || pixel_capacity < FACE_RENDER_PIXEL_COUNT) {
        return false;
    }

    /*
     * The overlay is intentionally colour-stable across sprite sets. Reusing
     * a character palette would make sleep invisible on a dark atlas, while a
     * bright status colour would compete with errors and network health. This
     * muted blue-grey survives both panels' RGB565 path without looking like
     * another status LED.
     */
    const uint16_t doze_colour = UINT16_C(0x7bef);
    draw_mask(
        rgb565,
        DOZE_LARGE_Z_X,
        DOZE_LARGE_Z_Y,
        LARGE_Z_ROWS,
        7U,
        7U,
        doze_colour);
    draw_mask(
        rgb565,
        DOZE_SMALL_Z_X,
        DOZE_SMALL_Z_Y,
        SMALL_Z_ROWS,
        5U,
        5U,
        doze_colour);
    return true;
}
