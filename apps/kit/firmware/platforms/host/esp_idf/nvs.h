#ifndef ITERATE_KIT_HOST_NVS_H
#define ITERATE_KIT_HOST_NVS_H

/* Host stand-in. See esp_idf.h. The u8 slice of NVS the boards use, in RAM for
 * the life of the process; iterate_kit_host_esp_idf_reset() erases it. */

#include "esp_err.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ESP_ERR_NVS_NOT_FOUND 0x1102

typedef uint32_t nvs_handle_t;
typedef enum { NVS_READONLY, NVS_READWRITE } nvs_open_mode_t;

esp_err_t nvs_open(const char *name, nvs_open_mode_t mode, nvs_handle_t *out);
esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *out);
esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value);
esp_err_t nvs_commit(nvs_handle_t handle);
void nvs_close(nvs_handle_t handle);

#ifdef __cplusplus
}
#endif

#endif
