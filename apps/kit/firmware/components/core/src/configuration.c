#include "iterate/kit/configuration.h"

#include <stdbool.h>
#include <string.h>

/*
 * The flashing page and CLI write the same small versioned TLV image. Firmware
 * treats flash as untrusted: interrupted writes, stale tools, and accidental
 * corruption must yield one classified boot error, never a partially usable
 * mixture of credentials. Decoding is allocation-free and transactional from
 * the caller's perspective: every failure clears the entire destination.
 *
 * CRC32 detects transfer/storage corruption; it is not a MAC and does not make
 * a project key safe against someone who can read or rewrite flash. Device-
 * scoped OAuth credentials can replace the project secret later without
 * changing the bounded container/parser.
 */
enum {
  CONFIGURATION_FIELD_HEADER_SIZE = 3,
  CONFIGURATION_FIELD_WIFI_SSID = 1,
  CONFIGURATION_FIELD_WIFI_PASSWORD = 2,
  CONFIGURATION_FIELD_OS_BASE_URL = 3,
  CONFIGURATION_FIELD_PROJECT_ID = 4,
  CONFIGURATION_FIELD_PROJECT_API_KEY = 5,
};

static const uint8_t configuration_magic_prefix[] = {
  'I', 'T', 'E', 'R', 'K', 'I', 'T',
};

static uint32_t read_u32_le(const uint8_t *bytes) {
  return (uint32_t)bytes[0] |
      ((uint32_t)bytes[1] << 8U) |
      ((uint32_t)bytes[2] << 16U) |
      ((uint32_t)bytes[3] << 24U);
}

static uint16_t read_u16_le(const uint8_t *bytes) {
  return (uint16_t)((uint16_t)bytes[0] |
      ((uint16_t)bytes[1] << 8U));
}

static uint32_t configuration_crc32(
    const uint8_t *bytes, size_t length) {
  /*
   * Use the standard reflected CRC-32 polynomial explicitly rather than
   * depending on a platform peripheral/library. This keeps the image format
   * byte-for-byte identical in browser/CLI host tests and on every ESP target;
   * configuration images are tiny enough that a table would waste flash.
   */
  uint32_t crc = UINT32_C(0xffffffff);
  size_t index;
  for (index = 0U; index < length; ++index) {
    unsigned int bit;
    crc ^= bytes[index];
    for (bit = 0U; bit < 8U; ++bit) {
      const uint32_t least_significant_bit = crc & UINT32_C(1);
      crc = (crc >> 1U) ^
          (least_significant_bit != 0U
              ? UINT32_C(0xedb88320)
              : UINT32_C(0));
    }
  }
  return crc ^ UINT32_C(0xffffffff);
}

static enum iterate_kit_configuration_error fail(
    struct iterate_kit_configuration *configuration,
    enum iterate_kit_configuration_error error) {
  if (configuration != NULL) {
    /*
     * Credentials are an all-or-nothing set. Leaving fields decoded before a
     * bad trailing TLV would invite callers to accidentally connect with a
     * stale/partial identity and makes postmortems depend on parser position.
     */
    memset(configuration, 0, sizeof(*configuration));
  }
  return error;
}

static enum iterate_kit_configuration_error copy_field(
    char *destination,
    size_t capacity,
    const uint8_t *value,
    size_t length,
    bool allow_empty) {
  if ((!allow_empty && length == 0U) ||
      memchr(value, '\0', length) != NULL) {
    /*
     * Embedded NULs would make validation and later C-string consumers see
     * different values. Open Wi-Fi is the sole deliberately empty known field;
     * every identity/endpoint must remain non-empty.
     */
    return ITERATE_KIT_CONFIGURATION_INVALID_VALUE;
  }
  if (length >= capacity) {
    return ITERATE_KIT_CONFIGURATION_FIELD_TOO_LONG;
  }
  memcpy(destination, value, length);
  destination[length] = '\0';
  return ITERATE_KIT_CONFIGURATION_OK;
}

static bool valid_base_url(const char *value) {
  const char *host;
  const char *cursor;
  if (strncmp(value, "https://", sizeof("https://") - 1U) == 0) {
    host = value + sizeof("https://") - 1U;
  } else if (strncmp(
                 value, "http://", sizeof("http://") - 1U) == 0) {
    host = value + sizeof("http://") - 1U;
  } else {
    return false;
  }
  if (*host == '\0') {
    return false;
  }
  for (cursor = host; *cursor != '\0'; ++cursor) {
    const unsigned char character = (unsigned char)*cursor;
    if (character <= 0x20U ||
        character >= 0x7fU ||
        *cursor == '/' ||
        *cursor == '\\' ||
        *cursor == '@' ||
        *cursor == '?' ||
        *cursor == '#') {
      /*
       * Store only an origin-like base. Allowing paths, userinfo, fragments, or
       * escaped control characters would make fixed `/api` endpoint
       * construction ambiguous and could redirect credentials unexpectedly.
       */
      return false;
    }
  }
  return true;
}

