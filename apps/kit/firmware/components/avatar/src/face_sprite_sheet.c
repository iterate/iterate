#include "iterate/kit/avatar/face_sprite_sheet.h"

#include <string.h>

typedef struct {
    const uint8_t *data;
    uint32_t remaining;
    uint32_t run_remaining;
    uint32_t literal_remaining;
    uint8_t run_value;
    uint8_t encoding;
} face_sprite_stream_t;

typedef struct {
    uint16_t *pixels;
    uint16_t width;
    uint16_t height;
    uint16_t stride;
    const face_sprite_atlas_t *atlas;
    uint32_t sample_clock;
    int32_t origin_x;
    int32_t origin_y;
} face_sprite_blit_t;

typedef struct {
    int16_t saccade_x;
    int16_t saccade_y;
    int16_t bob;
    uint8_t blink;
} face_sprite_motion_t;

static int32_t clamp_i32(int32_t value, int32_t low, int32_t high)
{
    if (value < low) {
        return low;
    }
    return value > high ? high : value;
}

static uint8_t clamp_u8_i32(int32_t value)
{
    return (uint8_t)clamp_i32(value, 0, 255);
}

static uint8_t max_u8(uint8_t left, uint8_t right)
{
    return left > right ? left : right;
}

static uint8_t multiply_u8(uint8_t left, uint8_t right)
{
    return (uint8_t)(((uint16_t)left * right + 127U) / 255U);
}

static uint32_t hash_u32(uint32_t value)
{
    value ^= value >> 16U;
    value *= 0x7feb352dU;
    value ^= value >> 15U;
    value *= 0x846ca68bU;
    value ^= value >> 16U;
    return value;
}

/* ------------------------------------------------------------------------- */
/* Cell stream                                                               */

static void stream_open(
    face_sprite_stream_t *stream,
    const face_sprite_atlas_t *atlas,
    const face_sprite_cell_t *cell)
{
    stream->data = atlas->blob + cell->data_offset;
    stream->remaining = cell->data_length;
    stream->run_remaining = 0U;
    stream->literal_remaining = 0U;
    stream->run_value = 0U;
    stream->encoding = cell->encoding;
}

static bool stream_next(
    face_sprite_stream_t *stream,
    uint8_t *value)
{
    if (stream->encoding == FACE_SPRITE_ENCODING_RAW) {
        if (stream->remaining == 0U) {
            return false;
        }
        *value = *stream->data++;
        --stream->remaining;
        return true;
    }
    if (stream->encoding != FACE_SPRITE_ENCODING_PACKBITS) {
        return false;
    }
    for (;;) {
        if (stream->run_remaining > 0U) {
            *value = stream->run_value;
            --stream->run_remaining;
            return true;
        }
        if (stream->literal_remaining > 0U) {
            if (stream->remaining == 0U) {
                return false;
            }
            *value = *stream->data++;
            --stream->remaining;
            --stream->literal_remaining;
            return true;
        }
        if (stream->remaining == 0U) {
            return false;
        }
        const uint8_t control = *stream->data++;
        --stream->remaining;
        if (control < 128U) {
            stream->literal_remaining = (uint32_t)control + 1U;
        } else if (control > 128U) {
            if (stream->remaining == 0U) {
                return false;
            }
            stream->run_remaining = 257U - (uint32_t)control;
            stream->run_value = *stream->data++;
            --stream->remaining;
        }
        /* 128 is the PackBits no-op; consume another control byte. */
    }
}

static bool stream_finished(const face_sprite_stream_t *stream)
{
    return stream->remaining == 0U &&
        stream->run_remaining == 0U &&
        stream->literal_remaining == 0U;
}

/* ------------------------------------------------------------------------- */
/* Palette and blitting                                                      */

static uint16_t palette_color(
    const face_sprite_atlas_t *atlas,
    uint8_t palette_index,
    uint32_t sample_clock)
{
    uint8_t effective = palette_index;
    for (uint8_t index = 0U; index < atlas->cycle_count; ++index) {
        const face_sprite_cycle_t *cycle = &atlas->cycles[index];
        const uint16_t end = (uint16_t)cycle->first + cycle->count;
        if (effective >= cycle->first && effective < end) {
            const uint32_t shift =
                (sample_clock / cycle->period_samples) % cycle->count;
            effective = (uint8_t)(
                cycle->first +
                ((effective - cycle->first + shift) % cycle->count));
            break;
        }
    }
    return atlas->palette[effective];
}

static void emit_scaled_pixel(
    const face_sprite_blit_t *blit,
    int32_t native_x,
    int32_t native_y,
    uint8_t palette_index)
{
    const int32_t scale = blit->atlas->scale;
    const int32_t x0 = blit->origin_x + native_x * scale;
    const int32_t y0 = blit->origin_y + native_y * scale;
    if (x0 >= blit->width || y0 >= blit->height ||
        x0 + scale <= 0 || y0 + scale <= 0) {
        return;
    }
    const uint16_t color = palette_color(
        blit->atlas, palette_index, blit->sample_clock);
    for (int32_t dy = 0; dy < scale; ++dy) {
        const int32_t y = y0 + dy;
        if (y < 0 || y >= blit->height) {
            continue;
        }
        uint16_t *row = &blit->pixels[(size_t)y * blit->stride];
        for (int32_t dx = 0; dx < scale; ++dx) {
            const int32_t x = x0 + dx;
            if (x >= 0 && x < blit->width) {
                row[x] = color;
            }
        }
    }
}

