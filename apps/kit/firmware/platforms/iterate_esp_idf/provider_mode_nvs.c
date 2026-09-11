#include "iterate/kit/platforms/provider_mode_nvs.h"

#include <stddef.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static bool nvs_read_mode(const void *context, uint8_t *mode) {
  const struct iterate_kit_provider_mode_nvs *nvs = context;
  nvs_handle_t handle;
  bool read = false;
  if (nvs == NULL || mode == NULL || nvs->namespace_name == NULL ||
      nvs->key == NULL) {
    return false;
  }
  if (nvs->initialize_flash_on_load) {
    const esp_err_t status = nvs_flash_init();
    if (status != ESP_OK) {
      ESP_LOGE("provider-mode", "%s flash init failed: %d", nvs->namespace_name, (int)status);
      return false;
    }
  }
  esp_err_t status = nvs_open(nvs->namespace_name, NVS_READONLY, &handle);
  if (status != ESP_OK) {
    if (status != ESP_ERR_NVS_NOT_FOUND) {
      ESP_LOGE("provider-mode", "%s mode store open failed: %d", nvs->namespace_name, (int)status);
    }
    return false;
  }
  status = nvs_get_u8(handle, nvs->key, mode);
  read = status == ESP_OK;
  if (!read && status != ESP_ERR_NVS_NOT_FOUND) {
    ESP_LOGE("provider-mode", "%s mode read failed: %d", nvs->namespace_name, (int)status);
  }
  nvs_close(handle);
  return read;
}

static bool nvs_write_mode(const void *context, uint8_t mode) {
  const struct iterate_kit_provider_mode_nvs *nvs = context;
  nvs_handle_t handle;
  bool written = false;
  if (nvs == NULL || nvs->namespace_name == NULL || nvs->key == NULL ||
      nvs_open(nvs->namespace_name, NVS_READWRITE, &handle) != ESP_OK) {
    return false;
  }
  if (nvs_set_u8(handle, nvs->key, mode) == ESP_OK) {
    written = nvs_commit(handle) == ESP_OK;
  }
  nvs_close(handle);
  return written;
}

struct iterate_kit_provider_mode_store iterate_kit_provider_mode_nvs_store(
    const struct iterate_kit_provider_mode_nvs *nvs) {
  return (struct iterate_kit_provider_mode_store){
      .context = nvs,
      .read = nvs_read_mode,
      .write = nvs_write_mode,
  };
}
