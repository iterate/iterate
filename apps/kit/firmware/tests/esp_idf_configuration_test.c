#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "configuration_fixture.h"

#include "esp_partition.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      fprintf(stderr, "%s:%d: check failed: %s\n",                         \
          __FILE__, __LINE__, #condition);                                   \
      abort();                                                               \
    }                                                                        \
  } while (0)

static esp_partition_t fake_partition;
static const uint8_t *mapped_image;
static bool partition_available;
static esp_err_t mmap_error;
static size_t mmap_count;
static size_t munmap_count;

const esp_partition_t *esp_partition_find_first(
    esp_partition_type_t type,
    esp_partition_subtype_t subtype,
    const char *label) {
  CHECK((int)type == 0x40);
  CHECK((int)subtype == 0x00);
  CHECK(strcmp(label, "iterate_kit") == 0);
  return partition_available ? &fake_partition : NULL;
}

esp_err_t esp_partition_mmap(
    const esp_partition_t *partition,
    size_t offset,
    size_t size,
    esp_partition_mmap_memory_t memory,
    const void **out_ptr,
    esp_partition_mmap_handle_t *out_handle) {
  CHECK(partition == &fake_partition);
  CHECK(offset == 0U);
  CHECK(size == fake_partition.size);
  CHECK(memory == ESP_PARTITION_MMAP_DATA);
  mmap_count++;
  if (mmap_error != ESP_OK) {
    return mmap_error;
  }
  *out_ptr = mapped_image;
  *out_handle = 7U;
  return ESP_OK;
}

void esp_partition_munmap(esp_partition_mmap_handle_t handle) {
  CHECK(handle == 7U);
  munmap_count++;
}

static void reset_fake(void) {
  memset(&fake_partition, 0, sizeof(fake_partition));
  fake_partition.size = sizeof(iterate_kit_test_configuration_image);
  mapped_image = iterate_kit_test_configuration_image;
  partition_available = true;
  mmap_error = ESP_OK;
  mmap_count = 0U;
  munmap_count = 0U;
}

/*
 * Provisioning is stored as a raw flash image so firmware startup can decode it
 * without a filesystem or heap allocation. ESP-IDF mappings are borrowed
 * address-space resources, not owned buffers: even a successful decode must
 * release the handle exactly once after copying the bounded credentials.
 */
static void reads_and_unmaps_the_raw_configuration_partition(void) {
  struct iterate_kit_configuration configuration;
  reset_fake();

  const struct iterate_kit_esp_configuration_result result =
      iterate_kit_esp_read_configuration(&configuration);

  CHECK(result.status == ITERATE_KIT_ESP_CONFIGURATION_OK);
  CHECK(
      result.configuration_error ==
      ITERATE_KIT_CONFIGURATION_OK);
  CHECK(result.platform_error == ESP_OK);
  CHECK(strcmp(configuration.wifi_ssid, "studio") == 0);
  CHECK(strcmp(configuration.project_id, "prj_voice_lab") == 0);
  CHECK(mmap_count == 1U);
  CHECK(munmap_count == 1U);
}

/*
 * A missing partition is an unprovisioned device; an mmap failure is a
 * platform incident. Neither may leave caller-owned bytes from a previous boot
 * looking like valid Wi-Fi or project secrets. Only a successful map owns a
 * handle, so the failure paths must also avoid a fictitious unmap.
 */
static void classifies_missing_and_unmappable_partitions(void) {
  struct iterate_kit_configuration configuration;
  struct iterate_kit_esp_configuration_result result;
  reset_fake();
  memset(&configuration, 0xa5, sizeof(configuration));
  partition_available = false;

  result = iterate_kit_esp_read_configuration(&configuration);
  CHECK(
      result.status ==
      ITERATE_KIT_ESP_CONFIGURATION_PARTITION_NOT_FOUND);
  CHECK(configuration.wifi_ssid[0] == '\0');
  CHECK(mmap_count == 0U);
  CHECK(munmap_count == 0U);

  reset_fake();
  memset(&configuration, 0xa5, sizeof(configuration));
  mmap_error = 0x1234;
  result = iterate_kit_esp_read_configuration(&configuration);
  CHECK(result.status == ITERATE_KIT_ESP_CONFIGURATION_MMAP_FAILED);
  CHECK(result.platform_error == 0x1234);
  CHECK(configuration.project_api_key[0] == '\0');
  CHECK(mmap_count == 1U);
  CHECK(munmap_count == 0U);
}

/*
 * Corrupt flash is discovered only after mapping. Decode failure must wipe
 * partial credentials and still release the mapping; returning early here on
 * the attractive “invalid input” path would leak one scarce mapping on every
 * retry and eventually turn a clear provisioning error into resource drift.
 */
static void always_unmaps_a_malformed_image(void) {
  static const uint8_t invalid_image[16] = {0};
  struct iterate_kit_configuration configuration;
  reset_fake();
  mapped_image = invalid_image;
  fake_partition.size = sizeof(invalid_image);

  const struct iterate_kit_esp_configuration_result result =
      iterate_kit_esp_read_configuration(&configuration);

  CHECK(result.status == ITERATE_KIT_ESP_CONFIGURATION_DECODE_FAILED);
  CHECK(
      result.configuration_error ==
      ITERATE_KIT_CONFIGURATION_INVALID_MAGIC);
  CHECK(mmap_count == 1U);
  CHECK(munmap_count == 1U);
  CHECK(configuration.wifi_password[0] == '\0');
}

/*
 * The decoder needs a complete fixed header before it can even establish image
 * length or checksum bounds. Reject an undersized partition before mapping so
 * a malformed partition table cannot induce an out-of-bounds header read. No
 * map means no cleanup obligation.
 */
static void rejects_a_partition_smaller_than_the_header_without_mapping(void) {
  struct iterate_kit_configuration configuration;
  reset_fake();
  fake_partition.size = ITERATE_KIT_CONFIGURATION_HEADER_SIZE - 1U;

  const struct iterate_kit_esp_configuration_result result =
      iterate_kit_esp_read_configuration(&configuration);

  CHECK(
      result.status ==
      ITERATE_KIT_ESP_CONFIGURATION_PARTITION_TOO_SMALL);
  CHECK(
      result.configuration_error ==
      ITERATE_KIT_CONFIGURATION_TRUNCATED);
  CHECK(mmap_count == 0U);
  CHECK(munmap_count == 0U);
}

int main(void) {
  reads_and_unmaps_the_raw_configuration_partition();
  classifies_missing_and_unmappable_partitions();
  always_unmaps_a_malformed_image();
  rejects_a_partition_smaller_than_the_header_without_mapping();
  return 0;
}
