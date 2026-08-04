#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum { FACE_VISEME_QUEUE_CAPACITY = 32 };

/*
 * One scheduled mouth-shape change from the worker's viseme track. Offsets
 * count s16le samples from the first sample of the answer they belong to;
 * scoping by answer is what lets a barge-in purge kill the mouth track and
 * the audio with one identity rule instead of a cancellation protocol.
 */
typedef struct {
    uint32_t answer;
    uint32_t offset_samples;
    uint8_t viseme;
    uint8_t confidence;
} face_viseme_change_t;

/*
 * Bounded, allocation-free schedule of viseme changes awaiting playout. The
 * platform adapter pushes changes as they arrive off the stream and advances
 * the queue with the samples it actually releases to the face; changes for
 * answers that playout has moved past are dropped, changes for answers not
 * yet playing wait their turn.
 */
typedef struct {
    face_viseme_change_t entries[FACE_VISEME_QUEUE_CAPACITY];
    uint8_t head;
    uint8_t count;
    /* Changes rejected because the queue was full. */
    uint32_t overflowed;
    /* Changes dropped because their answer had already been left behind. */
    uint32_t superseded;
} face_viseme_queue_t;

void face_viseme_queue_init(face_viseme_queue_t *queue);

/* Forgets every pending change. For call end and playout abandon. */
void face_viseme_queue_reset(face_viseme_queue_t *queue);

bool face_viseme_queue_push(face_viseme_queue_t *queue,
                            uint32_t answer,
                            uint32_t offset_samples,
                            uint8_t viseme,
                            uint8_t confidence);

/*
 * Advances playout for `answer` to `played_samples` and reports the latest
 * change that playout has now crossed. Multiple changes crossed by one call
 * collapse to the newest; the intermediate shapes were shorter than the
 * caller's release chunk and could never have been rendered anyway.
 */
bool face_viseme_queue_advance(face_viseme_queue_t *queue,
                               uint32_t answer,
                               uint32_t played_samples,
                               face_viseme_change_t *out_change);

#ifdef __cplusplus
}
#endif
