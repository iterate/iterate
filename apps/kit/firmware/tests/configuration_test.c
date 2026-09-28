#include "iterate/kit/configuration.h"
#include "configuration_fixture.h"

#include <stdint.h>
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

/*
 * The browser/CLI flasher writes this image with TypeScript and firmware reads
 * it with C, so neither implementation's round-trip test can prove wire
 * compatibility alone. Decode the checked-in cross-language golden image and
 * pin the complete credential set. The size gate is permanent device RAM,
 * not cosmetic struct size: growing it must be an explicit firmware budget
 * decision rather than accidental padding or field creep.
 */
static void decodes_the_typescript_golden_image(void) {
  struct iterate_kit_configuration configuration;
  const enum iterate_kit_configuration_error error =
      iterate_kit_configuration_decode(
          &configuration,
          iterate_kit_test_configuration_image,
          sizeof(iterate_kit_test_configuration_image));

  CHECK(error == ITERATE_KIT_CONFIGURATION_OK);
  CHECK(strcmp(configuration.wifi_ssid, "studio") == 0);
  CHECK(strcmp(
      configuration.wifi_password,
      "correct horse battery staple") == 0);
  CHECK(strcmp(
      configuration.os_base_url,
      "https://os.iterate2.com") == 0);
  CHECK(strcmp(configuration.project_id, "prj_voice_lab") == 0);
  CHECK(strcmp(configuration.project_api_key, "itxk_secret") == 0);
  CHECK(sizeof(configuration) <= 424U);
}

/*
 * A checksum failure can happen after several length-prefixed fields have
 * already parsed. Returning those partial values would mix old/corrupt Wi-Fi
 * and bearer credentials into a plausible connection attempt. Fail closed by
 * clearing every secret-bearing field, rather than relying on each caller to
 * remember which decoder errors may have written a prefix.
 */
static void classifies_corruption_without_partial_credentials(void) {
  uint8_t corrupted[sizeof(iterate_kit_test_configuration_image)];
  struct iterate_kit_configuration configuration;
  memcpy(
      corrupted,
      iterate_kit_test_configuration_image,
      sizeof(corrupted));
  corrupted[sizeof(corrupted) - 1U] ^= 1U;
  memset(&configuration, 0xa5, sizeof(configuration));

  CHECK(iterate_kit_configuration_decode(
      &configuration, corrupted, sizeof(corrupted)) ==
      ITERATE_KIT_CONFIGURATION_CHECKSUM_MISMATCH);
  CHECK(configuration.wifi_ssid[0] == '\0');
  CHECK(configuration.wifi_password[0] == '\0');
  CHECK(configuration.os_base_url[0] == '\0');
  CHECK(configuration.project_id[0] == '\0');
  CHECK(configuration.project_api_key[0] == '\0');
}

/*
 * A partly flashed image and a deliberately newer image require different
 * operator actions: retry flashing versus upgrade firmware. Preserve that
 * distinction at the decoder boundary instead of collapsing both into a
 * generic parse error that would make provisioning failures unactionable.
 */
static void rejects_truncated_and_wrong_version_images(void) {
  uint8_t wrong_magic[sizeof(iterate_kit_test_configuration_image)];
  struct iterate_kit_configuration configuration;
  memcpy(
      wrong_magic,
      iterate_kit_test_configuration_image,
      sizeof(wrong_magic));
  wrong_magic[7] = '2';

  CHECK(iterate_kit_configuration_decode(
      &configuration, iterate_kit_test_configuration_image, 15U) ==
      ITERATE_KIT_CONFIGURATION_TRUNCATED);
  CHECK(iterate_kit_configuration_decode(
      &configuration, wrong_magic, sizeof(wrong_magic)) ==
      ITERATE_KIT_CONFIGURATION_UNSUPPORTED_VERSION);
}

/*
 * The control connection is created during boot and reconnect storms, where a
 * heap-building URL helper would add fragmentation and another failure mode.
 * Convert only the transport scheme into a caller-sized fixed buffer and prove
 * both production TLS and local cleartext development forms.
 *
 * THE PATH IS `/api`: the OS's public endpoint, whose OAuth gate resolves the
 * `Authorization: Bearer` the transport sends on the upgrade (the blob's key,
 * a personal access token). The endpoint is four bytes longer than the base
 * URL.
 */
static void builds_the_itx_websocket_endpoint_without_allocation(void) {
  char endpoint[ITERATE_KIT_ITX_WEBSOCKET_URL_CAPACITY];

  CHECK(iterate_kit_configuration_build_itx_websocket_url(
      "https://os.iterate.com", endpoint, sizeof(endpoint)) ==
      ITERATE_KIT_CONFIGURATION_OK);
  CHECK(strcmp(endpoint, "wss://os.iterate.com/api") == 0);

  CHECK(iterate_kit_configuration_build_itx_websocket_url(
      "http://localhost:8787", endpoint, sizeof(endpoint)) ==
      ITERATE_KIT_CONFIGURATION_OK);
  CHECK(strcmp(endpoint, "ws://localhost:8787/api") == 0);
}

/*
 * Truncating an endpoint would often leave a syntactically plausible hostname,
 * and preserving an old output buffer after validation failure could connect
 * with stale authority. Reject non-origin base URLs and insufficient capacity,
 * then zero the destination so callers cannot accidentally use either result.
 */
