#include "iterate/kit/avatar/face_viseme_queue.h"

#include <string.h>

void face_viseme_queue_init(face_viseme_queue_t *queue)
{
    if (queue == NULL) {
        return;
    }
    memset(queue, 0, sizeof(*queue));
}

void face_viseme_queue_reset(face_viseme_queue_t *queue)
{
    if (queue == NULL) {
        return;
    }
    queue->head = 0;
    queue->count = 0;
}

bool face_viseme_queue_push(face_viseme_queue_t *queue,
                            uint32_t answer,
                            uint32_t offset_samples,
                            uint8_t viseme,
                            uint8_t confidence)
{
    if (queue == NULL) {
        return false;
    }
    if (queue->count >= FACE_VISEME_QUEUE_CAPACITY) {
        queue->overflowed += 1;
        return false;
    }
    const uint8_t slot = (uint8_t)((queue->head + queue->count) %
                                   FACE_VISEME_QUEUE_CAPACITY);
    queue->entries[slot].answer = answer;
    queue->entries[slot].offset_samples = offset_samples;
    queue->entries[slot].viseme = viseme;
    queue->entries[slot].confidence = confidence;
    queue->count += 1;
    return true;
}

bool face_viseme_queue_advance(face_viseme_queue_t *queue,
                               uint32_t answer,
                               uint32_t played_samples,
                               face_viseme_change_t *out_change)
{
    if (queue == NULL) {
        return false;
    }

    bool crossed = false;
    while (queue->count > 0) {
        const face_viseme_change_t *entry = &queue->entries[queue->head];
        /*
         * Answers are compared with wrap-safe signed distance so a stream
         * that outlives 2^31 answers still orders correctly. In practice the
         * counter is small; the arithmetic costs nothing.
         */
        const int32_t answer_delta = (int32_t)(entry->answer - answer);
        if (answer_delta > 0) {
            break;
        }
        if (answer_delta < 0) {
            queue->superseded += 1;
            queue->head = (uint8_t)((queue->head + 1U) %
                                    FACE_VISEME_QUEUE_CAPACITY);
            queue->count -= 1;
            continue;
        }
        if (entry->offset_samples > played_samples) {
            break;
        }
        if (out_change != NULL) {
            *out_change = *entry;
        }
        crossed = true;
        queue->head = (uint8_t)((queue->head + 1U) %
                                FACE_VISEME_QUEUE_CAPACITY);
        queue->count -= 1;
    }
    return crossed;
}
