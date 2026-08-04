#pragma once

#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_driver.h"
#include "iterate/kit/avatar/face_pose.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint16_t speech_floor;
    uint16_t mouth_dynamic_range;
    uint8_t attack_percent;
    uint8_t release_percent;
} face_envelope_config_t;

typedef struct {
    uint32_t window_samples;
    uint32_t window_fill;
    uint32_t sum_abs;
    uint32_t zero_crossings;
    uint32_t next_blink_frame;
    uint32_t next_gaze_frame;
    uint32_t published_sequence;
    face_envelope_config_t config;
    int8_t last_sign;
    uint8_t blink_phase;
    bool listening_lock;
    bool external_mouth;
    uint8_t viseme_windows_left;
    face_animator_state_t state;
} face_animator_t;

extern const face_envelope_config_t FACE_ENVELOPE_DEFAULT_CONFIG;
extern const face_algorithm_t FACE_ALGORITHM_ENVELOPE;

void face_animator_init(face_animator_t *animator, uint32_t sample_rate);
bool face_animator_init_with_config(
    face_animator_t *animator, uint32_t sample_rate,
    const face_envelope_config_t *config);
void face_animator_push_pcm(face_animator_t *animator,
                            const int16_t *samples,
                            size_t sample_count);
void face_animator_push_event(
    face_animator_t *animator, const face_stream_event_t *event);
/**
 * Hands the mouth to an external viseme track. The envelope keeps producing
 * level, activity, blink and gaze, but stops writing the five mouth controls;
 * enabling zeroes them once so the mouth does not freeze mid-envelope shape.
 */
void face_animator_set_external_mouth(face_animator_t *animator, bool enabled);
/**
 * Applies one viseme from the external track, valid until the next call or
 * until 300 ms of playout passes with no replacement — the expiry is the
 * safety net that returns a stalled stream's mouth to rest instead of
 * freezing it on the last shape the worker happened to send.
 */
void face_animator_apply_viseme(face_animator_t *animator,
                                uint8_t viseme, uint8_t confidence);
/** Drops the external viseme immediately. For barge-in purge and call end. */
void face_animator_clear_viseme(face_animator_t *animator);
/**
 * Attempts one bounded coherent snapshot.
 *
 * The analyzer and renderer may share a CPU core. Waiting for an odd seqlock
 * there can deadlock: the renderer that is spinning may have preempted the
 * analyzer which must close the write. A failed attempt therefore leaves
 * `state` untouched; the 30 Hz renderer should retain its previous pose and
 * try again on its next tick.
 */
bool face_animator_snapshot(const face_animator_t *animator,
                            face_animator_state_t *state);

#ifdef __cplusplus
}
#endif
