#include "iterate/kit/platforms/provider_mode_nvs.h"

#include "nvs.h"
#include "nvs_flash.h"

#include <assert.h>
#include <string.h>

static struct {
  esp_err_t flash_init;
  esp_err_t open;
  esp_err_t get;
  esp_err_t set;
  esp_err_t commit;
  const char *namespace_name;
  const char *key;
  uint8_t value;
  unsigned int flash_inits;
  unsigned int closes;
  unsigned int commits;
  unsigned int errors;
} fake;

void iterate_kit_fake_esp_log(
    const char *level, const char *tag, const char *format, ...) {
  (void)tag;
  (void)format;
  assert(strcmp(level, "E") == 0);
  ++fake.errors;
}

esp_err_t nvs_flash_init(void) {
  ++fake.flash_inits;
  return fake.flash_init;
}

esp_err_t nvs_open(
    const char *name, nvs_open_mode_t open_mode, nvs_handle_t *out_handle) {
  (void)open_mode;
  fake.namespace_name = name;
  if (fake.open != ESP_OK) return fake.open;
  *out_handle = 1U;
  return ESP_OK;
}

esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *out_value) {
  (void)handle;
  fake.key = key;
  if (fake.get != ESP_OK) return fake.get;
  *out_value = fake.value;
  return ESP_OK;
}

esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value) {
  (void)handle;
  fake.key = key;
  fake.value = value;
  return fake.set;
}

esp_err_t nvs_commit(nvs_handle_t handle) {
  (void)handle;
  ++fake.commits;
  return fake.commit;
}

void nvs_close(nvs_handle_t handle) {
  (void)handle;
  ++fake.closes;
}

int main(void) {
  const struct iterate_kit_provider_mode_nvs stackchan = {
      .namespace_name = "stackchan",
      .key = "mode",
      .initialize_flash_on_load = true,
  };
  const struct iterate_kit_provider_mode_nvs havpe = {
      .namespace_name = "havpe",
      .key = "mode",
      .initialize_flash_on_load = false,
  };
  struct iterate_kit_provider_mode_store store;
  uint8_t mode = 0U;

  memset(&fake, 0, sizeof(fake));
  store = iterate_kit_provider_mode_nvs_store(&stackchan);
  fake.value = 2U;
  assert(store.read(store.context, &mode));
  assert(mode == 2U && fake.flash_inits == 1U && fake.closes == 1U);
  assert(strcmp(fake.namespace_name, "stackchan") == 0);
  assert(strcmp(fake.key, "mode") == 0);

  store = iterate_kit_provider_mode_nvs_store(&havpe);
  assert(store.write(store.context, 3U));
  assert(fake.value == 3U && fake.commits == 1U && fake.closes == 2U);
  assert(strcmp(fake.namespace_name, "havpe") == 0);
  assert(strcmp(fake.key, "mode") == 0);

  fake.set = ESP_FAIL;
  assert(!store.write(store.context, 1U));
  assert(fake.commits == 1U && fake.closes == 3U);
  memset(&fake, 0, sizeof(fake));
  store = iterate_kit_provider_mode_nvs_store(&stackchan);
  fake.flash_init = ESP_FAIL;
  assert(!store.read(store.context, &mode));
  assert(fake.errors == 1U && fake.namespace_name == NULL);
  memset(&fake, 0, sizeof(fake));
  fake.open = ESP_ERR_NVS_NOT_FOUND;
  assert(!store.read(store.context, &mode));
  assert(fake.errors == 0U && fake.closes == 0U);
  fake.open = ESP_OK;
  fake.get = ESP_ERR_NVS_NOT_FOUND;
  assert(!store.read(store.context, &mode));
  assert(fake.errors == 0U && fake.closes == 1U);
  fake.get = ESP_FAIL;
  assert(!store.read(store.context, &mode));
  assert(fake.errors == 1U && fake.closes == 2U);
  return 0;
}
