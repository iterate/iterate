#ifndef ITERATE_KIT_HOST_ESP_RANDOM_H
#define ITERATE_KIT_HOST_ESP_RANDOM_H
#include <stddef.h>
#include <stdint.h>
uint32_t esp_random(void);
void esp_fill_random(void *buffer, size_t length);
#endif
