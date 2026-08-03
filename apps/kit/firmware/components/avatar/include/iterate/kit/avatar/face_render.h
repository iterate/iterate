#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_keyframe.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Portable software renderer used by both the ESP32-S3 firmware and the WASM
 * comparison laboratory. A complete frame is RGB565 at half the CoreS3 LCD
 * resolution, so a device can scale it 2x while a browser can present the
 * exact same pixels with image smoothing disabled or enabled per profile.
 *
 * Renderers are pure functions of keyframe + sample clock. They allocate
 * nothing, retain no PCM, and use integer arithmetic only. The deterministic
 * clock drives blinks, saccades, brow motion, breathing, and small idle acts.
 */
enum {
    FACE_RENDER_WIDTH = 160,
    FACE_RENDER_HEIGHT = 120,
    FACE_RENDER_PIXEL_COUNT =
        FACE_RENDER_WIDTH * FACE_RENDER_HEIGHT,
    FACE_RENDER_FRAME_BYTES =
        FACE_RENDER_PIXEL_COUNT * (int)sizeof(uint16_t),
};

typedef enum {
    FACE_RENDER_FAMILY_PIXEL = 0,
    FACE_RENDER_FAMILY_ROBOT = 1,
    FACE_RENDER_FAMILY_EYES = 2,
    FACE_RENDER_FAMILY_MOUTH = 3,
    FACE_RENDER_FAMILY_CYBER = 4,
    FACE_RENDER_FAMILY_TOON = 5,
} face_render_family_t;

typedef enum {
    FACE_RENDER_MOUTH_NONE = 0,
    FACE_RENDER_MOUTH_SPRITE = 1,
    FACE_RENDER_MOUTH_ELLIPSE = 2,
    FACE_RENDER_MOUTH_POLYGON = 3,
    FACE_RENDER_MOUTH_LINE = 4,
    FACE_RENDER_MOUTH_SEGMENTS = 5,
    FACE_RENDER_MOUTH_SDF = 6,
} face_render_mouth_kind_t;

enum {
    FACE_RENDER_FLAG_PIXELATED = 1U << 0,
    FACE_RENDER_FLAG_SHADER = 1U << 1,
    FACE_RENDER_FLAG_EYE_FOCUS = 1U << 2,
    FACE_RENDER_FLAG_SPRITE_MOUTH = 1U << 3,
    FACE_RENDER_FLAG_POLYGON_MOUTH = 1U << 4,
    FACE_RENDER_FLAG_IDLE_MOTION = 1U << 5,
    FACE_RENDER_FLAG_HALF_RES = 1U << 6,
    FACE_RENDER_FLAG_NO_MOUTH = 1U << 7,
};