static bool blit_cell(
    const face_sprite_blit_t *blit,
    uint16_t cell_index,
    int32_t anchor_x,
    int32_t anchor_y,
    bool flip_x)
{
    const face_sprite_atlas_t *atlas = blit->atlas;
    if (cell_index == FACE_SPRITE_CELL_NONE) {
        return true;
    }
    if (cell_index >= atlas->cell_count) {
        return false;
    }
    const face_sprite_cell_t *cell = &atlas->cells[cell_index];
    face_sprite_stream_t stream;
    stream_open(&stream, atlas, cell);
    const int32_t x0 = anchor_x + cell->offset_x;
    const int32_t y0 = anchor_y + cell->offset_y;
    uint8_t row[FACE_SPRITE_MAX_CELL_WIDTH];
    for (uint16_t y = 0U; y < cell->height; ++y) {
        for (uint16_t x = 0U; x < cell->width; ++x) {
            if (!stream_next(&stream, &row[x])) {
                return false;
            }
        }
        for (uint16_t x = 0U; x < cell->width; ++x) {
            const uint16_t source =
                flip_x ? (uint16_t)(cell->width - 1U - x) : x;
            const uint8_t palette_index = row[source];
            if (palette_index != atlas->transparent_index) {
                emit_scaled_pixel(
                    blit, x0 + x, y0 + y, palette_index);
            }
        }
    }
    return stream_finished(&stream);
}

/* ------------------------------------------------------------------------- */
/* Deterministic motion                                                      */

static uint8_t blink_envelope(
    const face_sprite_timing_t *timing,
    uint32_t position,
    uint32_t start)
{
    if (position < start) {
        return 0U;
    }
    uint32_t elapsed = position - start;
    if (timing->blink_close > 0U && elapsed < timing->blink_close) {
        return (uint8_t)(
            (elapsed * 255U) / timing->blink_close);
    }
    if (elapsed < timing->blink_close) {
        elapsed = timing->blink_close;
    }
    elapsed -= timing->blink_close;
    if (elapsed < timing->blink_hold) {
        return 255U;
    }
    elapsed -= timing->blink_hold;
    if (timing->blink_open > 0U && elapsed < timing->blink_open) {
        return (uint8_t)(
            255U - (elapsed * 255U) / timing->blink_open);
    }
    return 0U;
}

static uint8_t automatic_blink(
    const face_sprite_atlas_t *atlas,
    uint32_t sample_clock)
{
    const face_sprite_timing_t *timing = &atlas->timing;
    if ((atlas->flags & FACE_SPRITE_ATLAS_AUTO_BLINK) == 0U ||
        timing->blink_window == 0U) {
        return 0U;
    }
    const uint32_t total = (uint32_t)timing->blink_close +
        timing->blink_hold + timing->blink_open;
    if (total == 0U || total >= timing->blink_window) {
        return 0U;
    }
    const uint32_t epoch = sample_clock / timing->blink_window;
    const uint32_t position = sample_clock % timing->blink_window;
    const uint32_t noise =
        hash_u32(epoch * 2654435761U + 0x5eedU);
    const uint32_t start =
        noise % (timing->blink_window - total);
    uint8_t amount = blink_envelope(timing, position, start);

    /* A rare double blink prevents the idle loop reading as mechanical. */
    if (((noise >> 13U) & 7U) == 0U) {
        const uint32_t gap = 2400U;
        if (total <= UINT32_MAX - gap &&
            start <= UINT32_MAX - total - gap) {
            const uint32_t second = start + total + gap;
            if (second < timing->blink_window &&
                total < timing->blink_window - second) {
                amount = max_u8(
                    amount,
                    blink_envelope(timing, position, second));
            }
        }
    }
    return amount;
}

static uint8_t forced_blink(
    const face_sprite_player_t *player,
    uint32_t sample_clock)
{
    const face_sprite_timing_t *timing = &player->atlas->timing;
    const uint32_t elapsed = sample_clock - player->forced_blink_edge;
    if (player->forced_blink != 0U) {
        if (timing->blink_close == 0U ||
            elapsed >= timing->blink_close) {
            return 255U;
        }
        return (uint8_t)(
            (elapsed * 255U) / timing->blink_close);
    }
    if (timing->blink_open == 0U || elapsed >= timing->blink_open) {
        return 0U;
    }
    return (uint8_t)(
        255U - (elapsed * 255U) / timing->blink_open);
}

static void compute_saccade(
    const face_sprite_atlas_t *atlas,
    uint32_t sample_clock,
    face_sprite_motion_t *motion)
{
    motion->saccade_x = 0;
    motion->saccade_y = 0;
    const face_sprite_timing_t *timing = &atlas->timing;
    if ((atlas->flags & FACE_SPRITE_ATLAS_IDLE_SACCADES) == 0U ||
        timing->gaze_window == 0U) {
        return;
    }
    const uint32_t epoch = sample_clock / timing->gaze_window;
    const uint32_t position = sample_clock % timing->gaze_window;
    const uint32_t current = hash_u32(epoch + 0x51ed270bU);
    const uint32_t previous =
        hash_u32((epoch == 0U ? 0U : epoch - 1U) + 0x51ed270bU);
    const int32_t current_x =
        (int32_t)((current >> 3U) % 5U) - 2;
    const int32_t current_y =
        (int32_t)((current >> 11U) % 3U) - 1;
    const int32_t previous_x =
        (int32_t)((previous >> 3U) % 5U) - 2;
    const int32_t previous_y =
        (int32_t)((previous >> 11U) % 3U) - 1;
    int32_t amount = 255;
    if (timing->saccade_move > 0U &&
        position < timing->saccade_move) {
        amount = (int32_t)(
            (position * 255U) / timing->saccade_move);
    }
    motion->saccade_x = (int16_t)(
        previous_x + ((current_x - previous_x) * amount) / 255);
    motion->saccade_y = (int16_t)(
        previous_y + ((current_y - previous_y) * amount) / 255);
}