static void rejects_invalid_or_truncated_itx_websocket_endpoints(void) {
  char endpoint[8];
  memset(endpoint, 0xa5, sizeof(endpoint));

  CHECK(iterate_kit_configuration_build_itx_websocket_url(
      "https://os.iterate.com", endpoint, sizeof(endpoint)) ==
      ITERATE_KIT_CONFIGURATION_FIELD_TOO_LONG);
  CHECK(endpoint[0] == '\0');

  endpoint[0] = 'x';
  CHECK(iterate_kit_configuration_build_itx_websocket_url(
      "https://os.iterate.com/path", endpoint, sizeof(endpoint)) ==
      ITERATE_KIT_CONFIGURATION_INVALID_VALUE);
  CHECK(endpoint[0] == '\0');
}

/*
 * A BLOB A BOARD IS FLASHED WITH: a project reference with no `prj_` prefix,
 * and a key running to the field's full 128 bytes. Refusing either is a board
 * that reads its own partition, rejects it, never dials, and from outside
 * looks dead.
 */
static void decodes_the_flashed_image_with_an_unprefixed_project_and_a_full_length_key(void) {
  struct iterate_kit_configuration configuration;
  char key[ITERATE_KIT_PROJECT_API_KEY_CAPACITY];
  size_t index;
  const enum iterate_kit_configuration_error error =
      iterate_kit_configuration_decode(
          &configuration,
          iterate_kit_test_flashed_configuration_image,
          sizeof(iterate_kit_test_flashed_configuration_image));

  for (index = 0U; index + 1U < sizeof(key); ++index) key[index] = 'k';
  key[sizeof(key) - 1U] = '\0';

  CHECK(error == ITERATE_KIT_CONFIGURATION_OK);
  CHECK(strcmp(configuration.os_base_url, "https://os.iterate2.com") == 0);
  CHECK(strcmp(configuration.project_id, "prj-voice") == 0);
  CHECK(strlen(configuration.project_api_key) ==
      ITERATE_KIT_PROJECT_API_KEY_CAPACITY - 1U);
  CHECK(strcmp(configuration.project_api_key, key) == 0);
}

/* The golden image with a status-voice field appended, its checksum redone. */
static size_t with_status_voice(uint8_t *out, size_t capacity, const char *name) {
  const size_t golden = sizeof(iterate_kit_test_configuration_image);
  const size_t name_length = strlen(name);
  const size_t size = golden + 3U + name_length;
  uint32_t payload_size;
  uint32_t crc = UINT32_C(0xffffffff);
  CHECK(size <= capacity);
  memcpy(out, iterate_kit_test_configuration_image, golden);
  out[golden] = 6U;
  out[golden + 1U] = (uint8_t)name_length;
  out[golden + 2U] = 0U;
  memcpy(out + golden + 3U, name, name_length);
  payload_size = (uint32_t)(size - ITERATE_KIT_CONFIGURATION_HEADER_SIZE);
  for (size_t i = ITERATE_KIT_CONFIGURATION_HEADER_SIZE; i < size; i++) {
    crc ^= out[i];
    for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1U) != 0U ? UINT32_C(0xedb88320) : 0U);
  }
  crc ^= UINT32_C(0xffffffff);
  for (int i = 0; i < 4; i++) {
    out[8 + i] = (uint8_t)(payload_size >> (8 * i));
    out[12 + i] = (uint8_t)(crc >> (8 * i));
  }
  return size;
}

/*
 * The status voice is the one optional field: every image written before it
 * existed has none, and Kit may one day write a name this firmware has never
 * heard of. Neither may cost the board its Wi-Fi and key, so both sing the
 * default rather than failing the whole image.
 */
static void decodes_the_status_voice_and_defaults_what_it_does_not_know(void) {
  uint8_t image[256];
  struct iterate_kit_configuration configuration;

  CHECK(iterate_kit_configuration_decode(
            &configuration, iterate_kit_test_configuration_image,
            sizeof(iterate_kit_test_configuration_image)) == ITERATE_KIT_CONFIGURATION_OK);
  CHECK(configuration.status_voice == ITERATE_KIT_STATUS_VOICE_GREENSLEEVES);

  CHECK(iterate_kit_configuration_decode(
            &configuration, image, with_status_voice(image, sizeof(image), "daisy-bell")) ==
        ITERATE_KIT_CONFIGURATION_OK);
  CHECK(configuration.status_voice == ITERATE_KIT_STATUS_VOICE_DAISY_BELL);
  CHECK(strcmp(configuration.wifi_ssid, "studio") == 0);

  CHECK(iterate_kit_configuration_decode(
            &configuration, image, with_status_voice(image, sizeof(image), "off")) ==
        ITERATE_KIT_CONFIGURATION_OK);
  CHECK(configuration.status_voice == ITERATE_KIT_STATUS_VOICE_OFF);
  CHECK(strcmp(iterate_kit_status_voice_name(ITERATE_KIT_STATUS_VOICE_OFF), "off") == 0);

  CHECK(iterate_kit_configuration_decode(
            &configuration, image, with_status_voice(image, sizeof(image), "sea-shanty")) ==
        ITERATE_KIT_CONFIGURATION_OK);
  CHECK(configuration.status_voice == ITERATE_KIT_STATUS_VOICE_GREENSLEEVES);
  CHECK(strcmp(configuration.project_api_key, "itxk_secret") == 0);
}

int main(void) {
  decodes_the_typescript_golden_image();
  decodes_the_status_voice_and_defaults_what_it_does_not_know();
  decodes_the_flashed_image_with_an_unprefixed_project_and_a_full_length_key();
  classifies_corruption_without_partial_credentials();
  rejects_truncated_and_wrong_version_images();
  builds_the_itx_websocket_endpoint_without_allocation();
  rejects_invalid_or_truncated_itx_websocket_endpoints();
  return 0;
}
