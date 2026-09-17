#ifndef ITERATE_KIT_FAKE_FREERTOS_IDF_ADDITIONS_H
#define ITERATE_KIT_FAKE_FREERTOS_IDF_ADDITIONS_H

/*
 * Host stand-in. See ../README.md.
 *
 * The capability argument is what puts a queue in PSRAM on a device. There is
 * no PSRAM here, so it is accepted and ignored — the placement is invisible to
 * every behaviour a host test can observe.
 */

#include "FreeRTOS.h"
#include "queue.h"

QueueHandle_t xQueueCreateWithCaps(
    UBaseType_t depth, UBaseType_t item_bytes, uint32_t capabilities);
void vQueueDeleteWithCaps(QueueHandle_t queue);

#endif
