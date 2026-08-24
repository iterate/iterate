#include "iterate/kit/platforms/esp_idf_system_update.h"

#include "iterate/kit/platforms/esp_idf_restart_note.h"

#include <stdbool.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"

static const char tag[] = "system-update";

enum {
  UPDATE_HTTP_TIMEOUT_MS = 20000,
  UPDATE_READ_BYTES = 4096,
  /* TLS handshake plus the OTA write path; measured comfortably under this. */
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
  char sha256_hex[65];
  /* One update at a time; cleared only on a failure (success restarts). */
  volatile bool in_flight;
} update;

static bool digest_matches(const uint8_t digest[32], const char *expected) {
  char rendered[65];
  size_t index;
  for (index = 0U; index < 32U; ++index) {
    static const char hex[] = "0123456789abcdef";
    rendered[index * 2U] = hex[digest[index] >> 4];
    rendered[index * 2U + 1U] = hex[digest[index] & 0x0FU];
  }
  rendered[64] = '\0';
  if (strcmp(rendered, expected) != 0) {
    ESP_LOGE(tag, "digest mismatch: got %s want %s", rendered, expected);
    return false;
  }
  return true;
}

static void update_task(void *context) {
  const esp_partition_t *slot = esp_ota_get_next_update_partition(NULL);
  esp_ota_handle_t ota = 0;
  esp_http_client_handle_t client = NULL;
  mbedtls_sha256_context sha;
  uint8_t *chunk = NULL;
  size_t total = 0U;
  bool ota_open = false;
  (void)context;
  mbedtls_sha256_init(&sha);

  do {
    const esp_http_client_config_t config = {
      .url = update.url,
      .timeout_ms = UPDATE_HTTP_TIMEOUT_MS,
      .buffer_size = UPDATE_READ_BYTES,
      .crt_bundle_attach = esp_crt_bundle_attach,
    };
    if (slot == NULL) {
      ESP_LOGE(tag, "no inactive OTA slot — partition table predates OTA");
      break;
    }
    chunk = malloc(UPDATE_READ_BYTES);
    if (chunk == NULL) {
      ESP_LOGE(tag, "no memory for the download buffer");
      break;
    }
    client = esp_http_client_init(&config);
    if (client == NULL || esp_http_client_open(client, 0) != ESP_OK) {
      ESP_LOGE(tag, "could not open %s", update.url);
      break;
    }
    (void)esp_http_client_fetch_headers(client);
    {
      const int http_status = esp_http_client_get_status_code(client);
      if (http_status != 200) {
        ESP_LOGE(tag, "fetch returned HTTP %d", http_status);
        break;
      }
    }
    if (esp_ota_begin(slot, OTA_SIZE_UNKNOWN, &ota) != ESP_OK) {
      ESP_LOGE(tag, "esp_ota_begin failed for %s", slot->label);
      break;
    }
    ota_open = true;
    if (mbedtls_sha256_starts(&sha, 0) != 0) break;
    for (;;) {
      const int got =
          esp_http_client_read(client, (char *)chunk, UPDATE_READ_BYTES);
      if (got < 0) {
        ESP_LOGE(tag, "read failed at %u bytes", (unsigned)total);
        goto failed;
      }
      if (got == 0) break;
      if (mbedtls_sha256_update(&sha, chunk, (size_t)got) != 0 ||
          esp_ota_write(ota, chunk, (size_t)got) != ESP_OK) {
        ESP_LOGE(tag, "flash write failed at %u bytes", (unsigned)total);
        goto failed;
      }
      total += (size_t)got;
    }
    {
      uint8_t digest[32];
      if (total == 0U || mbedtls_sha256_finish(&sha, digest) != 0 ||
          !digest_matches(digest, update.sha256_hex)) {
        break;
      }
    }
    ota_open = false;
    if (esp_ota_end(ota) != ESP_OK) {
      ESP_LOGE(tag, "esp_ota_end rejected the image");
      break;
    }
    if (esp_ota_set_boot_partition(slot) != ESP_OK) {
      ESP_LOGE(tag, "could not select %s for boot", slot->label);
      break;
    }
    ESP_LOGI(
        tag, "%u bytes verified into %s; restarting", (unsigned)total,
        slot->label);
    esp_http_client_cleanup(client);
    free(chunk);
    mbedtls_sha256_free(&sha);
    /*
     * The rollback config keeps the old image one reset away: the new one
     * boots PENDING_VERIFY and is marked valid only when the transport
     * reaches READY — a client whose one job is the connection proves itself
     * by connecting.
     */
    iterate_kit_esp_restart_with_note("system-update");
    return;
  } while (0);

failed:
  if (ota_open) (void)esp_ota_abort(ota);
  if (client != NULL) esp_http_client_cleanup(client);
  free(chunk);
  mbedtls_sha256_free(&sha);
  update.in_flight = false;
  vTaskDelete(NULL);
}

enum iterate_kit_status iterate_kit_esp_idf_system_update_begin(
    void *context, const char *url, const char *sha256_hex) {
  (void)context;
  if (url == NULL || sha256_hex == NULL ||
      strlen(url) >= sizeof(update.url) ||
      strlen(sha256_hex) != sizeof(update.sha256_hex) - 1U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (__atomic_exchange_n(&update.in_flight, true, __ATOMIC_ACQ_REL)) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  strcpy(update.url, url);
  strcpy(update.sha256_hex, sha256_hex);
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
