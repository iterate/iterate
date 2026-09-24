#ifndef ITERATE_KIT_HOST_ESP_SYSTEM_H
#define ITERATE_KIT_HOST_ESP_SYSTEM_H

/* Host stand-in. See esp_idf.h. */

#include "esp_err.h"

#include <stdint.h>

uint32_t esp_get_free_heap_size(void);
uint32_t esp_get_minimum_free_heap_size(void);
void esp_restart(void);

#endif
