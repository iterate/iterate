#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_render.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Flash-resident, data-driven sprite faces.
 *
 * The engine composites a base portrait and small replaceable patches in
 * painter order:
 *
 *   base -> brows -> eyes -> pupils -> mouth -> overlay
 *
 * This is the classic adventure-game talking-portrait arrangement: only the
 * changing face parts need separate cells. Atlas pixels are palette indices;
 * cells may be raw or PackBits encoded. Rendering writes RGB565 directly into
 * the same 160x120 framebuffer used by the procedural renderers.
 *
 * Atlas data and playback state are caller-owned. The implementation performs
 * no allocation, retains no PCM, and uses integer arithmetic only. The same
 * player renders into any caller-owned RGB565 surface; the legacy 160x120
 * entry points below are only convenience wrappers for CoreS3/WASM callers.
 */
enum {
    FACE_SPRITE_MAGIC = 0x46535052U, /* "FSPR" */
    FACE_SPRITE_VERSION = 2,
    FACE_SPRITE_CELL_NONE = 0xffffU,
    FACE_SPRITE_MOUTH_SLOT_NONE = 0xffU,
    FACE_SPRITE_MAX_LID_CELLS = 6,
    FACE_SPRITE_MAX_BROW_CELLS = 5,
    FACE_SPRITE_MAX_CYCLES = 4,
    FACE_SPRITE_MAX_CELL_WIDTH = 256,
    FACE_SPRITE_MAX_CELL_HEIGHT = 256,
};

typedef enum {
    FACE_SPRITE_ENCODING_RAW = 0,
    FACE_SPRITE_ENCODING_PACKBITS = 1,
} face_sprite_encoding_t;

/*
 * Cheap fallback mouth vocabulary. An atlas can expose any number of mouth
 * slots and map OVR15, VRM5, Preston9, Microsoft22, or custom visemes to
 * them. These nine roles are used only when an explicit mapping is absent.
 */
typedef enum {
    FACE_SPRITE_MOUTH_REST = 0,
    FACE_SPRITE_MOUTH_PRESS,
    FACE_SPRITE_MOUTH_TEETH,
    FACE_SPRITE_MOUTH_HALF,
    FACE_SPRITE_MOUTH_WIDE,
    FACE_SPRITE_MOUTH_ROUND,
    FACE_SPRITE_MOUTH_PUCKER,
    FACE_SPRITE_MOUTH_LIP_BITE,
    FACE_SPRITE_MOUTH_TONGUE,
    FACE_SPRITE_MOUTH_ROLE_COUNT,
} face_sprite_mouth_role_t;

enum {
    FACE_SPRITE_SLOT_FLIP_X = 1U << 0,
    FACE_SPRITE_SEQUENCE_WHILE_SPEAKING = 1U << 0,
    FACE_SPRITE_ATLAS_BREATHE = 1U << 0,
    FACE_SPRITE_ATLAS_IDLE_SACCADES = 1U << 1,
    FACE_SPRITE_ATLAS_AUTO_BLINK = 1U << 2,
    /* Disable safe-canvas placement checks for intentional overscan art. */
    FACE_SPRITE_ATLAS_ALLOW_CLIPPING = 1U << 3,
};

/*
 * One trimmed rectangle of palette indices. offset_x/y place the trimmed
 * pixels back inside their logical cell, so build-time trimming does not move
 * anchors. data_offset and data_length address the atlas's shared byte blob.
 */
typedef struct {
    uint16_t width;
    uint16_t height;
    int16_t offset_x;
    int16_t offset_y;
    uint32_t data_offset;
    uint32_t data_length;
    uint8_t encoding;
    uint8_t reserved[3];
} face_sprite_cell_t;

/*
 * A mouth bank contains one cell reference per atlas mouth slot. Different
 * expression banks may use different artwork for the same semantic slot.
 */
typedef struct {
    int16_t x;
    int16_t y;
    const uint16_t *cells;
} face_sprite_mouth_layer_t;

