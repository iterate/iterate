#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "iterate/kit/avatar/face_sprite_sheet.h"

enum {
    TEST_CELL_BASE_NEUTRAL = 0,
    TEST_CELL_BASE_JOY,
    TEST_CELL_EYE_OPEN,
    TEST_CELL_EYE_CLOSED,
    TEST_CELL_PUPIL,
    TEST_CELL_BROW_LOW,
    TEST_CELL_BROW_HIGH,
    TEST_CELL_MOUTH_REST,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_OVERLAY,
    TEST_CELL_COUNT,
    TEST_MOUTH_SLOT_COUNT = 23,
};

enum {
    COLOR_NEUTRAL = 0x632c,
    COLOR_JOY = 0xff20,
    COLOR_EYE = 0xffff,
    COLOR_PUPIL = 0x001f,
    COLOR_BROW = 0x7800,
    COLOR_MOUTH_REST = 0xf800,
    COLOR_MOUTH_HALF = 0xf81f,
    COLOR_MOUTH_WIDE = 0x07e0,
    COLOR_MOUTH_CUSTOM = 0x07ff,
    COLOR_BROW_HIGH = 0xffe0,
    COLOR_CYCLE_A = 0x4208,
    COLOR_CYCLE_B = 0xbdf7,
};

static const uint16_t TEST_PALETTE[] = {
    0x0000,
    COLOR_NEUTRAL,
    COLOR_JOY,
    COLOR_EYE,
    COLOR_PUPIL,
    COLOR_BROW,
    COLOR_MOUTH_REST,
    COLOR_MOUTH_HALF,
    COLOR_MOUTH_WIDE,
    COLOR_MOUTH_CUSTOM,
    COLOR_BROW_HIGH,
    COLOR_CYCLE_A,
    COLOR_CYCLE_B,
};

/*
 * Cell zero: raw 8x6 neutral base.
 * Cell one: PackBits "repeat palette index 2 forty-eight times".
 * Remaining cells are tiny raw replacement patches.
 */
static const uint8_t TEST_BLOB[] = {
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1,
    209, 2,
    3, 3,
    5, 5,
    4,
    5, 5,
    10, 10,
    6, 6,
    7, 7, 7, 7,
    8, 8, 8, 8, 8, 8, 8, 8,
    9, 9, 9, 9, 9, 9,
    11,
};