static int16_t breathing_bob(
    const face_sprite_atlas_t *atlas,
    uint32_t sample_clock)
{
    if ((atlas->flags & FACE_SPRITE_ATLAS_BREATHE) == 0U ||
        atlas->timing.breathe_period == 0U) {
        return 0;
    }
    const uint32_t period = atlas->timing.breathe_period;
    const uint32_t phase = sample_clock % period;
    const uint32_t half = period / 2U;
    if (half == 0U) {
        return 0;
    }
    const uint32_t triangle = phase < half
        ? phase
        : period - phase;
    /* One native pixel is enough at 2x/4x nearest-neighbour display scale. */
    return (int16_t)((triangle + half / 2U) / half);
}

static void compute_motion(
    face_sprite_player_t *player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    face_sprite_motion_t *motion)
{
    const uint8_t blinking =
        (render_key->controls.flags &
         FACE_KEYFRAME_FLAG_BLINKING) != 0U;
    const uint8_t was_blinking =
        (player->previous_flags &
         FACE_KEYFRAME_FLAG_BLINKING) != 0U;
    if (blinking != was_blinking) {
        player->forced_blink = blinking;
        player->forced_blink_edge = sample_clock;
    }
    motion->blink = max_u8(
        automatic_blink(player->atlas, sample_clock),
        forced_blink(player, sample_clock));
    compute_saccade(player->atlas, sample_clock, motion);
    motion->bob = breathing_bob(player->atlas, sample_clock);
}

/* ------------------------------------------------------------------------- */
/* Mouth mapping and coarticulation                                          */

static const face_sprite_viseme_map_t *find_viseme(
    const face_sprite_atlas_t *atlas,
    uint8_t viseme_set,
    uint8_t viseme)
{
    for (uint16_t index = 0U;
         index < atlas->viseme_map_count;
         ++index) {
        const face_sprite_viseme_map_t *entry =
            &atlas->viseme_map[index];
        if (entry->viseme_set == viseme_set &&
            entry->viseme == viseme) {
            return entry;
        }
    }
    return NULL;
}

static uint8_t fallback_role(
    const face_sprite_selector_t *selector,
    const face_render_key_t *render_key)
{
    const face_keyframe_t *controls = &render_key->controls;
    const int32_t corner_average =
        ((int32_t)render_key->mouth_corner_left +
         render_key->mouth_corner_right) / 2;
    const uint8_t width = clamp_u8_i32(
        (int32_t)controls->mouth_width + corner_average / 2);
    const uint8_t teeth = max_u8(
        controls->mouth_teeth, render_key->tongue);

    if (controls->mouth_open < selector->open_min) {
        return controls->mouth_press >= selector->press_min
            ? FACE_SPRITE_MOUTH_PRESS
            : FACE_SPRITE_MOUTH_REST;
    }
    if (teeth >= selector->teeth_min) {
        if (controls->mouth_open < selector->teeth_open) {
            return FACE_SPRITE_MOUTH_LIP_BITE;
        }
        return controls->mouth_round >= selector->teeth_round
            ? FACE_SPRITE_MOUTH_TONGUE
            : FACE_SPRITE_MOUTH_TEETH;
    }
    if (controls->mouth_round >= selector->round_min) {
        return controls->mouth_open >= selector->round_open
            ? FACE_SPRITE_MOUTH_ROUND
            : FACE_SPRITE_MOUTH_PUCKER;
    }
    if (width >= selector->wide_min) {
        return controls->mouth_open >= selector->wide_open
            ? FACE_SPRITE_MOUTH_WIDE
            : FACE_SPRITE_MOUTH_TEETH;
    }
    if (controls->mouth_open >= selector->open_wide) {
        return FACE_SPRITE_MOUTH_WIDE;
    }
    return FACE_SPRITE_MOUTH_HALF;
}

uint8_t face_sprite_select_mouth_slot(
    const face_sprite_atlas_t *atlas,
    const face_render_key_t *render_key,
    uint8_t *role)
{
    if (role != NULL) {
        *role = FACE_SPRITE_MOUTH_SLOT_NONE;
    }
    if (atlas == NULL || render_key == NULL ||
        atlas->mouth_slot_count == 0U) {
        return FACE_SPRITE_MOUTH_SLOT_NONE;
    }

    const face_sprite_viseme_map_t *mapped = NULL;
    if (render_key->viseme_weight >=
        atlas->selector.explicit_viseme_min) {
        if (render_key->viseme_blend >= 128U) {
            mapped = find_viseme(
                atlas, render_key->viseme_set,
                render_key->viseme_secondary);
        }
        if (mapped == NULL) {
            mapped = find_viseme(
                atlas, render_key->viseme_set,
                render_key->viseme);
        }
    }
    if (mapped != NULL) {
        if (role != NULL) {
            *role = mapped->role;
        }
        return mapped->mouth_slot;
    }

    const uint8_t selected_role =
        fallback_role(&atlas->selector, render_key);
    if (role != NULL) {
        *role = selected_role;
    }
    const uint8_t slot = atlas->fallback_slots[selected_role];
    return slot < atlas->mouth_slot_count
        ? slot
        : FACE_SPRITE_MOUTH_SLOT_NONE;
}

