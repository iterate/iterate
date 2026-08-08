#include <assert.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "iterate/kit/avatar/face_avatar_registry.h"

static uint16_t pixels[FACE_RENDER_PIXEL_COUNT];

static uint64_t frame_hash(const uint16_t *frame)
{
    /* FNV-1a is only a compact golden-image guard, not a content checksum. */
    uint64_t hash = UINT64_C(1469598103934665603);
    for (size_t index = 0U; index < FACE_RENDER_PIXEL_COUNT; ++index) {
        hash ^= frame[index] & UINT8_MAX;
        hash *= UINT64_C(1099511628211);
        hash ^= frame[index] >> 8;
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

static void all_device_avatars_are_renderable(void)
{
    face_avatar_registry_t registry;
    face_render_key_t pose = {0};
    uint64_t hashes[5] = {0};
    static const uint64_t expected_hashes[5] = {
        UINT64_C(0x2df9b52f3aa0d923),
        UINT64_C(0x5b01fa08b25f11ab),
        UINT64_C(0x027f1d1513846793),
        UINT64_C(0xbf5535b8d0f3720b),
        UINT64_C(0x7c95b6bf8d8d5793),
    };

    /*
     * Catalogue membership is a product contract, not merely a renderer
     * implementation detail. This exact count prevents a removed character
     * from silently remaining reachable through button rotation or Grok.
     */
    assert(face_avatar_registry_count() == 5U);
    assert(face_avatar_registry_init(&registry));
    pose.controls.eye_left_open = UINT8_MAX;
    pose.controls.eye_right_open = UINT8_MAX;
    pose.controls.mouth_open = 173U;
    pose.controls.mouth_width = 208U;

    for (size_t index = 0U;
         index < face_avatar_registry_count();
         ++index) {
        memset(pixels, 0xa5, sizeof(pixels));
        assert(face_avatar_registry_select(&registry, index));
        assert(face_avatar_registry_render(
            &registry, &pose, 543210U,
            pixels, FACE_RENDER_PIXEL_COUNT));
        hashes[index] = frame_hash(pixels);
        assert(hashes[index] != 0U);
        /*
         * These endianness-independent pixel hashes preserve the exact five
         * faces we ship. A renderer optimization must deliberately update
         * the visual goldens rather than silently changing the art. To
         * regenerate the goldens after an intentional art change, build with
         * -DFACE_AVATAR_REGISTRY_TEST_CAPTURE_HASHES and copy the printed
         * avatar[N] hashes into expected_hashes above.
         */
#ifndef FACE_AVATAR_REGISTRY_TEST_CAPTURE_HASHES
        assert(hashes[index] == expected_hashes[index]);
#else
        (void)expected_hashes;
#endif
        assert(face_avatar_registry_current_index(&registry) == index);
        assert(face_avatar_registry_current_slug(&registry) != NULL);
    }

    /*
     * A different hash for every atlas catches a generated catalogue which
     * accidentally aliases one visual several times while still returning
     * true.
     */
    for (size_t left = 0U; left < 5U; ++left) {
        for (size_t right = left + 1U; right < 5U; ++right) {
            assert(hashes[left] != hashes[right]);
        }
        printf("avatar[%zu]=0x%016" PRIx64 "\n", left, hashes[left]);
    }
}

static void registries_do_not_share_selection_state(void)
{
    face_avatar_registry_t first;
    face_avatar_registry_t second;

    assert(face_avatar_registry_init(&first));
    assert(face_avatar_registry_init(&second));
    assert(face_avatar_registry_select(&first, 2U));
    assert(face_avatar_registry_current_index(&first) == 2U);
    assert(face_avatar_registry_current_index(&second) == 0U);
}

/*
 * `changeSpriteSet` receives a public slug rather than an implementation
 * index: catalogue generation may reorder entries, while a remotely stored
 * user choice must continue naming the same character. Exact length matching
 * also prevents a valid prefix or embedded suffix from selecting the wrong
 * atlas at the C/Cap'n Web boundary.
 */
static void selects_sprite_sets_by_exact_public_slug(void)
{
    face_avatar_registry_t registry;

    assert(face_avatar_registry_init(&registry));
    assert(face_avatar_registry_select_slug(
        &registry, "starbyte", strlen("starbyte")));
    assert(strcmp(
        face_avatar_registry_current_slug(&registry), "starbyte") == 0);
    assert(!face_avatar_registry_select_slug(
        &registry, "star", strlen("star")));
    assert(!face_avatar_registry_select_slug(
        &registry, "starbyte-extra", strlen("starbyte-extra")));
    assert(face_avatar_registry_select_slug(
        &registry, "furnace-imp", strlen("furnace-imp")));
    assert(strcmp(
        face_avatar_registry_current_slug(&registry), "furnace-imp") == 0);
    assert(face_avatar_registry_select_slug(
        &registry, "moonscope", strlen("moonscope")));
    assert(strcmp(
        face_avatar_registry_current_slug(&registry), "moonscope") == 0);
    assert(!face_avatar_registry_select_slug(
        &registry,
        "missing-avatar",
        strlen("missing-avatar")));
    assert(strcmp(
        face_avatar_registry_current_slug(&registry), "moonscope") == 0);
}

int main(void)
{
    all_device_avatars_are_renderable();
    registries_do_not_share_selection_state();
    selects_sprite_sets_by_exact_public_slug();
    puts("face_avatar_registry_test: PASS");
    return 0;
}
