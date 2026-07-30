#include "iterate/kit/platforms/esp_idf_configuration.h"

#include "esp_partition.h"

#include <stddef.h>
#include <string.h>

/*
 * ESP-IDF binding for the provisioning image written by the shared CLI/web
 * flasher. Configuration is intentionally a raw custom partition rather than
 * NVS keys or a filesystem: both flashing surfaces can install one
 * versioned/CRC-protected blob, firmware can validate it with the same portable
 * decoder, and boot needs no per-field heap allocations.
 *
 * Mapping avoids a partition-sized RAM copy. The portable decoder copies only
 * validated fields into fixed-capacity caller storage, after which the mapping
 * is immediately released. Every failure leaves the destination zeroed because
 * stale Wi-Fi credentials or a stale project secret are more dangerous than a
 * loud, classifiable "needs provisioning" boot.
 */
enum {
  /*
   * Type, subtype, and label are a wire/flash ABI shared with the partition
   * table and flashing library. They are kept here explicitly instead of using
   * an application partition enum that might change their numeric identity.
   */
  ITERATE_KIT_PARTITION_TYPE = 0x40,
  ITERATE_KIT_PARTITION_SUBTYPE = 0x00,
};

static const char iterate_kit_partition_label[] = "iterate_kit";

static struct iterate_kit_esp_configuration_result result(
    enum iterate_kit_esp_configuration_status status,
    enum iterate_kit_configuration_error configuration_error,
    int32_t platform_error) {
  const struct iterate_kit_esp_configuration_result value = {
    status,
    configuration_error,
    platform_error,
  };
  return value;
}

struct iterate_kit_esp_configuration_result
iterate_kit_esp_read_configuration(
    struct iterate_kit_configuration *configuration) {
  const esp_partition_t *partition;
  const void *mapped_image = NULL;
  esp_partition_mmap_handle_t mapping = 0U;
  esp_err_t map_error;
  enum iterate_kit_configuration_error decode_error;

  if (configuration == NULL) {
    return result(
        ITERATE_KIT_ESP_CONFIGURATION_INVALID_ARGUMENT,
        ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT,
        0);
  }
  /*
   * Clear before partition discovery, not merely before decode. That makes all
   * platform failures obey the same secret-erasure postcondition and prevents
   * callers from accidentally continuing with a previous successful read.
   */
  memset(configuration, 0, sizeof(*configuration));
  partition = esp_partition_find_first(
      (esp_partition_type_t)ITERATE_KIT_PARTITION_TYPE,
      (esp_partition_subtype_t)ITERATE_KIT_PARTITION_SUBTYPE,
      iterate_kit_partition_label);
  if (partition == NULL) {
    return result(
        ITERATE_KIT_ESP_CONFIGURATION_PARTITION_NOT_FOUND,
        ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT,
        0);
  }
  if (partition->size < ITERATE_KIT_CONFIGURATION_HEADER_SIZE) {
    return result(
        ITERATE_KIT_ESP_CONFIGURATION_PARTITION_TOO_SMALL,
        ITERATE_KIT_CONFIGURATION_TRUNCATED,
        0);
  }

  map_error = esp_partition_mmap(
      partition,
      0U,
      partition->size,
      ESP_PARTITION_MMAP_DATA,
      &mapped_image,
      &mapping);
  if (map_error != ESP_OK || mapped_image == NULL) {
    return result(
        ITERATE_KIT_ESP_CONFIGURATION_MMAP_FAILED,
        ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT,
        (int32_t)map_error);
  }

  /*
   * The mapping covers the fixed partition because the encoded image carries
   * its own length and CRC. The decoder never treats erased trailing flash as a
   * field. This saves a preliminary copy/read while retaining strict bounds
   * checking in one portable implementation.
   */
  decode_error = iterate_kit_configuration_decode(
      configuration,
      mapped_image,
      partition->size);
  esp_partition_munmap(mapping);
  if (decode_error != ITERATE_KIT_CONFIGURATION_OK) {
    return result(
        ITERATE_KIT_ESP_CONFIGURATION_DECODE_FAILED,
        decode_error,
        0);
  }
  return result(
      ITERATE_KIT_ESP_CONFIGURATION_OK,
      ITERATE_KIT_CONFIGURATION_OK,
      0);
}

const char *iterate_kit_esp_configuration_status_name(
    enum iterate_kit_esp_configuration_status status) {
  switch (status) {
    case ITERATE_KIT_ESP_CONFIGURATION_OK:
      return "ok";
    case ITERATE_KIT_ESP_CONFIGURATION_INVALID_ARGUMENT:
      return "invalid argument";
    case ITERATE_KIT_ESP_CONFIGURATION_PARTITION_NOT_FOUND:
      return "partition not found";
    case ITERATE_KIT_ESP_CONFIGURATION_PARTITION_TOO_SMALL:
      return "partition too small";
    case ITERATE_KIT_ESP_CONFIGURATION_MMAP_FAILED:
      return "flash map failed";
    case ITERATE_KIT_ESP_CONFIGURATION_DECODE_FAILED:
      return "decode failed";
  }
  return "unknown ESP configuration status";
}