static const face_sprite_cell_t TEST_CELLS[] = {
    { 8, 6, 0, 0, 0, 48, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 8, 6, 0, 0, 48, 2, FACE_SPRITE_ENCODING_PACKBITS, {0, 0, 0} },
    { 2, 1, 0, 0, 50, 2, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 2, 1, 0, 0, 52, 2, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 1, 1, 0, 0, 54, 1, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 2, 1, 0, 0, 55, 2, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 2, 1, 0, 0, 57, 2, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 2, 1, 0, 0, 59, 2, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 2, 2, 0, 0, 61, 4, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 4, 2, 0, 0, 65, 8, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 3, 2, 0, 0, 73, 6, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
    { 1, 1, 0, 0, 79, 1, FACE_SPRITE_ENCODING_RAW, {0, 0, 0} },
};

static const uint16_t TEST_MOUTHS_NEUTRAL[TEST_MOUTH_SLOT_COUNT] = {
    TEST_CELL_MOUTH_REST,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_REST,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_CUSTOM,
};

static const uint16_t TEST_MOUTHS_JOY[TEST_MOUTH_SLOT_COUNT] = {
    TEST_CELL_MOUTH_REST,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_REST,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_WIDE,
    TEST_CELL_MOUTH_CUSTOM,
    TEST_CELL_MOUTH_HALF,
    TEST_CELL_MOUTH_CUSTOM,
};

#define TEST_EYE_LEFT \
    { 1, 2, 2, \
      {TEST_CELL_EYE_OPEN, TEST_CELL_EYE_CLOSED, \
       FACE_SPRITE_CELL_NONE, FACE_SPRITE_CELL_NONE, \
       FACE_SPRITE_CELL_NONE, FACE_SPRITE_CELL_NONE}, \
      0, 0 }

#define TEST_EYE_RIGHT \
    { 5, 2, 2, \
      {TEST_CELL_EYE_OPEN, TEST_CELL_EYE_CLOSED, \
       FACE_SPRITE_CELL_NONE, FACE_SPRITE_CELL_NONE, \
       FACE_SPRITE_CELL_NONE, FACE_SPRITE_CELL_NONE}, \
      FACE_SPRITE_SLOT_FLIP_X, 0 }

#define TEST_PUPIL_LEFT \
    { 1, 2, 1, 2, 2, 2, TEST_CELL_PUPIL, 1, 0 }

#define TEST_PUPIL_RIGHT \
    { 5, 2, 5, 2, 6, 2, TEST_CELL_PUPIL, 1, 0 }

#define TEST_BROW_LEFT \
    { 1, 1, 2, \
      {TEST_CELL_BROW_LOW, TEST_CELL_BROW_HIGH, \
       FACE_SPRITE_CELL_NONE, FACE_SPRITE_CELL_NONE, \
       FACE_SPRITE_CELL_NONE}, \
      1, 0 }

#define TEST_BROW_RIGHT \
    { 5, 1, 2, \
      {TEST_CELL_BROW_LOW, TEST_CELL_BROW_HIGH, \
       FACE_SPRITE_CELL_NONE, FACE_SPRITE_CELL_NONE, \
       FACE_SPRITE_CELL_NONE}, \
      1, FACE_SPRITE_SLOT_FLIP_X }

static const face_sprite_bank_t TEST_BANKS[] = {
    {
        .target = { 0, 72, 0, 0, 0, {0, 0, 0} },
        .base_cell = TEST_CELL_BASE_NEUTRAL,
        .overlay_cell = TEST_CELL_OVERLAY,
        .overlay_x = 0,
        .overlay_y = 0,
        .mouth = { 3, 4, TEST_MOUTHS_NEUTRAL },
        .eye_left = TEST_EYE_LEFT,
        .eye_right = TEST_EYE_RIGHT,
        .pupil_left = TEST_PUPIL_LEFT,
        .pupil_right = TEST_PUPIL_RIGHT,
        .brow_left = TEST_BROW_LEFT,
        .brow_right = TEST_BROW_RIGHT,
    },
    {
        .target = { 94, 184, 78, 22, 68, {0, 0, 0} },
        .base_cell = TEST_CELL_BASE_JOY,
        .overlay_cell = TEST_CELL_OVERLAY,
        .overlay_x = 0,
        .overlay_y = 0,
        .mouth = { 3, 4, TEST_MOUTHS_JOY },
        .eye_left = TEST_EYE_LEFT,
        .eye_right = TEST_EYE_RIGHT,
        .pupil_left = TEST_PUPIL_LEFT,
        .pupil_right = TEST_PUPIL_RIGHT,
        .brow_left = TEST_BROW_LEFT,
        .brow_right = TEST_BROW_RIGHT,
    },
};

static const face_sprite_viseme_map_t TEST_VISEMES[] = {
    { FACE_VISEME_SET_OVR15, FACE_VISEME_AA, 2,
      FACE_SPRITE_MOUTH_WIDE },
    { FACE_VISEME_SET_OVR15, FACE_VISEME_E, 1,
      FACE_SPRITE_MOUTH_HALF },
    { FACE_VISEME_SET_OVR15, FACE_VISEME_PP, 0,
      FACE_SPRITE_MOUTH_PRESS },
    /* The highest Microsoft22 id proves this is not a 15-viseme ABI. */
    { FACE_VISEME_SET_MICROSOFT22, 21, 21,
      FACE_SPRITE_MOUTH_SLOT_NONE },
    { FACE_VISEME_SET_CUSTOM, 42, 22,
      FACE_SPRITE_MOUTH_SLOT_NONE },
};

static const face_sprite_cycle_t TEST_CYCLES[] = {
    { 11, 2, 0, 100 },
};

static const face_sprite_atlas_t TEST_ATLAS = {
    .magic = FACE_SPRITE_MAGIC,
    .version = FACE_SPRITE_VERSION,
    .native_width = 8,
    .native_height = 6,
    .scale = 8,
    .transparent_index = 255,
    .palette_count =
        (uint16_t)(sizeof(TEST_PALETTE) / sizeof(TEST_PALETTE[0])),
    .cell_count = TEST_CELL_COUNT,
    .mouth_slot_count = TEST_MOUTH_SLOT_COUNT,
    .viseme_map_count =
        (uint16_t)(sizeof(TEST_VISEMES) / sizeof(TEST_VISEMES[0])),
    .bank_count =
        (uint8_t)(sizeof(TEST_BANKS) / sizeof(TEST_BANKS[0])),
    .sequence_count = 0,
    .cycle_count = 1,
    .flags = 0,
    .background = 0x0000,
    .selector = FACE_SPRITE_SELECTOR_DEFAULTS,
    .timing = FACE_SPRITE_TIMING_DEFAULTS,
    .fallback_slots = {
        0, 0, 1, 1, 2, 1, 0, 1, 3,
    },
    .palette = TEST_PALETTE,
    .cells = TEST_CELLS,
    .blob = TEST_BLOB,
    .blob_size = sizeof(TEST_BLOB),
    .banks = TEST_BANKS,
    .viseme_map = TEST_VISEMES,
    .sequences = NULL,
    .cycles = TEST_CYCLES,
    .name = "production-test-atlas",
};

typedef struct {
    uint32_t before[4];
    uint16_t pixels[FACE_RENDER_PIXEL_COUNT];
    uint32_t after[4];
} guarded_frame_t;

static void prepare_guard(guarded_frame_t *frame)
{
    memset(frame, 0xa5, sizeof(*frame));
    for (uint32_t index = 0; index < 4U; ++index) {
        frame->before[index] = 0x51a70000U + index;
        frame->after[index] = 0xba110000U + index;
    }
}

static void assert_guard(const guarded_frame_t *frame)
{
    for (uint32_t index = 0; index < 4U; ++index) {
        assert(frame->before[index] == 0x51a70000U + index);
        assert(frame->after[index] == 0xba110000U + index);
    }
}

static uint32_t frame_hash(const uint16_t *pixels)
{
    uint32_t hash = 2166136261U;
    for (size_t index = 0;
         index < FACE_RENDER_PIXEL_COUNT;
         ++index) {
        hash ^= pixels[index];
        hash *= 16777619U;
    }
    return hash;
}

static face_render_key_t neutral_key(void)
{
    face_render_key_t key;
    memset(&key, 0, sizeof(key));
    key.controls.eye_left_open = 255;
    key.controls.eye_right_open = 255;
    key.viseme = FACE_VISEME_NONE;
    key.viseme_secondary = FACE_VISEME_NONE;
    key.schema_version = FACE_RENDER_KEY_SCHEMA_VERSION;
    return key;
}

static void test_validation(void)
{
    face_sprite_player_t player;
    assert(face_sprite_player_init(&player, &TEST_ATLAS));
    assert(!face_sprite_player_init(NULL, &TEST_ATLAS));
    assert(!face_sprite_player_init(&player, NULL));

    face_sprite_atlas_t broken = TEST_ATLAS;
    broken.magic = 0U;
    assert(!face_sprite_player_init(&player, &broken));

    broken = TEST_ATLAS;
    broken.version++;
    assert(!face_sprite_player_init(&player, &broken));

    broken = TEST_ATLAS;
    broken.blob_size--;
    assert(!face_sprite_player_init(&player, &broken));

    broken = TEST_ATLAS;
    broken.mouth_slot_count = 3;
    assert(!face_sprite_player_init(&player, &broken));

    face_sprite_viseme_map_t duplicate[2] = {
        TEST_VISEMES[0], TEST_VISEMES[0],
    };
    broken = TEST_ATLAS;
    broken.viseme_map = duplicate;
    broken.viseme_map_count = 2;
    assert(!face_sprite_player_init(&player, &broken));

    face_sprite_cell_t bad_cells[TEST_CELL_COUNT];
    memcpy(bad_cells, TEST_CELLS, sizeof(bad_cells));
    bad_cells[TEST_CELL_BASE_JOY].data_length = 3;
    broken = TEST_ATLAS;
    broken.cells = bad_cells;
    assert(!face_sprite_player_init(&player, &broken));

    face_sprite_bank_t clipped_banks[
        sizeof(TEST_BANKS) / sizeof(TEST_BANKS[0])];
    memcpy(clipped_banks, TEST_BANKS, sizeof(clipped_banks));
    clipped_banks[0].mouth.x = -4;
    broken = TEST_ATLAS;
    broken.banks = clipped_banks;
    assert(!face_sprite_player_init(&player, &broken));
    broken.flags |= FACE_SPRITE_ATLAS_ALLOW_CLIPPING;
    assert(face_sprite_player_init(&player, &broken));
}

static void test_vocabularies_and_fallback(void)
{
    face_render_key_t key = neutral_key();
    uint8_t role = FACE_SPRITE_MOUTH_SLOT_NONE;

    key.controls.mouth_open = 240;
    key.controls.mouth_width = 220;
    assert(face_sprite_select_mouth_slot(
               &TEST_ATLAS, &key, &role) == 2);
    assert(role == FACE_SPRITE_MOUTH_WIDE);

    key.viseme_set = FACE_VISEME_SET_MICROSOFT22;
    key.viseme = 21;
    key.viseme_weight = 255;
    assert(face_sprite_select_mouth_slot(
               &TEST_ATLAS, &key, &role) == 21);
    assert(role == FACE_SPRITE_MOUTH_SLOT_NONE);

    key.viseme_set = FACE_VISEME_SET_CUSTOM;
    key.viseme = 42;
    assert(face_sprite_select_mouth_slot(
               &TEST_ATLAS, &key, &role) == 22);

    key.viseme_set = FACE_VISEME_SET_OVR15;
    key.viseme = FACE_VISEME_AA;
    key.viseme_secondary = FACE_VISEME_E;
    key.viseme_blend = 200;
    assert(face_sprite_select_mouth_slot(
               &TEST_ATLAS, &key, &role) == 1);
    assert(role == FACE_SPRITE_MOUTH_HALF);
}

static void test_render_guards_and_rich_actions(void)
{
    guarded_frame_t neutral;
    guarded_frame_t joyful;
    face_render_key_t key = neutral_key();
    face_sprite_player_t player;

    prepare_guard(&neutral);
    assert(face_sprite_player_init(&player, &TEST_ATLAS));
    assert(face_sprite_render(
        &player, &key, 0, neutral.pixels,
        FACE_RENDER_PIXEL_COUNT));
    assert_guard(&neutral);
    const uint32_t neutral_hash = frame_hash(neutral.pixels);

    /* Rich evaluated actions select the joy art without consulting either
     * controls.expression or the final reserved/stage byte. */
    key.affect_valence = 94;
    key.affect_arousal = 184;
    key.mouth_corner_left = 78;
    key.mouth_corner_right = 78;
    key.brow_inner = 22;
    key.eye_left_squint = 68;
    key.eye_right_squint = 68;
    key.expression_weight = 255;
    key.controls.expression = 255;
    key.stage_expression = 0;
    prepare_guard(&joyful);
    assert(face_sprite_player_init(&player, &TEST_ATLAS));
    assert(face_sprite_render(
        &player, &key, 0, joyful.pixels,
        FACE_RENDER_PIXEL_COUNT));
    assert_guard(&joyful);
    assert(frame_hash(joyful.pixels) != neutral_hash);

    /* A future stage-expression byte may occupy reserved; the renderer does
     * not read it. */
    guarded_frame_t other_reserved;
    key.stage_expression = 231;
    prepare_guard(&other_reserved);
    assert(face_sprite_player_init(&player, &TEST_ATLAS));
    assert(face_sprite_render(
        &player, &key, 0, other_reserved.pixels,
        FACE_RENDER_PIXEL_COUNT));
    assert(frame_hash(other_reserved.pixels) ==
           frame_hash(joyful.pixels));

    assert(face_sprite_player_init(&player, &TEST_ATLAS));
    assert(!face_sprite_render(
        &player, &key, 0, neutral.pixels,
        FACE_RENDER_PIXEL_COUNT - 1U));
    assert(!face_sprite_render(
        &player, NULL, 0, neutral.pixels,
        FACE_RENDER_PIXEL_COUNT));
}

static void test_debounce_and_clock_reset(void)
{
    face_sprite_player_t player;
    face_render_key_t key = neutral_key();
    uint16_t pixels[FACE_RENDER_PIXEL_COUNT];
    key.viseme_set = FACE_VISEME_SET_OVR15;
    key.viseme = FACE_VISEME_AA;
    key.viseme_weight = 255;
    key.controls.flags = FACE_KEYFRAME_FLAG_SPEAKING;

    assert(face_sprite_player_init(&player, &TEST_ATLAS));
    assert(face_sprite_render(
        &player, &key, 0, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(player.current_slot == 0);
    assert(face_sprite_render(
        &player, &key, 1119, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(player.current_slot == 0);
    assert(face_sprite_render(
        &player, &key, 1120, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(player.current_slot == 1); /* wide via half */
    assert(face_sprite_render(
        &player, &key, 2240, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(player.current_slot == 2);

    key.viseme = FACE_VISEME_NONE;
    key.viseme_weight = 0;
    key.controls.mouth_open = 0;
    key.controls.flags = 0;
    assert(face_sprite_render(
        &player, &key, 2300, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(face_sprite_render(
        &player, &key, 3420, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(player.current_slot == 2); /* close delay still active */
    assert(face_sprite_render(
        &player, &key, 4220, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(player.current_slot == 1); /* wide closes through half */
    assert(face_sprite_render(
        &player, &key, 5340, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(player.current_slot == 0);

    /* Rewinding a deterministic capture resets all mouth state. */
    assert(face_sprite_render(
        &player, &key, 0, pixels, FACE_RENDER_PIXEL_COUNT));
    assert(player.current_slot == 0);
}

static void test_determinism_and_palette_cycle(void)
{
    face_render_key_t keys[8];
    for (uint32_t index = 0; index < 8U; ++index) {
        keys[index] = neutral_key();
        keys[index].controls.mouth_open =
            (uint8_t)(index * 31U);
        keys[index].controls.mouth_width =
            (uint8_t)(255U - index * 19U);
        keys[index].controls.look_x =
            (int8_t)((int32_t)index * 18 - 63);
        keys[index].brow_inner =
            (int8_t)((int32_t)index * 11 - 33);
    }

    face_sprite_player_t first;
    face_sprite_player_t second;
    uint16_t first_pixels[FACE_RENDER_PIXEL_COUNT];
    uint16_t second_pixels[FACE_RENDER_PIXEL_COUNT];
    assert(face_sprite_player_init(&first, &TEST_ATLAS));
    assert(face_sprite_player_init(&second, &TEST_ATLAS));
    for (uint32_t index = 0; index < 8U; ++index) {
        const uint32_t clock = index * 533U;
        assert(face_sprite_render(
            &first, &keys[index], clock, first_pixels,
            FACE_RENDER_PIXEL_COUNT));
        assert(face_sprite_render(
            &second, &keys[index], clock, second_pixels,
            FACE_RENDER_PIXEL_COUNT));
        assert(memcmp(
            first_pixels, second_pixels,
            sizeof(first_pixels)) == 0);
    }

    /* The overlay at native (0,0) is palette-cycled without frame storage. */
    face_render_key_t key = neutral_key();
    assert(face_sprite_player_init(&first, &TEST_ATLAS));
    assert(face_sprite_render(
        &first, &key, 0, first_pixels,
        FACE_RENDER_PIXEL_COUNT));
    assert(face_sprite_player_init(&second, &TEST_ATLAS));
    assert(face_sprite_render(
        &second, &key, 100, second_pixels,
        FACE_RENDER_PIXEL_COUNT));
    const size_t overlay_pixel = 36U * FACE_RENDER_WIDTH + 48U;
    assert(first_pixels[overlay_pixel] == COLOR_CYCLE_A);
    assert(second_pixels[overlay_pixel] == COLOR_CYCLE_B);
}

static void test_pure_snapshot_path(void)
{
    face_sprite_player_t validated;
    face_render_key_t wide = neutral_key();
    face_render_key_t pressed = neutral_key();
    uint16_t first[FACE_RENDER_PIXEL_COUNT];
    uint16_t interleaved[FACE_RENDER_PIXEL_COUNT];
    uint16_t replay[FACE_RENDER_PIXEL_COUNT];

    wide.viseme_set = FACE_VISEME_SET_OVR15;
    wide.viseme = FACE_VISEME_AA;
    wide.viseme_weight = 255;
    pressed.viseme_set = FACE_VISEME_SET_OVR15;
    pressed.viseme = FACE_VISEME_PP;
    pressed.viseme_weight = 255;

    assert(face_sprite_player_init(&validated, &TEST_ATLAS));
    assert(face_sprite_render_snapshot(
        &validated, &wide, 16000, first,
        FACE_RENDER_PIXEL_COUNT));
    assert(validated.current_slot == 0);
    assert(face_sprite_render_snapshot(
        &validated, &pressed, 23000, interleaved,
        FACE_RENDER_PIXEL_COUNT));
    assert(frame_hash(first) != frame_hash(interleaved));
    assert(face_sprite_render_snapshot(
        &validated, &wide, 16000, replay,
        FACE_RENDER_PIXEL_COUNT));
    assert(memcmp(first, replay, sizeof(first)) == 0);
    assert(validated.current_slot == 0);
}

static void test_arbitrary_surface(void)
{
    enum {
        WIDTH = 96,
        HEIGHT = 70,
        STRIDE = 100,
        PIXELS = STRIDE * HEIGHT,
    };
    uint16_t pixels[PIXELS];
    for (size_t index = 0U; index < PIXELS; ++index) {
        pixels[index] = 0xa55aU;
    }
    face_sprite_surface_t surface = {
        .pixels = pixels,
        .pixel_capacity = PIXELS,
        .width = WIDTH,
        .height = HEIGHT,
        .stride = STRIDE,
    };
    face_sprite_player_t player;
    face_render_key_t key = neutral_key();
    assert(face_sprite_player_init(&player, &TEST_ATLAS));
    assert(face_sprite_render_to(&player, &key, 0U, &surface));

    /* The 64x48 scaled atlas is centred in the 96x70 surface. */
    assert(pixels[11U * STRIDE + 16U] == COLOR_CYCLE_A);
    assert(pixels[0] == TEST_ATLAS.background);
    assert(pixels[(HEIGHT - 1U) * STRIDE + WIDTH - 1U] ==
           TEST_ATLAS.background);
    for (uint16_t y = 0U; y < HEIGHT; ++y) {
        for (uint16_t x = WIDTH; x < STRIDE; ++x) {
            assert(pixels[(size_t)y * STRIDE + x] == 0xa55aU);
        }
    }

    surface.width = 63U;
    assert(!face_sprite_render_to(&player, &key, 0U, &surface));
    surface.width = WIDTH;
    surface.pixel_capacity = PIXELS - STRIDE;
    assert(!face_sprite_render_to(&player, &key, 0U, &surface));
}

/*
 * Render the same key at the same clocks through two validated players and
 * count the clocks whose frames differ. The stride is twice the palette-cycle
 * period, so the cycled overlay pixel is identical inside every compared pair
 * and any divergence belongs to the players' atlas flags alone. One default
 * blink window (64000 samples) also spans three default gaze windows.
 */
static uint32_t count_flag_divergence(
    const face_sprite_player_t *flagged,
    const face_sprite_player_t *plain)
{
    face_render_key_t key = neutral_key();
    static uint16_t flagged_pixels[FACE_RENDER_PIXEL_COUNT];
    static uint16_t plain_pixels[FACE_RENDER_PIXEL_COUNT];
    uint32_t differing = 0U;
    for (uint32_t clock = 0U; clock < 64000U; clock += 200U) {
        assert(face_sprite_render_snapshot(
            flagged, &key, clock, flagged_pixels,
            FACE_RENDER_PIXEL_COUNT));
        assert(face_sprite_render_snapshot(
            plain, &key, clock, plain_pixels,
            FACE_RENDER_PIXEL_COUNT));
        if (memcmp(flagged_pixels, plain_pixels,
                   sizeof(uint16_t) * FACE_RENDER_PIXEL_COUNT) != 0) {
            ++differing;
        }
    }
    return differing;
}

/*
 * The idle-motion engines are gated on atlas flags, but a flag is not motion:
 * automatic_blink draws only through a bank's lid cells and compute_saccade
 * only through its pupil cell. Both directions are proven here. With authored
 * lid/pupil layers (this synthetic atlas has them), enabling a flag changes
 * rendered pixels somewhere inside one blink/gaze window. With the layers
 * emptied to the exact shape today's pipeline-published atlases have — eyes
 * baked into each bank's base cell, lid cell_count zero, pupils CELL_NONE —
 * the same flags change nothing. That inertness is why the sprite pipeline
 * only emits AUTO_BLINK for characters that authored a blink rig, and never
 * emits IDLE_SACCADES; the doze face's shut eyes come from the sleepy
 * expression bank, not from this blink machinery.
 */
static void test_idle_motion_needs_layers_not_just_flags(void)
{
    face_sprite_player_t plain;
    face_sprite_player_t blinking;
    face_sprite_player_t glancing;
    assert(face_sprite_player_init(&plain, &TEST_ATLAS));

    face_sprite_atlas_t blink_atlas = TEST_ATLAS;
    blink_atlas.flags = FACE_SPRITE_ATLAS_AUTO_BLINK;
    assert(face_sprite_player_init(&blinking, &blink_atlas));
    /* Authored lid cells make the automatic blink visible motion. */
    assert(count_flag_divergence(&blinking, &plain) > 0U);

    face_sprite_atlas_t saccade_atlas = TEST_ATLAS;
    saccade_atlas.flags = FACE_SPRITE_ATLAS_IDLE_SACCADES;
    assert(face_sprite_player_init(&glancing, &saccade_atlas));
    /* Authored pupil cells make idle saccades visible motion. */
    assert(count_flag_divergence(&glancing, &plain) > 0U);

    face_sprite_bank_t baked_banks[
        sizeof(TEST_BANKS) / sizeof(TEST_BANKS[0])];
    memcpy(baked_banks, TEST_BANKS, sizeof(baked_banks));
    for (size_t bank = 0U;
         bank < sizeof(baked_banks) / sizeof(baked_banks[0]);
         ++bank) {
        baked_banks[bank].eye_left.cell_count = 0U;
        baked_banks[bank].eye_right.cell_count = 0U;
        baked_banks[bank].pupil_left.cell = FACE_SPRITE_CELL_NONE;
        baked_banks[bank].pupil_right.cell = FACE_SPRITE_CELL_NONE;
    }
    face_sprite_atlas_t baked_plain = TEST_ATLAS;
    baked_plain.banks = baked_banks;
    face_sprite_atlas_t baked_flagged = baked_plain;
    baked_flagged.flags = FACE_SPRITE_ATLAS_AUTO_BLINK |
        FACE_SPRITE_ATLAS_IDLE_SACCADES;
    face_sprite_player_t baked_plain_player;
    face_sprite_player_t baked_flagged_player;
    assert(face_sprite_player_init(&baked_plain_player, &baked_plain));
    assert(face_sprite_player_init(
        &baked_flagged_player, &baked_flagged));
    /* Baked-in eyes: both engines run, neither can draw anything. */
    assert(count_flag_divergence(
        &baked_flagged_player, &baked_plain_player) == 0U);
}

int main(void)
{
    assert(sizeof(face_render_key_t) == FACE_RENDER_KEY_BYTES);
    assert(FACE_RENDER_KEY_BYTES == 40);
    assert(TEST_MOUTH_SLOT_COUNT > FACE_VISEME_COUNT);

    test_validation();
    test_vocabularies_and_fallback();
    test_render_guards_and_rich_actions();
    test_debounce_and_clock_reset();
    test_determinism_and_palette_cycle();
    test_pure_snapshot_path();
    test_arbitrary_surface();
    test_idle_motion_needs_layers_not_just_flags();

    printf(
        "face_sprite_sheet_test: PASS "
        "(40-byte IR, %u mouth slots, 5 viseme mappings)\n",
        TEST_MOUTH_SLOT_COUNT);
    return 0;
}
