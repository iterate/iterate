#pragma once

#include <stdint.h>

#include "iterate/kit/avatar/face_pose.h"

/*
 * Stable continuous-control interchange. This is intentionally smaller than
 * face_pose_t and remains useful for renderers that only need blendshape-like
 * controls.
 *
 * The same record can be produced locally from PCM, streamed from a host, or
 * replayed from a deterministic test capture. All fields are byte-sized so
 * the wire representation is endian-independent.
 */
typedef struct {
    uint8_t mouth_open;
    uint8_t mouth_width;
    uint8_t mouth_round;
    uint8_t mouth_press;
    uint8_t mouth_teeth;
    uint8_t eye_left_open;
    uint8_t eye_right_open;
    int8_t look_x;
    int8_t look_y;
    int8_t brow;
    uint8_t expression;
    uint8_t flags;
} face_keyframe_t;

enum {
    FACE_KEYFRAME_FLAG_SPEAKING = 1U << 0,
    FACE_KEYFRAME_FLAG_BLINKING = 1U << 1,
    FACE_KEYFRAME_BYTES = 12,
};

_Static_assert(
    sizeof(face_keyframe_t) == FACE_KEYFRAME_BYTES,
    "face keyframe wire format must remain exactly 12 bytes");

void face_keyframe_from_pose(
    const face_pose_t *pose, face_keyframe_t *keyframe);
void face_pose_apply_keyframe(
    face_pose_t *pose, const face_keyframe_t *keyframe);

typedef enum {
    /* Current FACE_VISEME_* values: Meta/OVR-style 15-shape vocabulary. */
    FACE_VISEME_SET_OVR15 = 0,
    FACE_VISEME_SET_VRM5 = 1,
    FACE_VISEME_SET_PRESTON9 = 2,
    FACE_VISEME_SET_MICROSOFT22 = 3,
    FACE_VISEME_SET_CUSTOM = 255,
} face_viseme_set_t;

typedef enum {
    FACE_SPEECH_IDLE = 0,
    FACE_SPEECH_STARTING = 1,
    FACE_SPEECH_ACTIVE = 2,
    FACE_SPEECH_ENDING = 3,
} face_speech_phase_t;

/*
 * General-purpose facial-action IR, inspired by the separation used by
 * MPEG-4 FAP, ARKit blendshapes, Live2D parameters, and VRM expressions.
 *
 * Layers:
 *
 *   bytes  0..11  stable continuous jaw/eye/gaze control prefix
 *   bytes 12..15  original speech-analysis result and audio energy
 *   bytes 16..19  extensible viseme vocabulary, coarticulation, speech phase
 *   bytes 20..31  reduced upper/lower-face actions and affect
 *   bytes 32..39  head/body performance controls, version, expression id
 *
 * `viseme` is not a limit of fifteen shapes. `viseme_set` identifies the
 * vocabulary in which `viseme` and `viseme_secondary` are encoded. An atlas
 * can therefore expose Preston-Blair 9, VRM 5, OVR 15, Microsoft 22, or a
 * custom sprite vocabulary. `viseme_blend` supports coarticulation between
 * adjacent shapes.
 *
 * `controls.expression` remains the conversational activity state used by the
 * original 12-byte keyframe (idle/listening/thinking/speaking).
 * `stage_expression` is the independent authored/AI-directed emotion. Keeping
 * those axes separate prevents a "joy" cue from accidentally turning an
 * activity-aware renderer idle.
 *
 * Signed action fields use -127..127 with zero as neutral; unsigned action
 * fields use 0..255. The record remains tiny enough to stream at 30 fps
 * (1,200 bytes/s) and is deliberately richer than any one renderer.
 */
typedef struct {
    face_keyframe_t controls;
    uint8_t viseme;
    uint8_t phoneme;
    uint8_t viseme_weight;
    uint8_t audio_level;
    uint8_t viseme_set;
    uint8_t viseme_secondary;
    uint8_t viseme_blend;
    uint8_t speech_phase;
    int8_t mouth_corner_left;
    int8_t mouth_corner_right;
    uint8_t tongue;
    uint8_t cheek;
    uint8_t eye_left_squint;
    uint8_t eye_right_squint;
    int8_t brow_inner;
    int8_t brow_outer_left;
    int8_t brow_outer_right;
    int8_t head_roll;
    int8_t affect_valence;
    uint8_t affect_arousal;
    int8_t head_yaw;
    int8_t head_pitch;
    int8_t body_lean_x;
    int8_t body_lean_y;
    uint8_t expression_weight;
    uint8_t attention;
    uint8_t schema_version;
    uint8_t stage_expression;
} face_render_key_t;

enum {
    FACE_RENDER_KEY_SCHEMA_VERSION = 2,
    FACE_RENDER_KEY_BYTES = 40,
};

_Static_assert(
    sizeof(face_render_key_t) == FACE_RENDER_KEY_BYTES,
    "face renderer IR must remain exactly 40 bytes");

void face_render_key_from_pose(
    const face_pose_t *pose, face_render_key_t *render_key);
void face_pose_apply_render_key(
    face_pose_t *pose, const face_render_key_t *render_key);
