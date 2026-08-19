#include "iterate/kit/avatar/face_avatar_registry.h"

#include "iterate/kit/avatar/face_performance.h"
#include "iterate/kit/avatar/face_sprite_sheet.h"

#include <string.h>

typedef struct {
    const char *slug;
    const char *name;
    const face_sprite_atlas_t *atlas;
    uint16_t work_width;
    uint16_t work_height;
    uint8_t flags;
} face_avatar_entry_t;

#include "face_avatar_catalog_generated.inc"

static const face_performance_profile_t SPRITE_PERFORMANCE = {
    .seed = 0x47424f54U,
    .motion_gain = 208U,
    .gaze_gain = 208U,
    .expression_gain = 224U,
    .blink_gain = 240U,
};

static size_t avatar_count(void)
{
    return sizeof(GENERATED_AVATARS) / sizeof(GENERATED_AVATARS[0]);
}

static int8_t clamp_motion(int8_t value)
{
    if (value < -32) {
        return -32;
    }
    return value > 32 ? 32 : value;
}

static bool prepare_render_key(
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    face_render_key_t *animated)
{
    if (render_key == NULL || animated == NULL) {
        return false;
    }
    *animated = *render_key;
    if (animated->controls.eye_left_open == 0U &&
        animated->controls.eye_right_open == 0U &&
        (animated->controls.flags & FACE_KEYFRAME_FLAG_BLINKING) == 0U) {
        animated->controls.eye_left_open = 255U;
        animated->controls.eye_right_open = 255U;
    }
    if (!face_performance_apply(
            &SPRITE_PERFORMANCE,
            sample_clock,
            animated,
            NULL)) {
        return false;
    }

    /*
     * The LCD itself is StackChan's head. Keep occasional acting movement,
     * but cap it to one native sprite pixel and never add a second body
     * translation. This restores life without making a portrait float
     * around inside the physical face.
     */
    animated->head_yaw = clamp_motion(animated->head_yaw);
    animated->head_pitch = clamp_motion(animated->head_pitch);
    animated->head_roll = 0;
    animated->body_lean_x = 0;
    animated->body_lean_y = 0;
    return true;
}

bool face_avatar_registry_select(
    face_avatar_registry_t *registry, size_t index)
{
    if (registry == NULL || index >= avatar_count()) {
        return false;
    }

    face_sprite_player_t candidate;
    if (!face_sprite_player_init(
            &candidate, GENERATED_AVATARS[index].atlas)) {
        return false;
    }
    registry->player = candidate;
    registry->current = index;
    registry->ready = true;
    return true;
}

bool face_avatar_registry_init(face_avatar_registry_t *registry)
{
    if (registry == NULL) {
        return false;
    }
    *registry = (face_avatar_registry_t){0};
    return face_avatar_registry_select(registry, 0U);
}

bool face_avatar_registry_select_slug(
    face_avatar_registry_t *registry,
    const char *slug,
    size_t slug_length)
{
    if (registry == NULL || slug == NULL || slug_length == 0U) {
        return false;
    }
    for (size_t index = 0U; index < avatar_count(); ++index) {
        const char *const candidate = GENERATED_AVATARS[index].slug;
        /*
         * Catalogue slugs are generator-owned NUL-terminated ASCII, while the
         * public RPC value is a bounded byte view. Check length before bytes so
         * neither a prefix nor a suffixed value can alias a real character.
         * Selection remains transactional because the registry is mutated only
         * after a complete match.
         */
        if (strlen(candidate) == slug_length &&
            memcmp(candidate, slug, slug_length) == 0) {
            return face_avatar_registry_select(registry, index);
        }
    }
    return false;
}

size_t face_avatar_registry_count(void)
{
    return avatar_count();
}

size_t face_avatar_registry_current_index(
    const face_avatar_registry_t *registry)
{
    return registry != NULL && registry->ready
        ? registry->current
        : SIZE_MAX;
}

const char *face_avatar_registry_current_slug(
    const face_avatar_registry_t *registry)
{
    return registry != NULL && registry->ready
        ? GENERATED_AVATARS[registry->current].slug
        : NULL;
}

const char *face_avatar_registry_slug_at(size_t index)
{
    return index < avatar_count() ? GENERATED_AVATARS[index].slug : NULL;
}

bool face_avatar_registry_render(
    face_avatar_registry_t *registry,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity)
{
    if (registry == NULL || render_key == NULL || rgb565 == NULL ||
        (!registry->ready && !face_avatar_registry_init(registry))) {
        return false;
    }

    face_render_key_t animated;
    if (!prepare_render_key(render_key, sample_clock, &animated)) {
        return false;
    }

    return face_sprite_render(
        &registry->player,
        &animated,
        sample_clock,
        rgb565,
        pixel_capacity);
}

bool face_avatar_registry_render_snapshot_at(
    size_t index,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity)
{
    const face_avatar_entry_t *entry =
        index < avatar_count() ? &GENERATED_AVATARS[index] : NULL;
    if (entry == NULL || render_key == NULL || rgb565 == NULL) {
        return false;
    }
    face_sprite_player_t player;
    face_render_key_t animated;
    if (!face_sprite_player_init(&player, entry->atlas) ||
        !prepare_render_key(render_key, sample_clock, &animated)) {
        return false;
    }
    return face_sprite_render_snapshot(
        &player,
        &animated,
        sample_clock,
        rgb565,
        pixel_capacity);
}
