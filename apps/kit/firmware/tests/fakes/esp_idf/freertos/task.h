#ifndef ITERATE_KIT_FAKE_FREERTOS_TASK_H
#define ITERATE_KIT_FAKE_FREERTOS_TASK_H

/*
 * Host stand-in. See ../README.md.
 *
 * NOTHING HERE SCHEDULES. `xTaskCreatePinnedToCore` records the request and
 * returns pdPASS without running the body, so a host test owns the whole
 * program on one thread and drives the loop's three steps in whatever order it
 * is about. `vTaskDelay` advances the fake clock instead of sleeping, which is
 * what makes a deadline test finish instantly rather than in real seconds.
 */

#include "FreeRTOS.h"

typedef void *TaskHandle_t;
typedef void (*TaskFunction_t)(void *argument);

typedef struct {
  /* Opaque; only its size matters to the transport's static reservation. */
  void *placeholder[8];
} StaticTask_t;

BaseType_t xTaskCreatePinnedToCore(
    TaskFunction_t body,
    const char *name,
    uint32_t stack_bytes,
    void *argument,
    UBaseType_t priority,
    TaskHandle_t *created,
    BaseType_t core);
void vTaskDelete(TaskHandle_t task);
void vTaskDelay(TickType_t ticks);
void vTaskPrioritySet(TaskHandle_t task, UBaseType_t priority);
TaskHandle_t xTaskGetCurrentTaskHandle(void);

#endif
