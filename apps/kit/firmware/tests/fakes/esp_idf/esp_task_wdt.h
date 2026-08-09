#ifndef ITERATE_KIT_FAKE_ESP_TASK_WDT_H
#define ITERATE_KIT_FAKE_ESP_TASK_WDT_H

/* Host stand-in. See README.md in this directory. */

#include "esp_err.h"

esp_err_t esp_task_wdt_add(void *task);
esp_err_t esp_task_wdt_reset(void);

#endif