/* Lid cells are ordered fully open to fully closed. */
typedef struct {
    int16_t x;
    int16_t y;
    uint16_t cell_count;
    uint16_t cells[FACE_SPRITE_MAX_LID_CELLS];
    uint8_t flags;
    uint8_t reserved;
} face_sprite_eye_layer_t;

/*
 * A pupil cell is placed at x/y plus gaze, then clamped to the supplied
 * anchor bounds. range_x/y scale the signed -127..127 IR gaze controls.
 */
typedef struct {
    int16_t x;
    int16_t y;
    int16_t min_x;
    int16_t min_y;
    int16_t max_x;
    int16_t max_y;
    uint16_t cell;
    uint8_t range_x;
    uint8_t range_y;
} face_sprite_pupil_layer_t;

/* Brow cells are ordered low/angry to high/raised. */
typedef struct {
    int16_t x;
    int16_t y;
    uint16_t cell_count;
    uint16_t cells[FACE_SPRITE_MAX_BROW_CELLS];
    uint8_t max_lift;
    uint8_t flags;
} face_sprite_brow_layer_t;

/*
 * Expression-bank target in renderer-neutral action space. A bank is chosen
 * by proximity to the already evaluated facial actions, rather than by a
 * stage-direction enum. That keeps sprite assets compatible with local audio,
 * authored animation, and future AI stage-direction producers.
 */
typedef struct {
    int8_t valence;
    uint8_t arousal;
    int8_t mouth_corner;
    int8_t brow_inner;
    uint8_t eye_squint;
    uint8_t reserved[3];
} face_sprite_expression_target_t;

/* Bank zero is the neutral fallback. */
typedef struct {
    face_sprite_expression_target_t target;
    uint16_t base_cell;
    uint16_t overlay_cell;
    int16_t overlay_x;
    int16_t overlay_y;
    face_sprite_mouth_layer_t mouth;
    face_sprite_eye_layer_t eye_left;
    face_sprite_eye_layer_t eye_right;
    face_sprite_pupil_layer_t pupil_left;
    face_sprite_pupil_layer_t pupil_right;
    face_sprite_brow_layer_t brow_left;
    face_sprite_brow_layer_t brow_right;
} face_sprite_bank_t;

/*
 * Map any wire vocabulary/id pair to an atlas mouth slot. `role` supplies a
 * cheap transition intermediate; use FACE_SPRITE_MOUTH_SLOT_NONE when a
 * custom shape has no useful canonical role.
 */
typedef struct {
    uint8_t viseme_set;
    uint8_t viseme;
    uint8_t mouth_slot;
    uint8_t role;
} face_sprite_viseme_map_t;

typedef struct {
    uint16_t cell;
    uint16_t duration_samples;
    int16_t x;
    int16_t y;
} face_sprite_sequence_frame_t;

typedef struct {
    const face_sprite_sequence_frame_t *frames;
    uint16_t frame_count;
    uint8_t flags;
    uint8_t reserved;
} face_sprite_sequence_t;

/* Palette range [first, first + count) rotates every period_samples. */
typedef struct {
    uint8_t first;
    uint8_t count;
    uint16_t reserved;
    uint32_t period_samples;
} face_sprite_cycle_t;

/*
 * Thresholds for the continuous-control fallback. expression_bank_min avoids
 * popping to a discrete emotion bank at the start/end of a softly blended
 * stage cue. explicit_viseme_min ignores low-confidence recognizer output.
 */
typedef struct {
    uint8_t open_min;
    uint8_t press_min;
    uint8_t teeth_min;
    uint8_t teeth_open;
    uint8_t teeth_round;
    uint8_t round_min;
    uint8_t round_open;
    uint8_t wide_min;
    uint8_t wide_open;
    uint8_t open_wide;
    uint8_t explicit_viseme_min;
    uint8_t expression_bank_min;
} face_sprite_selector_t;