typedef enum {
    FACE_RENDER_EGA_QUEST = 0,
    FACE_RENDER_VGA_ELDER,
    FACE_RENDER_TALKIE_CLOSEUP,
    FACE_RENDER_PIXEL_AUTOMATON,
    FACE_RENDER_AMBER_TERMINAL,
    FACE_RENDER_POCKET_RPG,
    FACE_RENDER_DITHERED_ROGUE,
    FACE_RENDER_VECTOR_ROUNDED,
    FACE_RENDER_COZMO_CUBIC,
    FACE_RENDER_ROBOEYES_ALERT,
    FACE_RENDER_ROBOEYES_SOFT,
    FACE_RENDER_M5_AVATAR_CLASSIC,
    FACE_RENDER_M5_AVATAR_MANGA,
    FACE_RENDER_EVE_MINIMAL,
    FACE_RENDER_JIBO_ORB,
    FACE_RENDER_SACCADE_LAB,
    FACE_RENDER_BROW_DIALOGUE,
    FACE_RENDER_LID_ANTICIPATION,
    FACE_RENDER_IRIS_PARALLAX,
    FACE_RENDER_SLEEP_WAKE,
    FACE_RENDER_CURIOUS_TILT,
    FACE_RENDER_DOT_MATRIX_EYES,
    FACE_RENDER_CAT_OPTICS,
    FACE_RENDER_PRESTON_SPRITES,
    FACE_RENDER_POLYGON_JALI,
    FACE_RENDER_BEZIER_RIBBON,
    FACE_RENDER_TEETH_TONGUE,
    FACE_RENDER_LED_VU_MOUTH,
    FACE_RENDER_ORIGAMI_MASK,
    FACE_RENDER_NEON_SDF_CYAN,
    FACE_RENDER_NEON_SDF_MAGENTA,
    FACE_RENDER_LIQUID_SMIN,
    FACE_RENDER_CRT_CHROMATIC,
    FACE_RENDER_HOLO_WIREFRAME,
    FACE_RENDER_VOICE_ORB,
    FACE_RENDER_RED_OPTIC,
    FACE_RENDER_HUB75_NEON,
    FACE_RENDER_EDGE_GLOW,
    FACE_RENDER_GLITCH_MASK,
    FACE_RENDER_PALETTE_PLASMA,
    FACE_RENDER_ROBOT_RIG_VECTOR_ROUNDED,
    FACE_RENDER_ROBOT_RIG_COZMO_CUBIC,
    FACE_RENDER_ROBOT_RIG_BROW_DIALOGUE,
    FACE_RENDER_ROBOT_RIG_SLEEP_WAKE,
    FACE_RENDER_ROBOT_RIG_IRIS_PARALLAX,
    FACE_RENDER_ROBOT_RIG_CAT_OPTICS,
    FACE_RENDER_ROBOT_RIG_M5_MANGA,
    FACE_RENDER_SPRITE_VGA_STAR_NAVIGATOR,
    FACE_RENDER_SPRITE_POCKET_RELAY_CREATURE,
    FACE_RENDER_PIXEL_PACK_EGA_QUEST,
    FACE_RENDER_PIXEL_PACK_VGA_ELDER,
    FACE_RENDER_PIXEL_PACK_TALKIE_CLOSEUP,
    FACE_RENDER_PIXEL_PACK_DITHERED_ROGUE,
    FACE_RENDER_TOON_BEAN,
    FACE_RENDER_TOON_INK,
    FACE_RENDER_TOON_EMBER,
    FACE_RENDER_SPRITE_ACTOR_EGA_COURT_MAGE,
    FACE_RENDER_SPRITE_ACTOR_VGA_STAR_CAPTAIN,
    FACE_RENDER_SPRITE_ACTOR_TALKIE_MOON_MECHANIC,
    FACE_RENDER_SPRITE_ACTOR_JRPG_STORM_FAMILIAR,
    FACE_RENDER_SPRITE_ACTOR_HANDHELD_FOREST_PET,
    FACE_RENDER_SPRITE_ACTOR_ARCADE_CHROME_PILOT,
    FACE_RENDER_ACTOR_MOCHI_CAT,
    FACE_RENDER_ACTOR_KARAKURI_BRASS,
    FACE_RENDER_ACTOR_EMOTE_STICKER,
    FACE_RENDER_ACTOR_WILL_O_WISP,
    FACE_RENDER_ACTOR_MONO_SCOPE,
    FACE_RENDER_SHADER_AURORA_FAMILIAR,
    FACE_RENDER_SHADER_LIQUID_CHROMA,
    FACE_RENDER_SHADER_CRT_GHOST,
    FACE_RENDER_SPRITE_SHEET_POCKET_MOSSLING,
    FACE_RENDER_PROFILE_COUNT,
} face_render_profile_t;

typedef struct {
    uint16_t width;
    uint16_t height;
    uint16_t work_width;
    uint16_t work_height;
    uint16_t framebuffer_bytes;
    uint8_t family;
    uint8_t mouth_kind;
    uint8_t flags;
    uint8_t reserved;
    uint16_t estimated_ops_per_pixel;
} face_render_info_t;

#ifdef __cplusplus
static_assert(
#else
_Static_assert(
#endif
    sizeof(face_render_info_t) == 16,
    "renderer metadata ABI must remain exactly 16 bytes");

size_t face_render_profile_count(void);
const char *face_render_profile_slug(face_render_profile_t profile);
const char *face_render_profile_name(face_render_profile_t profile);
const char *face_render_profile_family_name(
    face_render_profile_t profile);
bool face_render_profile_info(
    face_render_profile_t profile, face_render_info_t *info);

/*
 * Render exactly FACE_RENDER_WIDTH × FACE_RENDER_HEIGHT RGB565 pixels.
 * `sample_clock` is in 16 kHz PCM samples, even for silent/idle previews.
 */
bool face_render_frame(
    face_render_profile_t profile,
    const face_render_key_t *render_key,
    uint32_t sample_clock,
    uint16_t *rgb565,
    size_t pixel_capacity);

#ifdef __cplusplus
}
#endif
