#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_keyframe.h"
#include "iterate/kit/avatar/face_sprite_sheet.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Allocation-free registry for the sprite atlases compiled into a target.
 *
 * All entries share the caller-owned RGB565 framebuffer. Palette-only themes
 * can also share their compressed sprite blob, so cycling an avatar never
 * allocates or copies frame-sized memory. State is explicit rather than a
 * hidden process singleton: host tests can run independent renderers and a
 * future board with two displays will not inherit accidental global coupling.
 */
typedef struct {
    face_sprite_player_t player;
    size_t current;
    bool ready;
} face_avatar_registry_t;

bool face_avatar_registry_init(face_avatar_registry_t *registry);
bool face_avatar_registry_select(
    face_avatar_registry_t *registry, size_t index);
/*
 * Selects an exact catalogue slug without allocation or temporary NUL
 * termination. The caller may therefore pass a bounded RPC string view. A
 * failed lookup leaves the current player untouched.
 */
bool face_avatar_registry_select_slug(
    face_avatar_registry_t *registry,
    const char *slug,
    size_t slug_length);
size_t face_avatar_registry_count(void);
size_t face_avatar_registry_current_index(
    const face_avatar_registry_t *registry);
const char *face_avatar_registry_current_slug(
    const face_avatar_registry_t *registry);
const char *face_avatar_registry_slug_at(size_t index);
bool face_avatar_registry_render(
    face_avatar_registry_t *registry,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity);

/*
 * One frame of the worn face for `pose`, the way every board draws it: `key`
 * gets the pose's render key, and dozing, the lids shut in the character's
 * own sleepy bank and the Z goes on over the face (face_doze.h). False when
 * the render or the overlay fails; the board keeps its last coherent frame.
 */
bool face_avatar_registry_render_pose(
    face_avatar_registry_t *registry,
    const face_pose_t *pose,
    bool dozing,
    uint32_t sample_clock,
    face_render_key_t *key,
    uint16_t *rgb565,
    size_t pixel_capacity);

/*
 * Pure interleaved-matrix path for WASM. It uses the same compiled atlas,
 * performance preparation, and renderer as firmware without sharing the
 * firmware player's mouth-debounce history between gallery tiles.
 */
bool face_avatar_registry_render_snapshot_at(
    size_t index,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity);

#ifdef __cplusplus
}
#endif
