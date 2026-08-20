#ifndef ITERATE_KIT_FAKE_FREERTOS_H
#define ITERATE_KIT_FAKE_FREERTOS_H

/* Host stand-in. See ../README.md. */

#include <stdint.h>

typedef uint32_t TickType_t;
typedef int BaseType_t;
typedef unsigned int UBaseType_t;
typedef uint8_t StackType_t;

#define pdTRUE ((BaseType_t)1)
#define pdFALSE ((BaseType_t)0)
#define pdPASS pdTRUE
#define pdFAIL pdFALSE

#define configTICK_RATE_HZ 1000
#define portMAX_DELAY ((TickType_t)0xffffffffU)
#define portTICK_PERIOD_MS (1000U / configTICK_RATE_HZ)

/* One tick per millisecond, so the loop's DELAY_MS arithmetic is unchanged. */
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))

#endif
