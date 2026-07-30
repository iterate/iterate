#ifndef ITERATE_KIT_CONFIGURATION_H
#define ITERATE_KIT_CONFIGURATION_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * Capacities include the trailing NUL. Wi-Fi fields mirror protocol limits;
   * the remaining fields are explicit firmware policy bounds, so decoding
   * never allocates. URL endpoint capacities account for replacing "https"
   * with "wss" and adding the fixed path, not arbitrary URL rewriting.
   */
  ITERATE_KIT_CONFIGURATION_HEADER_SIZE = 16,
  ITERATE_KIT_WIFI_SSID_CAPACITY = 33,
  ITERATE_KIT_WIFI_PASSWORD_CAPACITY = 65,
  ITERATE_KIT_OS_BASE_URL_CAPACITY = 129,
  ITERATE_KIT_PROJECT_ID_CAPACITY = 65,
  ITERATE_KIT_PROJECT_API_KEY_CAPACITY = 129,
  ITERATE_KIT_ITX_WEBSOCKET_URL_CAPACITY =
      ITERATE_KIT_OS_BASE_URL_CAPACITY + 2,
  ITERATE_KIT_PCM_WEBSOCKET_URL_CAPACITY =
      ITERATE_KIT_OS_BASE_URL_CAPACITY + 2,
};

/**
 * Fixed-capacity, NUL-terminated boot configuration. The decoder allocates no
 * memory and clears every field on every error, so callers never observe a
 * partially decoded credential set. Treat these fields as secrets: this type
 * provides integrity/shape validation, not encryption or authentication of the
 * flash image.
 */
struct iterate_kit_configuration {
  char wifi_ssid[ITERATE_KIT_WIFI_SSID_CAPACITY];
  char wifi_password[ITERATE_KIT_WIFI_PASSWORD_CAPACITY];
  char os_base_url[ITERATE_KIT_OS_BASE_URL_CAPACITY];
  char project_id[ITERATE_KIT_PROJECT_ID_CAPACITY];
  char project_api_key[ITERATE_KIT_PROJECT_API_KEY_CAPACITY];
};

enum iterate_kit_configuration_error {
  ITERATE_KIT_CONFIGURATION_OK = 0,
  ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT,
  ITERATE_KIT_CONFIGURATION_TRUNCATED,
  ITERATE_KIT_CONFIGURATION_INVALID_MAGIC,
  ITERATE_KIT_CONFIGURATION_UNSUPPORTED_VERSION,
  ITERATE_KIT_CONFIGURATION_CHECKSUM_MISMATCH,
  ITERATE_KIT_CONFIGURATION_MALFORMED_FIELD,
  ITERATE_KIT_CONFIGURATION_DUPLICATE_FIELD,
  ITERATE_KIT_CONFIGURATION_FIELD_TOO_LONG,
  ITERATE_KIT_CONFIGURATION_MISSING_FIELD,
  ITERATE_KIT_CONFIGURATION_INVALID_VALUE,
};

/**
 * Decodes one complete ITERKIT1 image (declared payload plus optional erased
 * partition padding). Unknown TLV tags are skipped for forward compatibility;
 * duplicate known tags and every malformed/truncated field are rejected.
 *
 * `image` is borrowed only during the call. On success every value has been
 * copied into `configuration`; on any failure the whole destination is zeroed.
 */
enum iterate_kit_configuration_error iterate_kit_configuration_decode(
    struct iterate_kit_configuration *configuration,
    const uint8_t *image,
    size_t image_size);

/**
 * Converts a validated HTTP(S) OS base URL to the corresponding WS(S) `/api`
 * endpoint in caller-owned storage. The destination is cleared on error.
 * Source and destination may not alias because an in-place prefix contraction
 * would make partial failure semantics ambiguous.
 */
enum iterate_kit_configuration_error
iterate_kit_configuration_build_itx_websocket_url(
    const char *os_base_url,
    char *destination,
    size_t destination_capacity);

/**
 * Converts a validated HTTP(S) OS base URL to the corresponding WS(S) `/pcm`
 * endpoint in caller-owned storage. This stays separate from the Cap'n Web
 * endpoint because realtime PCM has its own binary protocol and lifecycle.
 */
enum iterate_kit_configuration_error
iterate_kit_configuration_build_pcm_websocket_url(
    const char *os_base_url,
    char *destination,
    size_t destination_capacity);

const char *iterate_kit_configuration_error_name(
    enum iterate_kit_configuration_error error);

#ifdef __cplusplus
}
#endif

#endif