/* All durations use the shared 16 kHz sample clock. */
typedef struct {
    uint16_t mouth_min_hold;
    uint16_t mouth_close_delay;
    uint16_t blink_close;
    uint16_t blink_hold;
    uint16_t blink_open;
    uint16_t saccade_move;
    uint32_t blink_window;
    uint32_t gaze_window;
    uint32_t idle_window;
    uint32_t breathe_period;
} face_sprite_timing_t;

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t native_width;
    uint16_t native_height;
    uint8_t scale;
    uint8_t transparent_index;
    uint16_t palette_count;
    uint16_t cell_count;
    uint16_t mouth_slot_count;
    uint16_t viseme_map_count;
    uint8_t bank_count;
    uint8_t sequence_count;
    uint8_t cycle_count;
    uint8_t flags;
    uint16_t background;
    uint16_t reserved;
    face_sprite_selector_t selector;
    face_sprite_timing_t timing;
    uint8_t fallback_slots[FACE_SPRITE_MOUTH_ROLE_COUNT];
    uint8_t reserved_slots[3];
    const uint16_t *palette;
    const face_sprite_cell_t *cells;
    const uint8_t *blob;
    uint32_t blob_size;
    const face_sprite_bank_t *banks;
    const face_sprite_viseme_map_t *viseme_map;
    const face_sprite_sequence_t *sequences;
    const face_sprite_cycle_t *cycles;
    const char *name;
} face_sprite_atlas_t;

#define FACE_SPRITE_SELECTOR_DEFAULTS \
    { 20, 128, 160, 96, 140, 150, 128, 170, 120, 170, 32, 96 }

#define FACE_SPRITE_TIMING_DEFAULTS \
    { 1120, 1920, 1280, 640, 1920, 1067, 64000, 20800, 96000, 67200 }

typedef struct {
    const face_sprite_atlas_t *atlas;
    uint32_t last_clock;
    uint32_t mouth_since;
    uint32_t target_since;
    uint32_t forced_blink_edge;
    uint8_t current_slot;
    uint8_t target_slot;
    uint8_t current_role;
    uint8_t target_role;
    uint8_t previous_flags;
    uint8_t forced_blink;
    uint16_t reserved;
} face_sprite_player_t;

/*
 * A target-owned RGB565 surface. `stride` is measured in pixels and may be
 * larger than `width`; padding is left untouched. No display API leaks into
 * the portable renderer.
 */
typedef struct {
    uint16_t *pixels;
    size_t pixel_capacity;
    uint16_t width;
    uint16_t height;
    uint16_t stride;
} face_sprite_surface_t;

/*
 * Validate every descriptor, cell reference, palette index, and compressed
 * stream before making the atlas renderable.
 */
bool face_sprite_player_init(
    face_sprite_player_t *player,
    const face_sprite_atlas_t *atlas);

/*
 * Render one complete FACE_RENDER_WIDTH x FACE_RENDER_HEIGHT RGB565 frame.
 * A backwards clock jump resets playback state, making deterministic capture
 * replay straightforward.
 */
bool face_sprite_render(
    face_sprite_player_t *player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity);

/*
 * Target-independent rendering path used directly by embedded board ports.
 * The atlas is centred in the supplied surface and must fit after scaling.
 */
bool face_sprite_render_to(
    face_sprite_player_t *player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    const face_sprite_surface_t *surface);

/*
 * Pure comparison-grid path. `validated_player` must have been initialised
 * once with face_sprite_player_init; it is not mutated. The immediate target
 * mouth is drawn without temporal debounce, while clock-derived idle motion
 * remains deterministic. This lets the existing pure face_render_frame ABI
 * display one atlas in many interleaved matrix scenarios without sharing
 * playback history. Firmware should normally retain a player and use
 * face_sprite_render for smoother coarticulation.
 */
bool face_sprite_render_snapshot(
    const face_sprite_player_t *validated_player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity);

bool face_sprite_render_snapshot_to(
    const face_sprite_player_t *validated_player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    const face_sprite_surface_t *surface);

/*
 * Resolve the immediate target mouth slot without debounce. Useful to
 * converter tests and tuning UIs. Returns FACE_SPRITE_MOUTH_SLOT_NONE if the
 * atlas has no valid mouth slot.
 */
uint8_t face_sprite_select_mouth_slot(
    const face_sprite_atlas_t *atlas,
    const face_render_key_t *render_key,
    uint8_t *role);

#ifdef __cplusplus
}
#endif
