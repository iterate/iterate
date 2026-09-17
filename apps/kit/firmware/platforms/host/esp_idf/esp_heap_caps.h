#ifndef ITERATE_KIT_FAKE_ESP_HEAP_CAPS_H
#define ITERATE_KIT_FAKE_ESP_HEAP_CAPS_H

/* Host stand-in. See README.md in this directory. */

#include <stddef.h>

#define MALLOC_CAP_INTERNAL 0x00000800
#define MALLOC_CAP_DMA 0x00000008
#define MALLOC_CAP_SPIRAM 0x00000400
#define MALLOC_CAP_DEFAULT 0x00001000

size_t heap_caps_get_free_size(uint32_t capabilities);
size_t heap_caps_get_largest_free_block(uint32_t capabilities);
size_t heap_caps_get_minimum_free_size(uint32_t capabilities);

#endif
