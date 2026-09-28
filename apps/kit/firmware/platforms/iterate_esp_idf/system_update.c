#include "iterate/kit/platforms/system_update.h"

#include "iterate/kit/platforms/restart_note.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "psa/crypto.h"

/*
 * `system.update` on ESP-IDF, in Espressif's own OTA shape:
 *
 * 1. esp_https_ota streams the image over HTTPS (the certificate bundle;
 *    redirects followed) into the inactive slot, ota_0 or ota_1 of the
 *    board's targets/common/partitions-*.csv.
 * 2. The slot is read back and its SHA-256 compared with the digest the caller
 *    named. esp_https_ota checks that an image is whole; only this proves it
 *    is the one that was asked for.
 * 3. esp_https_ota_finish validates the image and makes the slot the boot
 *    partition, and the board restarts with the note "system-update".
 * 4. CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE boots the new image PENDING_VERIFY.
 *    iterate_kit_esp_system_update_accept() marks it valid; any reset before
 *    that boots the previous image again.
 */

static const char tag[] = "system-update";

enum {
  UPDATE_HTTP_TIMEOUT_MS = 20000,
  /* The HTTP read size, and the size of each read back from the slot. */
  UPDATE_CHUNK_BYTES = 4096,
  /* The TLS handshake plus the OTA write path; measured comfortably under. */
  UPDATE_TASK_STACK_BYTES = 12288,
  /*
   * Low priority on the non-audio core: an update is minutes of background
   * flash writes, and a call in progress must not hear it happen.
   */
  UPDATE_TASK_PRIORITY = 3,
  UPDATE_TASK_CORE = 0,
};

static struct {
  char url[512];
  uint8_t sha256[32];
  /* One update at a time; cleared only on a failure (success restarts). */
  volatile bool in_flight;
} update;

/* Step 2: the first `length` bytes of `slot` hash to the digest asked for. */
static bool slot_holds_requested_image(
    const esp_partition_t *slot, size_t length) {
  psa_hash_operation_t sha = PSA_HASH_OPERATION_INIT;
  uint8_t *chunk = malloc(UPDATE_CHUNK_BYTES);
  uint8_t digest[32];
  size_t digest_length = 0U;
  size_t offset;
  bool hashed = chunk != NULL && length > 0U &&
      psa_hash_setup(&sha, PSA_ALG_SHA_256) == PSA_SUCCESS;
  for (offset = 0U; hashed && offset < length; offset += UPDATE_CHUNK_BYTES) {
    const size_t size = length - offset < UPDATE_CHUNK_BYTES
        ? length - offset
        : UPDATE_CHUNK_BYTES;
    hashed = esp_partition_read(slot, offset, chunk, size) == ESP_OK &&
        psa_hash_update(&sha, chunk, size) == PSA_SUCCESS;
  }
  hashed = hashed &&
      psa_hash_finish(&sha, digest, sizeof(digest), &digest_length) ==
          PSA_SUCCESS;
  (void)psa_hash_abort(&sha);
  free(chunk);
  if (!hashed) {
    ESP_LOGE(tag, "could not hash %u bytes of %s", (unsigned)length, slot->label);
    return false;
  }
  if (memcmp(digest, update.sha256, sizeof(digest)) != 0) {
    ESP_LOGE(tag, "%s holds an image whose sha256 is not the one asked for:",
        slot->label);
    ESP_LOG_BUFFER_HEX_LEVEL(tag, digest, sizeof(digest), ESP_LOG_ERROR);
    return false;
  }
  return true;
}

static void update_task(void *unused) {
  const esp_partition_t *slot = esp_ota_get_next_update_partition(NULL);
  const esp_http_client_config_t http = {
    .url = update.url,
    .timeout_ms = UPDATE_HTTP_TIMEOUT_MS,
    .buffer_size = UPDATE_CHUNK_BYTES,
    .crt_bundle_attach = esp_crt_bundle_attach,
  };
  const esp_https_ota_config_t config = {
    .http_config = &http,
    .partition = {.staging = slot},
  };
  esp_https_ota_handle_t ota = NULL;
  esp_err_t err =
      slot == NULL ? ESP_ERR_NOT_FOUND : esp_https_ota_begin(&config, &ota);
  (void)unused;
  if (err == ESP_OK) {
    do {
      err = esp_https_ota_perform(ota);
    } while (err == ESP_ERR_HTTPS_OTA_IN_PROGRESS);
  }
  if (err == ESP_OK &&
      !(esp_https_ota_is_complete_data_received(ota) &&
        slot_holds_requested_image(
            slot, (size_t)esp_https_ota_get_image_len_read(ota)))) {
    err = ESP_ERR_INVALID_CRC;
  }
  if (ota != NULL) {
    if (err == ESP_OK) {
      err = esp_https_ota_finish(ota);
    } else {
      (void)esp_https_ota_abort(ota);
    }
  }
  if (err == ESP_OK) {
    ESP_LOGI(tag, "verified into %s; restarting", slot->label);
    iterate_kit_platform_restart_with_note("system-update");
  }
  ESP_LOGE(tag, "update from %s failed: %s", update.url, esp_err_to_name(err));
  update.in_flight = false;
  vTaskDelete(NULL);
}

enum iterate_kit_status iterate_kit_platform_system_update_begin(
    void *context, const char *url, const uint8_t sha256[32]) {
  (void)context;
  if (url == NULL || sha256 == NULL || strlen(url) >= sizeof(update.url)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (__atomic_exchange_n(&update.in_flight, true, __ATOMIC_ACQ_REL)) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  strcpy(update.url, url);
  memcpy(update.sha256, sha256, sizeof(update.sha256));
  if (xTaskCreatePinnedToCore(
          update_task,
          "system-update",
          UPDATE_TASK_STACK_BYTES,
          NULL,
          UPDATE_TASK_PRIORITY,
          NULL,
          UPDATE_TASK_CORE) != pdPASS) {
    update.in_flight = false;
    return ITERATE_KIT_UNAVAILABLE;
  }
  ESP_LOGI(tag, "update scheduled from %s", update.url);
  return ITERATE_KIT_OK;
}

/*
 * Step 4. READY is the acceptance test because a client whose one job is the
 * connection proves itself by mounting. An image that boots but never reaches
 * READY is restarted by the voice loop ("transport never became ready") and
 * the bootloader boots the previous one.
 */
void iterate_kit_esp_system_update_accept(void) {
  static bool accepted;
  esp_ota_img_states_t state;
  if (accepted) return;
  accepted = true;
  if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) ==
          ESP_OK &&
      state == ESP_OTA_IMG_PENDING_VERIFY) {
    ESP_LOGI(tag, "the updated image reached READY; rollback cancelled");
    (void)esp_ota_mark_app_valid_cancel_rollback();
  }
}
