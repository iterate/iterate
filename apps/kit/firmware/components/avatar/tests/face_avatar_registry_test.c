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
    uint64_t hashes[4] = {0};
    static const uint64_t expected_hashes[4] = {
        UINT64_C(0x2df9b52f3aa0d923),
        UINT64_C(0x672b92829ae26edb),
        UINT64_C(0x027f1d1513846793),
        UINT64_C(0x7c95b6bf8d8d5793),
    };

    assert(face_avatar_registry_count() == 4U);
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
         * These endianness-independent pixel hashes preserve the exact four
         * faces we are restoring. A renderer optimization must deliberately
         * update the visual goldens rather than silently changing the art.
         */
        assert(hashes[index] == expected_hashes[index]);
        assert(face_avatar_registry_current_index(&registry) == index);
        assert(face_avatar_registry_current_slug(&registry) != NULL);
    }

    /*
     * A different hash for every atlas catches a generated catalogue which
     * accidentally aliases one visual four times while still returning true.
     */
    for (size_t left = 0U; left < 4U; ++left) {
        for (size_t right = left + 1U; right < 4U; ++right) {
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
    assert(face_avatar_registry_select(&first, 3U));
    assert(face_avatar_registry_current_index(&first) == 3U);
    assert(face_avatar_registry_current_index(&second) == 0U);
}

int main(void)
{
    all_device_avatars_are_renderable();
    registries_do_not_share_selection_state();
    puts("face_avatar_registry_test: PASS");
    return 0;
}
