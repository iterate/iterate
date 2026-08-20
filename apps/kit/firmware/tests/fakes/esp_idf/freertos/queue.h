#ifndef ITERATE_KIT_FAKE_FREERTOS_QUEUE_H
#define ITERATE_KIT_FAKE_FREERTOS_QUEUE_H

/*
 * Host stand-in. See ../README.md.
 *
 * A REAL BOUNDED RING, unlike the rest of these fakes, because the loop's
 * microphone and speaker paths are the ring: a queue that always accepted or
 * always refused would make every test of them vacuous. Copy-on-send and
 * copy-on-receive are the semantics the loop depends on and are reproduced
 * exactly. Blocking is not: a wait of any length returns immediately, since
 * there is no other task here to fill the queue while this one waits.
 */

#include "FreeRTOS.h"

#include <stddef.h>

typedef struct iterate_kit_fake_queue *QueueHandle_t;

QueueHandle_t xQueueCreate(UBaseType_t depth, UBaseType_t item_bytes);
void vQueueDelete(QueueHandle_t queue);
BaseType_t xQueueSend(QueueHandle_t queue, const void *item, TickType_t wait);
BaseType_t xQueueSendToFront(
    QueueHandle_t queue, const void *item, TickType_t wait);
BaseType_t xQueueReceive(QueueHandle_t queue, void *item, TickType_t wait);
BaseType_t xQueueReset(QueueHandle_t queue);
UBaseType_t uxQueueMessagesWaiting(QueueHandle_t queue);
UBaseType_t uxQueueSpacesAvailable(QueueHandle_t queue);

#endif