static bool valid_project_id(const char *value) {
  const char *cursor;
  if (strncmp(value, "prj_", sizeof("prj_") - 1U) != 0 ||
      value[sizeof("prj_") - 1U] == '\0') {
    return false;
  }
  for (cursor = value + sizeof("prj_") - 1U;
       *cursor != '\0';
       ++cursor) {
    const bool alpha_numeric =
        (*cursor >= 'a' && *cursor <= 'z') ||
        (*cursor >= 'A' && *cursor <= 'Z') ||
        (*cursor >= '0' && *cursor <= '9');
    if (!alpha_numeric && *cursor != '_' && *cursor != '-') {
      return false;
    }
  }
  return true;
}

static enum iterate_kit_configuration_error build_websocket_url(
    const char *os_base_url,
    const char *suffix,
    char *destination,
    size_t destination_capacity) {
  static const char secure_http_prefix[] = "https://";
  static const char insecure_http_prefix[] = "http://";
  static const char secure_websocket_prefix[] = "wss://";
  static const char insecure_websocket_prefix[] = "ws://";
  const char *host;
  const char *websocket_prefix;
  size_t websocket_prefix_size;
  size_t host_size;
  size_t suffix_size;
  size_t required_size;

  if (destination != NULL && destination_capacity > 0U) {
    /*
     * Clearing first is a deliberate failure contract: callers can log/use the
     * error without also remembering whether a previous successful URL remains
     * in this reusable boot buffer.
     */
    destination[0] = '\0';
  }
  if (os_base_url == NULL ||
      suffix == NULL ||
      destination == NULL ||
      destination_capacity == 0U ||
      os_base_url == destination) {
    return ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT;
  }
  if (!valid_base_url(os_base_url)) {
    return ITERATE_KIT_CONFIGURATION_INVALID_VALUE;
  }
  if (strncmp(
          os_base_url,
          secure_http_prefix,
          sizeof(secure_http_prefix) - 1U) == 0) {
    host = os_base_url + sizeof(secure_http_prefix) - 1U;
    websocket_prefix = secure_websocket_prefix;
    websocket_prefix_size =
        sizeof(secure_websocket_prefix) - 1U;
  } else {
    host = os_base_url + sizeof(insecure_http_prefix) - 1U;
    websocket_prefix = insecure_websocket_prefix;
    websocket_prefix_size =
        sizeof(insecure_websocket_prefix) - 1U;
  }
  host_size = strlen(host);
  suffix_size = strlen(suffix);
  if (host_size >
      SIZE_MAX - websocket_prefix_size - suffix_size - 1U) {
    /* Preserve the bound even on hosts where size_t is narrower/unusual. */
    return ITERATE_KIT_CONFIGURATION_FIELD_TOO_LONG;
  }
  required_size =
      websocket_prefix_size + host_size + suffix_size + 1U;
  if (required_size > destination_capacity) {
    return ITERATE_KIT_CONFIGURATION_FIELD_TOO_LONG;
  }

  memcpy(
      destination, websocket_prefix, websocket_prefix_size);
  memcpy(
      destination + websocket_prefix_size, host, host_size);
  memcpy(
      destination + websocket_prefix_size + host_size,
      suffix,
      suffix_size + 1U);
  return ITERATE_KIT_CONFIGURATION_OK;
}

enum iterate_kit_configuration_error
iterate_kit_configuration_build_itx_websocket_url(
    const char *os_base_url,
    char *destination,
    size_t destination_capacity) {
  return build_websocket_url(
      os_base_url, "/api", destination, destination_capacity);
}