static uint8_t transition_role(uint8_t from, uint8_t to)
{
    const bool from_closed =
        from == FACE_SPRITE_MOUTH_REST ||
        from == FACE_SPRITE_MOUTH_PRESS ||
        from == FACE_SPRITE_MOUTH_TEETH ||
        from == FACE_SPRITE_MOUTH_LIP_BITE;
    const bool to_closed =
        to == FACE_SPRITE_MOUTH_REST ||
        to == FACE_SPRITE_MOUTH_PRESS ||
        to == FACE_SPRITE_MOUTH_TEETH ||
        to == FACE_SPRITE_MOUTH_LIP_BITE;
    if ((from == FACE_SPRITE_MOUTH_WIDE && to_closed) ||
        (to == FACE_SPRITE_MOUTH_WIDE && from_closed)) {
        return FACE_SPRITE_MOUTH_HALF;
    }
    if ((from == FACE_SPRITE_MOUTH_HALF ||
         from == FACE_SPRITE_MOUTH_WIDE) &&
        to == FACE_SPRITE_MOUTH_PUCKER) {
        return FACE_SPRITE_MOUTH_ROUND;
    }
    if (from == FACE_SPRITE_MOUTH_PUCKER &&
        (to == FACE_SPRITE_MOUTH_HALF ||
         to == FACE_SPRITE_MOUTH_WIDE)) {
        return FACE_SPRITE_MOUTH_ROUND;
    }
    return to;
}

static void update_mouth(
    face_sprite_player_t *player,
    const face_render_key_t *render_key,
    uint32_t sample_clock)
{
    const face_sprite_atlas_t *atlas = player->atlas;
    uint8_t target_role;
    const uint8_t target_slot =
        face_sprite_select_mouth_slot(
            atlas, render_key, &target_role);
    if (target_slot == FACE_SPRITE_MOUTH_SLOT_NONE) {
        return;
    }
    if (target_slot != player->target_slot ||
        target_role != player->target_role) {
        player->target_slot = target_slot;
        player->target_role = target_role;
        player->target_since = sample_clock;
    }
    if (target_slot == player->current_slot) {
        player->current_role = target_role;
        return;
    }
    if (sample_clock - player->mouth_since <
        atlas->timing.mouth_min_hold) {
        return;
    }
    if (target_role == FACE_SPRITE_MOUTH_REST &&
        sample_clock - player->target_since <
            atlas->timing.mouth_close_delay) {
        return;
    }

    const uint8_t intermediate =
        transition_role(player->current_role, target_role);
    const uint8_t intermediate_slot =
        intermediate < FACE_SPRITE_MOUTH_ROLE_COUNT
            ? atlas->fallback_slots[intermediate]
            : FACE_SPRITE_MOUTH_SLOT_NONE;
    if (intermediate != target_role &&
        intermediate_slot < atlas->mouth_slot_count &&
        intermediate_slot != player->current_slot) {
        player->current_slot = intermediate_slot;
        player->current_role = intermediate;
    } else {
        player->current_slot = target_slot;
        player->current_role = target_role;
    }
    player->mouth_since = sample_clock;
}

/* ------------------------------------------------------------------------- */
/* Layer selection and drawing                                               */

static const face_sprite_bank_t *select_bank(
    const face_sprite_atlas_t *atlas,
    const face_render_key_t *render_key)
{
    if (render_key->expression_weight <
        atlas->selector.expression_bank_min) {
        return &atlas->banks[0];
    }

    const int32_t mouth_corner =
        ((int32_t)render_key->mouth_corner_left +
         render_key->mouth_corner_right) / 2;
    const int32_t eye_squint =
        ((uint16_t)render_key->eye_left_squint +
         render_key->eye_right_squint) / 2U;
    const face_sprite_bank_t *best = &atlas->banks[0];
    uint32_t best_score = UINT32_MAX;
    for (uint8_t index = 0U; index < atlas->bank_count; ++index) {
        const face_sprite_expression_target_t *target =
            &atlas->banks[index].target;
        const int32_t valence_delta =
            (int32_t)render_key->affect_valence -
            target->valence;
        const int32_t arousal_delta =
            (int32_t)render_key->affect_arousal -
            target->arousal;
        const int32_t corner_delta =
            mouth_corner - target->mouth_corner;
        const int32_t brow_delta =
            (int32_t)render_key->brow_inner -
            target->brow_inner;
        const int32_t squint_delta =
            eye_squint - target->eye_squint;
        const uint32_t score =
            (uint32_t)(valence_delta < 0
                ? -valence_delta : valence_delta) * 3U +
            (uint32_t)(arousal_delta < 0
                ? -arousal_delta : arousal_delta) +
            (uint32_t)(corner_delta < 0
                ? -corner_delta : corner_delta) * 2U +
            (uint32_t)(brow_delta < 0
                ? -brow_delta : brow_delta) * 2U +
            (uint32_t)(squint_delta < 0
                ? -squint_delta : squint_delta);
        if (score < best_score) {
            best = &atlas->banks[index];
            best_score = score;
        }
    }
    return best;
}

static uint16_t indexed_cell(
    const uint16_t *cells,
    uint16_t count,
    uint32_t numerator,
    uint32_t denominator)
{
    if (count == 0U || denominator == 0U) {
        return FACE_SPRITE_CELL_NONE;
    }
    uint32_t index =
        (numerator * (count - 1U) + denominator / 2U) /
        denominator;
    if (index >= count) {
        index = count - 1U;
    }
    return cells[index];
}

static bool draw_eye(
    const face_sprite_blit_t *blit,
    const face_sprite_eye_layer_t *eye,
    uint8_t control_open,
    uint8_t squint,
    const face_sprite_motion_t *motion)
{
    if (eye->cell_count == 0U) {
        return true;
    }
    uint8_t open = multiply_u8(control_open, 255U - squint);
    open = multiply_u8(open, 255U - motion->blink);
    const uint16_t cell = indexed_cell(
        eye->cells, eye->cell_count, 255U - open, 255U);
    return blit_cell(
        blit, cell, eye->x, eye->y + motion->bob,
        (eye->flags & FACE_SPRITE_SLOT_FLIP_X) != 0U);
}

