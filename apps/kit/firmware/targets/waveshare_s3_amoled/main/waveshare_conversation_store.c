/*
 * One string in NVS: the conversation to resume. Every failure here resolves
 * to "nothing stored", because the caller's default is a working conversation
 * and this note is only ever an improvement on it — never a precondition for
 * booting.
 */
#include "waveshare_conversation_store.h"

#include <string.h>

#include "esp_err.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char tag[] = "waveshare-conversation";

/*
 * NVS namespace and key names are capped at 15 characters, so both of these
 * are short out of necessity rather than taste.
 */
static const char nvs_namespace[] = "iterate_kit";
static const char nvs_key[] = "conversation";

/*
 * NVS may or may not be up by the time this runs. The Wi-Fi transport
 * initialises it as well (iterate_kit_esp_idf_itx_transport_start), but only
 * when it starts, and the remembered path is wanted before then — at boot,
 * to decide what to mount. nvs_flash_init() returns ESP_OK for a partition
 * that is already initialised, so calling it here is idempotent rather than a
 * second initialisation.
 */
static bool nvs_ready(void) {
  const esp_err_t error = nvs_flash_init();
  if (error == ESP_OK) return true;
  /*
   * NO_FREE_PAGES and NEW_VERSION_FOUND are recovered by erasing NVS, which
   * this module deliberately does not do: an erase throws away Wi-Fi
   * calibration and every other durable thing the device keeps, and a note
   * about which conversation to resume is not worth that. The transport
   * erases when it must; until then this reads as "nothing stored" and the
   * caller uses its default.
   */
  ESP_LOGW(tag, "nvs unavailable (%s): conversation not remembered",
           esp_err_to_name(error));
  return false;
}

/*
 * A stored value is trusted only while it still looks like a stream path.
 * NVS checksums each entry, so a torn write already reads as missing rather
 * than as garbage; this catches the other case — a value left by a different
 * or older build that no longer means anything here.
 */
static bool is_stream_path(const char *path) {
  return path != NULL && path[0] == '/';
}

bool waveshare_conversation_load(char *out, size_t capacity) {
  nvs_handle_t handle;
  size_t length = capacity;
  esp_err_t error;

  if (out == NULL || capacity == 0U) return false;
  /* Emptied first, so a caller that ignores the result still sees nothing. */
  out[0] = '\0';
  if (!nvs_ready()) return false;

  error = nvs_open(nvs_namespace, NVS_READONLY, &handle);
  if (error != ESP_OK) {
    /*
     * A missing namespace is the ordinary state of a device that has never
     * been asked for a new conversation, so it is not worth a warning.
     */
    return false;
  }
  error = nvs_get_str(handle, nvs_key, out, &length);
  nvs_close(handle);
  if (error != ESP_OK || !is_stream_path(out)) {
    /*
     * Covers ESP_ERR_NVS_INVALID_LENGTH: a path too long for this buffer is,
     * to the caller, exactly the same situation as one that was never stored.
     * A failed read can also leave `out` partly written, hence the clear.
     */
    out[0] = '\0';
    return false;
  }
  ESP_LOGI(tag, "resuming %s", out);
  return true;
}

bool waveshare_conversation_store(const char *path) {
  nvs_handle_t handle;
  esp_err_t error;

  if (!is_stream_path(path)) return false;
  if (strlen(path) >= WAVESHARE_CONVERSATION_PATH_CAPACITY) {
    ESP_LOGW(tag, "conversation path too long to remember");
    return false;
  }
  if (!nvs_ready()) return false;

  error = nvs_open(nvs_namespace, NVS_READWRITE, &handle);
  if (error != ESP_OK) {
    ESP_LOGW(tag, "nvs open failed (%s)", esp_err_to_name(error));
    return false;
  }
  /*
   * nvs_set_str compares against what is already there and does nothing when
   * the value is unchanged, so a duplicate call costs no flash. That is a
   * backstop, not the rule — see the header on when to call this.
   */
  error = nvs_set_str(handle, nvs_key, path);
  if (error == ESP_OK) error = nvs_commit(handle);
  nvs_close(handle);
  if (error != ESP_OK) {
    ESP_LOGW(tag, "could not remember %s (%s)", path, esp_err_to_name(error));
    return false;
  }
  ESP_LOGI(tag, "remembering %s", path);
  return true;
}
