#ifndef ITERATE_KIT_FAKE_ESP_ERR_H
#define ITERATE_KIT_FAKE_ESP_ERR_H

/* Host stand-in. See README.md in this directory. */

typedef int esp_err_t;

#define ESP_OK 0
#define ESP_FAIL (-1)
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_ARG 0x102
#define ESP_ERR_INVALID_STATE 0x103

#endif