static bool draw_pupil(
    const face_sprite_blit_t *blit,
    const face_sprite_pupil_layer_t *pupil,
    const face_sprite_eye_layer_t *eye,
    uint8_t control_open,
    uint8_t squint,
    int8_t look_x,
    int8_t look_y,
    const face_sprite_motion_t *motion)
{
    if (pupil->cell == FACE_SPRITE_CELL_NONE) {
        return true;
    }
    uint8_t open = multiply_u8(control_open, 255U - squint);
    open = multiply_u8(open, 255U - motion->blink);
    if (open < 48U) {
        return true;
    }
    if (eye->cell_count > 1U) {
        const uint32_t lid =
            ((255U - open) * (eye->cell_count - 1U) + 127U) /
            255U;
        if (lid >= eye->cell_count - 1U) {
            return true;
        }
    }
    const int32_t gaze_x =
        ((int32_t)look_x * pupil->range_x) / 127 +
        motion->saccade_x;
    const int32_t gaze_y =
        ((int32_t)look_y * pupil->range_y) / 127 +
        motion->saccade_y;
    const int32_t x = clamp_i32(
        pupil->x + gaze_x, pupil->min_x, pupil->max_x);
    const int32_t y = clamp_i32(
        pupil->y + gaze_y, pupil->min_y, pupil->max_y);
    return blit_cell(
        blit, pupil->cell, x, y + motion->bob, false);
}

static int8_t brow_control(
    int8_t base,
    int8_t inner,
    int8_t outer)
{
    return (int8_t)clamp_i32(
        (int32_t)base + ((int32_t)inner + outer) / 2,
        -127, 127);
}

static bool draw_brow(
    const face_sprite_blit_t *blit,
    const face_sprite_brow_layer_t *brow,
    int8_t control,
    const face_sprite_motion_t *motion)
{
    if (brow->cell_count == 0U) {
        return true;
    }
    const uint16_t cell = indexed_cell(
        brow->cells, brow->cell_count,
        (uint32_t)((int32_t)control + 127), 254U);
    const int32_t lift =
        ((int32_t)control * brow->max_lift) / 127;
    return blit_cell(
        blit, cell, brow->x, brow->y - lift + motion->bob,
        (brow->flags & FACE_SPRITE_SLOT_FLIP_X) != 0U);
}

static bool draw_sequence(
    const face_sprite_blit_t *blit,
    const face_render_key_t *render_key,
    const face_sprite_motion_t *motion)
{
    const face_sprite_atlas_t *atlas = blit->atlas;
    if (atlas->sequence_count == 0U ||
        atlas->timing.idle_window == 0U) {
        return true;
    }
    const uint32_t epoch =
        blit->sample_clock / atlas->timing.idle_window;
    const uint32_t position =
        blit->sample_clock % atlas->timing.idle_window;
    const uint32_t noise = hash_u32(epoch + 0xacedU);
    if ((noise % 100U) >= 45U) {
        return true;
    }
    const face_sprite_sequence_t *sequence =
        &atlas->sequences[(noise >> 7U) % atlas->sequence_count];
    const bool speaking =
        (render_key->controls.flags &
         FACE_KEYFRAME_FLAG_SPEAKING) != 0U;
    if (speaking &&
        (sequence->flags &
         FACE_SPRITE_SEQUENCE_WHILE_SPEAKING) == 0U) {
        return true;
    }
    uint32_t total = 0U;
    for (uint16_t index = 0U;
         index < sequence->frame_count;
         ++index) {
        total += sequence->frames[index].duration_samples;
    }
    if (total == 0U || total >= atlas->timing.idle_window) {
        return true;
    }
    const uint32_t start =
        (noise >> 11U) % (atlas->timing.idle_window - total);
    if (position < start || position >= start + total) {
        return true;
    }
    uint32_t offset = position - start;
    for (uint16_t index = 0U;
         index < sequence->frame_count;
         ++index) {
        const face_sprite_sequence_frame_t *frame =
            &sequence->frames[index];
        if (offset < frame->duration_samples) {
            return blit_cell(
                blit, frame->cell, frame->x,
                frame->y + motion->bob, false);
        }
        offset -= frame->duration_samples;
    }
    return true;
}

/* ------------------------------------------------------------------------- */
/* Atlas validation                                                          */

static bool cell_reference_valid(
    const face_sprite_atlas_t *atlas,
    uint16_t cell)
{
    return cell == FACE_SPRITE_CELL_NONE ||
        cell < atlas->cell_count;
}

static bool placement_valid(
    const face_sprite_atlas_t *atlas,
    uint16_t cell_index,
    int32_t anchor_x,
    int32_t anchor_y)
{
    if (cell_index == FACE_SPRITE_CELL_NONE ||
        (atlas->flags &
         FACE_SPRITE_ATLAS_ALLOW_CLIPPING) != 0U) {
        return true;
    }
    if (cell_index >= atlas->cell_count) {
        return false;
    }
    const face_sprite_cell_t *cell =
        &atlas->cells[cell_index];
    const int32_t left = anchor_x + cell->offset_x;
    const int32_t top = anchor_y + cell->offset_y;
    return left >= 0 && top >= 0 &&
        left + cell->width <= atlas->native_width &&
        top + cell->height <= atlas->native_height;
}

static bool validate_cell(
    const face_sprite_atlas_t *atlas,
    const face_sprite_cell_t *cell)
{
    if (cell->width == 0U || cell->height == 0U ||
        cell->width > FACE_SPRITE_MAX_CELL_WIDTH ||
        cell->height > FACE_SPRITE_MAX_CELL_HEIGHT ||
        cell->data_offset > atlas->blob_size ||
        cell->data_length > atlas->blob_size - cell->data_offset) {
        return false;
    }
    const uint32_t pixel_count =
        (uint32_t)cell->width * cell->height;
    if (cell->encoding == FACE_SPRITE_ENCODING_RAW &&
        cell->data_length != pixel_count) {
        return false;
    }
    if (cell->encoding != FACE_SPRITE_ENCODING_RAW &&
        cell->encoding != FACE_SPRITE_ENCODING_PACKBITS) {
        return false;
    }

    face_sprite_stream_t stream;
    stream_open(&stream, atlas, cell);
    for (uint32_t pixel = 0U; pixel < pixel_count; ++pixel) {
        uint8_t value;
        if (!stream_next(&stream, &value)) {
            return false;
        }
        if (value != atlas->transparent_index &&
            value >= atlas->palette_count) {
            return false;
        }
    }
    return stream_finished(&stream);
}