enum iterate_kit_configuration_error iterate_kit_configuration_decode(
    struct iterate_kit_configuration *configuration,
    const uint8_t *image,
    size_t image_size) {
  uint32_t expected_crc;
  uint32_t payload_size_u32;
  const uint8_t *payload;
  size_t payload_size;
  size_t offset = 0U;
  uint32_t seen_fields = 0U;
  const uint32_t required_fields =
      (UINT32_C(1) << CONFIGURATION_FIELD_WIFI_SSID) |
      (UINT32_C(1) << CONFIGURATION_FIELD_WIFI_PASSWORD) |
      (UINT32_C(1) << CONFIGURATION_FIELD_OS_BASE_URL) |
      (UINT32_C(1) << CONFIGURATION_FIELD_PROJECT_ID) |
      (UINT32_C(1) << CONFIGURATION_FIELD_PROJECT_API_KEY);

  if (configuration == NULL || image == NULL) {
    return fail(
        configuration,
        ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT);
  }
  memset(configuration, 0, sizeof(*configuration));
  if (image_size < ITERATE_KIT_CONFIGURATION_HEADER_SIZE) {
    return fail(
        configuration, ITERATE_KIT_CONFIGURATION_TRUNCATED);
  }
  if (memcmp(
          image,
          configuration_magic_prefix,
          sizeof(configuration_magic_prefix)) != 0) {
    return fail(
        configuration, ITERATE_KIT_CONFIGURATION_INVALID_MAGIC);
  }
  if (image[sizeof(configuration_magic_prefix)] != '1') {
    return fail(
        configuration,
        ITERATE_KIT_CONFIGURATION_UNSUPPORTED_VERSION);
  }

  payload_size_u32 = read_u32_le(image + 8U);
  payload_size = (size_t)payload_size_u32;
  if (payload_size >
      image_size - ITERATE_KIT_CONFIGURATION_HEADER_SIZE) {
    return fail(
        configuration, ITERATE_KIT_CONFIGURATION_TRUNCATED);
  }
  payload = image + ITERATE_KIT_CONFIGURATION_HEADER_SIZE;
  /*
   * Verify the declared payload before interpreting a single field. That
   * ordering ensures random corruption cannot steer parser branches or leave
   * briefly accepted credentials, and permits erased partition padding after
   * the payload without including it in integrity checks.
   */
  expected_crc = read_u32_le(image + 12U);
  if (configuration_crc32(payload, payload_size) != expected_crc) {
    return fail(
        configuration,
        ITERATE_KIT_CONFIGURATION_CHECKSUM_MISMATCH);
  }

  while (offset < payload_size) {
    uint8_t field;
    uint16_t field_size_u16;
    size_t field_size;
    const uint8_t *value;
    char *destination = NULL;
    size_t capacity = 0U;
    bool allow_empty = false;
    enum iterate_kit_configuration_error copy_error;

    if (payload_size - offset < CONFIGURATION_FIELD_HEADER_SIZE) {
      return fail(
          configuration,
          ITERATE_KIT_CONFIGURATION_MALFORMED_FIELD);
    }
    field = payload[offset];
    field_size_u16 = read_u16_le(payload + offset + 1U);
    field_size = (size_t)field_size_u16;
    offset += CONFIGURATION_FIELD_HEADER_SIZE;
    if (field_size > payload_size - offset) {
      return fail(
          configuration,
          ITERATE_KIT_CONFIGURATION_MALFORMED_FIELD);
    }
    value = payload + offset;
    offset += field_size;

    switch (field) {
      case CONFIGURATION_FIELD_WIFI_SSID:
        destination = configuration->wifi_ssid;
        capacity = sizeof(configuration->wifi_ssid);
        break;
      case CONFIGURATION_FIELD_WIFI_PASSWORD:
        destination = configuration->wifi_password;
        capacity = sizeof(configuration->wifi_password);
        allow_empty = true;
        break;
      case CONFIGURATION_FIELD_OS_BASE_URL:
        destination = configuration->os_base_url;
        capacity = sizeof(configuration->os_base_url);
        break;
      case CONFIGURATION_FIELD_PROJECT_ID:
        destination = configuration->project_id;
        capacity = sizeof(configuration->project_id);
        break;
      case CONFIGURATION_FIELD_PROJECT_API_KEY:
        destination = configuration->project_api_key;
        capacity = sizeof(configuration->project_api_key);
        break;
      default:
        /*
         * Unknown tags are length-delimited and integrity-protected, so older
         * firmware can safely ignore fields introduced by newer flash tools.
         * Known duplicates remain errors because "first wins" versus "last
         * wins" would create inconsistent credential interpretation.
         */
        continue;
    }

    if ((seen_fields & (UINT32_C(1) << field)) != 0U) {
      return fail(
          configuration,
          ITERATE_KIT_CONFIGURATION_DUPLICATE_FIELD);
    }
    seen_fields |= UINT32_C(1) << field;
    copy_error = copy_field(
        destination, capacity, value, field_size, allow_empty);
    if (copy_error != ITERATE_KIT_CONFIGURATION_OK) {
      return fail(configuration, copy_error);
    }
  }

  if ((seen_fields & required_fields) != required_fields) {
    return fail(
        configuration,
        ITERATE_KIT_CONFIGURATION_MISSING_FIELD);
  }
  if (!valid_base_url(configuration->os_base_url) ||
      !valid_project_id(configuration->project_id)) {
    return fail(
        configuration,
        ITERATE_KIT_CONFIGURATION_INVALID_VALUE);
  }
  return ITERATE_KIT_CONFIGURATION_OK;
}
