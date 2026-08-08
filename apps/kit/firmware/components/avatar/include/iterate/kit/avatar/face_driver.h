#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_pose.h"

typedef enum {
    FACE_STREAM_USER_SPEECH_STARTED = 0,
    FACE_STREAM_USER_SPEECH_STOPPED,
    FACE_STREAM_ASSISTANT_RESPONSE_STARTED,
    FACE_STREAM_ASSISTANT_TRANSCRIPT_DELTA,
    FACE_STREAM_ASSISTANT_TRANSCRIPT_DONE,
    FACE_STREAM_ASSISTANT_AUDIO_DONE,
    FACE_STREAM_ASSISTANT_RESPONSE_DONE,
} face_stream_event_type_t;

typedef struct {
    face_stream_event_type_t type;
    /*
     * Network-order marker and authoritative dispatch clock. A stream adapter
     * records the cumulative assistant PCM received when the event arrived,
     * then dispatches it when that marker reaches speaker playout.
     */
    uint32_t received_audio_samples;
    uint32_t dispatch_playout_samples;
    const char *utf8;
    size_t utf8_bytes;
    bool cumulative;
} face_stream_event_t;

typedef struct {
    const char *name;
    size_t state_size;
    size_t state_alignment;
    bool (*init)(void *state, uint32_t sample_rate,
                 const void *config, size_t config_size);
    void (*push_pcm)(void *state, const int16_t *samples,
                     size_t sample_count);
    void (*push_event)(void *state, const face_stream_event_t *event);
    void (*snapshot)(const void *state, face_pose_t *pose);
} face_algorithm_t;

/*
 * A non-owning, allocation-free dispatch handle. The caller owns the selected
 * algorithm's state storage and its implementation-specific configuration.
 */
typedef struct {
    const face_algorithm_t *algorithm;
    void *state;
} face_driver_t;

bool face_driver_init(face_driver_t *driver,
                      const face_algorithm_t *algorithm,
                      void *state, size_t state_size,
                      uint32_t sample_rate,
                      const void *config, size_t config_size);
void face_driver_push_pcm(face_driver_t *driver,
                          const int16_t *samples, size_t sample_count);
void face_driver_push_event(
    face_driver_t *driver, const face_stream_event_t *event);
void face_driver_snapshot(const face_driver_t *driver, face_pose_t *pose);
const char *face_driver_name(const face_driver_t *driver);
size_t face_driver_state_size(const face_driver_t *driver);
