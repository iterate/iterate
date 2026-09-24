#ifndef ITERATE_KIT_HOST_ESP_ATTR_H
#define ITERATE_KIT_HOST_ESP_ATTR_H

/*
 * Host stand-in. See esp_idf.h.
 *
 * PSRAM placement is a linker fact and there is no PSRAM here, so the loop's
 * large buffers land in ordinary .bss. That is the whole difference, and it is
 * the one difference a host test cannot observe anyway.
 */
#define EXT_RAM_BSS_ATTR
#define IRAM_ATTR
#define DRAM_ATTR

#endif