static bool validate_eye(
    const face_sprite_atlas_t *atlas,
    const face_sprite_eye_layer_t *eye)
{
    if (eye->cell_count > FACE_SPRITE_MAX_LID_CELLS) {
        return false;
    }
    for (uint16_t index = 0U; index < eye->cell_count; ++index) {
        if (!cell_reference_valid(atlas, eye->cells[index])) {
            return false;
        }
    }
    return true;
}

static bool validate_pupil(
    const face_sprite_atlas_t *atlas,
    const face_sprite_pupil_layer_t *pupil)
{
    return cell_reference_valid(atlas, pupil->cell) &&
        pupil->min_x <= pupil->max_x &&
        pupil->min_y <= pupil->max_y;
}

static bool validate_brow(
    const face_sprite_atlas_t *atlas,
    const face_sprite_brow_layer_t *brow)
{
    if (brow->cell_count > FACE_SPRITE_MAX_BROW_CELLS) {
        return false;
    }
    for (uint16_t index = 0U; index < brow->cell_count; ++index) {
        if (!cell_reference_valid(atlas, brow->cells[index])) {
            return false;
        }
    }
    return true;
}

static bool validate_bank(
    const face_sprite_atlas_t *atlas,
    const face_sprite_bank_t *bank)
{
    if (!cell_reference_valid(atlas, bank->base_cell) ||
        !cell_reference_valid(atlas, bank->overlay_cell) ||
        !placement_valid(atlas, bank->base_cell, 0, 0) ||
        !placement_valid(
            atlas, bank->overlay_cell,
            bank->overlay_x, bank->overlay_y) ||
        bank->mouth.cells == NULL ||
        !validate_eye(atlas, &bank->eye_left) ||
        !validate_eye(atlas, &bank->eye_right) ||
        !validate_pupil(atlas, &bank->pupil_left) ||
        !validate_pupil(atlas, &bank->pupil_right) ||
        !validate_brow(atlas, &bank->brow_left) ||
        !validate_brow(atlas, &bank->brow_right)) {
        return false;
    }
    for (uint16_t slot = 0U;
         slot < atlas->mouth_slot_count;
         ++slot) {
        if (!cell_reference_valid(
                atlas, bank->mouth.cells[slot]) ||
            !placement_valid(
                atlas, bank->mouth.cells[slot],
                bank->mouth.x, bank->mouth.y)) {
            return false;
        }
    }
    const face_sprite_eye_layer_t *eyes[2] = {
        &bank->eye_left, &bank->eye_right,
    };
    for (uint8_t eye = 0U; eye < 2U; ++eye) {
        for (uint16_t index = 0U;
             index < eyes[eye]->cell_count;
             ++index) {
            if (!placement_valid(
                    atlas, eyes[eye]->cells[index],
                    eyes[eye]->x, eyes[eye]->y)) {
                return false;
            }
        }
    }
    const face_sprite_pupil_layer_t *pupils[2] = {
        &bank->pupil_left, &bank->pupil_right,
    };
    for (uint8_t pupil = 0U; pupil < 2U; ++pupil) {
        if (!placement_valid(
                atlas, pupils[pupil]->cell,
                pupils[pupil]->min_x, pupils[pupil]->min_y) ||
            !placement_valid(
                atlas, pupils[pupil]->cell,
                pupils[pupil]->max_x, pupils[pupil]->max_y)) {
            return false;
        }
    }
    const face_sprite_brow_layer_t *brows[2] = {
        &bank->brow_left, &bank->brow_right,
    };
    for (uint8_t brow = 0U; brow < 2U; ++brow) {
        for (uint16_t index = 0U;
             index < brows[brow]->cell_count;
             ++index) {
            if (!placement_valid(
                    atlas, brows[brow]->cells[index],
                    brows[brow]->x,
                    brows[brow]->y - brows[brow]->max_lift) ||
                !placement_valid(
                    atlas, brows[brow]->cells[index],
                    brows[brow]->x,
                    brows[brow]->y + brows[brow]->max_lift)) {
                return false;
            }
        }
    }
    return true;
}

static bool ranges_overlap(
    const face_sprite_cycle_t *left,
    const face_sprite_cycle_t *right)
{
    const uint16_t left_end =
        (uint16_t)left->first + left->count;
    const uint16_t right_end =
        (uint16_t)right->first + right->count;
    return left->first < right_end && right->first < left_end;
}

static bool validate_atlas(const face_sprite_atlas_t *atlas)
{
    if (atlas->magic != FACE_SPRITE_MAGIC ||
        atlas->version != FACE_SPRITE_VERSION ||
        atlas->scale == 0U ||
        atlas->native_width == 0U ||
        atlas->native_height == 0U ||
        atlas->palette_count == 0U ||
        atlas->palette_count > 256U ||
        atlas->palette == NULL ||
        atlas->cell_count == 0U ||
        atlas->cells == NULL ||
        atlas->blob == NULL ||
        atlas->mouth_slot_count == 0U ||
        atlas->mouth_slot_count >
            FACE_SPRITE_MOUTH_SLOT_NONE ||
        atlas->bank_count == 0U ||
        atlas->banks == NULL ||
        (atlas->viseme_map_count > 0U &&
         atlas->viseme_map == NULL) ||
        (atlas->sequence_count > 0U &&
         atlas->sequences == NULL) ||
        atlas->cycle_count > FACE_SPRITE_MAX_CYCLES ||
        (atlas->cycle_count > 0U &&
         atlas->cycles == NULL)) {
        return false;
    }

    for (uint8_t role = 0U;
         role < FACE_SPRITE_MOUTH_ROLE_COUNT;
         ++role) {
        const uint8_t slot = atlas->fallback_slots[role];
        if (slot != FACE_SPRITE_MOUTH_SLOT_NONE &&
            slot >= atlas->mouth_slot_count) {
            return false;
        }
    }
    if (atlas->fallback_slots[FACE_SPRITE_MOUTH_REST] ==
        FACE_SPRITE_MOUTH_SLOT_NONE) {
        return false;
    }
    for (uint16_t index = 0U; index < atlas->cell_count; ++index) {
        if (!validate_cell(atlas, &atlas->cells[index])) {
            return false;
        }
    }
    for (uint8_t index = 0U; index < atlas->bank_count; ++index) {
        if (!validate_bank(atlas, &atlas->banks[index])) {
            return false;
        }
    }
    for (uint16_t index = 0U;
         index < atlas->viseme_map_count;
         ++index) {
        const face_sprite_viseme_map_t *entry =
            &atlas->viseme_map[index];
        if (entry->mouth_slot >= atlas->mouth_slot_count ||
            (entry->role >= FACE_SPRITE_MOUTH_ROLE_COUNT &&
             entry->role != FACE_SPRITE_MOUTH_SLOT_NONE)) {
            return false;
        }
        for (uint16_t earlier = 0U; earlier < index; ++earlier) {
            if (atlas->viseme_map[earlier].viseme_set ==
                    entry->viseme_set &&
                atlas->viseme_map[earlier].viseme ==
                    entry->viseme) {
                return false;
            }
        }
    }
    for (uint8_t index = 0U;
         index < atlas->sequence_count;
         ++index) {
        const face_sprite_sequence_t *sequence =
            &atlas->sequences[index];
        if (sequence->frame_count == 0U ||
            sequence->frames == NULL) {
            return false;
        }
        uint32_t total = 0U;
        for (uint16_t frame = 0U;
             frame < sequence->frame_count;
             ++frame) {
            if (!cell_reference_valid(
                    atlas, sequence->frames[frame].cell) ||
                !placement_valid(
                    atlas, sequence->frames[frame].cell,
                    sequence->frames[frame].x,
                    sequence->frames[frame].y) ||
                sequence->frames[frame].duration_samples == 0U) {
                return false;
            }
            total += sequence->frames[frame].duration_samples;
            if (total > atlas->timing.idle_window &&
                atlas->timing.idle_window != 0U) {
                return false;
            }
        }
    }
    for (uint8_t index = 0U; index < atlas->cycle_count; ++index) {
        const face_sprite_cycle_t *cycle = &atlas->cycles[index];
        if (cycle->count < 2U ||
            cycle->period_samples == 0U ||
            (uint16_t)cycle->first + cycle->count >
                atlas->palette_count) {
            return false;
        }
        for (uint8_t earlier = 0U; earlier < index; ++earlier) {
            if (ranges_overlap(
                    &atlas->cycles[earlier], cycle)) {
                return false;
            }
        }
    }
    return true;
}

/* ------------------------------------------------------------------------- */
/* Public playback                                                           */

static void reset_player(face_sprite_player_t *player)
{
    const face_sprite_atlas_t *atlas = player->atlas;
    const uint8_t rest =
        atlas->fallback_slots[FACE_SPRITE_MOUTH_REST];
    player->last_clock = 0U;
    player->mouth_since = 0U;
    player->target_since = 0U;
    player->forced_blink_edge =
        0U - (uint32_t)atlas->timing.blink_open;
    player->current_slot = rest;
    player->target_slot = rest;
    player->current_role = FACE_SPRITE_MOUTH_REST;
    player->target_role = FACE_SPRITE_MOUTH_REST;
    player->previous_flags = 0U;
    player->forced_blink = 0U;
    player->reserved = 0U;
}

bool face_sprite_player_init(
    face_sprite_player_t *player,
    const face_sprite_atlas_t *atlas)
{
    if (player == NULL || atlas == NULL) {
        return false;
    }
    memset(player, 0, sizeof(*player));
    if (!validate_atlas(atlas)) {
        return false;
    }
    player->atlas = atlas;
    reset_player(player);
    return true;
}

static bool surface_valid(
    const face_sprite_atlas_t *atlas,
    const face_sprite_surface_t *surface)
{
    if (atlas == NULL || surface == NULL ||
        surface->pixels == NULL ||
        surface->width == 0U || surface->height == 0U ||
        surface->stride < surface->width ||
        surface->pixel_capacity < surface->width) {
        return false;
    }
    const size_t last_row_offset =
        (size_t)(surface->height - 1U) * surface->stride;
    if (last_row_offset >
        surface->pixel_capacity - surface->width) {
        return false;
    }
    return (uint32_t)atlas->native_width * atlas->scale <=
            surface->width &&
        (uint32_t)atlas->native_height * atlas->scale <=
            surface->height;
}

bool face_sprite_render_to(
    face_sprite_player_t *player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    const face_sprite_surface_t *surface)
{
    if (player == NULL || player->atlas == NULL ||
        render_key == NULL ||
        !surface_valid(player->atlas, surface)) {
        return false;
    }
    if (sample_clock < player->last_clock) {
        reset_player(player);
    }
    player->last_clock = sample_clock;

    face_sprite_motion_t motion;
    compute_motion(player, render_key, sample_clock, &motion);
    update_mouth(player, render_key, sample_clock);
    player->previous_flags = render_key->controls.flags;

    const face_sprite_atlas_t *atlas = player->atlas;
    for (uint16_t y = 0U; y < surface->height; ++y) {
        uint16_t *row =
            &surface->pixels[(size_t)y * surface->stride];
        for (uint16_t x = 0U; x < surface->width; ++x) {
            row[x] = atlas->background;
        }
    }

    /*
     * Translate the complete portrait a few native pixels for head/body
     * directions. Rotation stays renderer-specific; coherent translation is
     * cheap and keeps every sprite layer attached to the face.
     */
    const int32_t performance_x =
        (int32_t)render_key->head_yaw / 32 +
        (int32_t)render_key->body_lean_x / 48;
    const int32_t performance_y =
        (int32_t)render_key->head_pitch / 32 +
        (int32_t)render_key->body_lean_y / 48;
    const face_sprite_blit_t blit = {
        .pixels = surface->pixels,
        .width = surface->width,
        .height = surface->height,
        .stride = surface->stride,
        .atlas = atlas,
        .sample_clock = sample_clock,
        .origin_x =
            ((int32_t)surface->width -
             (int32_t)atlas->native_width * atlas->scale) /
                2 +
            performance_x * atlas->scale,
        .origin_y =
            ((int32_t)surface->height -
             (int32_t)atlas->native_height * atlas->scale) /
                2 +
            performance_y * atlas->scale,
    };
    const face_sprite_bank_t *bank =
        select_bank(atlas, render_key);
    const int8_t left_brow = brow_control(
        render_key->controls.brow,
        render_key->brow_inner,
        render_key->brow_outer_left);
    const int8_t right_brow = brow_control(
        render_key->controls.brow,
        render_key->brow_inner,
        render_key->brow_outer_right);

    if (!blit_cell(&blit, bank->base_cell, 0, motion.bob, false) ||
        !draw_brow(
            &blit, &bank->brow_left, left_brow, &motion) ||
        !draw_brow(
            &blit, &bank->brow_right, right_brow, &motion) ||
        !draw_eye(
            &blit, &bank->eye_left,
            render_key->controls.eye_left_open,
            render_key->eye_left_squint, &motion) ||
        !draw_eye(
            &blit, &bank->eye_right,
            render_key->controls.eye_right_open,
            render_key->eye_right_squint, &motion) ||
        !draw_pupil(
            &blit, &bank->pupil_left, &bank->eye_left,
            render_key->controls.eye_left_open,
            render_key->eye_left_squint,
            render_key->controls.look_x,
            render_key->controls.look_y, &motion) ||
        !draw_pupil(
            &blit, &bank->pupil_right, &bank->eye_right,
            render_key->controls.eye_right_open,
            render_key->eye_right_squint,
            render_key->controls.look_x,
            render_key->controls.look_y, &motion)) {
        return false;
    }

    if (player->current_slot >= atlas->mouth_slot_count ||
        !blit_cell(
            &blit, bank->mouth.cells[player->current_slot],
            bank->mouth.x, bank->mouth.y + motion.bob, false) ||
        !blit_cell(
            &blit, bank->overlay_cell, bank->overlay_x,
            bank->overlay_y + motion.bob, false) ||
        !draw_sequence(&blit, render_key, &motion)) {
        return false;
    }
    return true;
}

bool face_sprite_render(
    face_sprite_player_t *player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity)
{
    const face_sprite_surface_t surface = {
        .pixels = rgb565,
        .pixel_capacity = pixel_capacity,
        .width = FACE_RENDER_WIDTH,
        .height = FACE_RENDER_HEIGHT,
        .stride = FACE_RENDER_WIDTH,
    };
    return face_sprite_render_to(
        player, render_key, sample_clock, &surface);
}

bool face_sprite_render_snapshot_to(
    const face_sprite_player_t *validated_player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    const face_sprite_surface_t *surface)
{
    if (validated_player == NULL ||
        validated_player->atlas == NULL ||
        render_key == NULL) {
        return false;
    }
    face_sprite_player_t snapshot = *validated_player;
    uint8_t role;
    uint8_t slot = face_sprite_select_mouth_slot(
        snapshot.atlas, render_key, &role);
    if (slot == FACE_SPRITE_MOUTH_SLOT_NONE) {
        slot = snapshot.atlas
            ->fallback_slots[FACE_SPRITE_MOUTH_REST];
        role = FACE_SPRITE_MOUTH_REST;
    }
    snapshot.last_clock = sample_clock;
    snapshot.mouth_since = sample_clock;
    snapshot.target_since = sample_clock;
    snapshot.current_slot = slot;
    snapshot.target_slot = slot;
    snapshot.current_role = role;
    snapshot.target_role = role;
    snapshot.previous_flags = render_key->controls.flags;
    snapshot.forced_blink =
        (render_key->controls.flags &
         FACE_KEYFRAME_FLAG_BLINKING) != 0U;
    snapshot.forced_blink_edge = sample_clock -
        (snapshot.forced_blink != 0U
             ? snapshot.atlas->timing.blink_close
             : snapshot.atlas->timing.blink_open);
    return face_sprite_render_to(
        &snapshot, render_key, sample_clock, surface);
}

bool face_sprite_render_snapshot(
    const face_sprite_player_t *validated_player,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity)
{
    const face_sprite_surface_t surface = {
        .pixels = rgb565,
        .pixel_capacity = pixel_capacity,
        .width = FACE_RENDER_WIDTH,
        .height = FACE_RENDER_HEIGHT,
        .stride = FACE_RENDER_WIDTH,
    };
    return face_sprite_render_snapshot_to(
        validated_player, render_key, sample_clock, &surface);
}
