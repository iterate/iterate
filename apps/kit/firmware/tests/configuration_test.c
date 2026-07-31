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
 * pin the complete credential set. The 424-byte gate is permanent device RAM,
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
      "https://os.iterate.com") == 0);
  /*
   * Images flashed before the lane split do not carry tag 6. Falling back to
   * the OS origin preserves local single-server rigs while every new
   * production image pins the userspace PCM origin explicitly.
   */
  CHECK(strcmp(
      configuration.pcm_base_url,
      "https://os.iterate.com") == 0);
  CHECK(strcmp(configuration.project_id, "prj_voice_lab") == 0);
  CHECK(strcmp(configuration.project_api_key, "itxk_secret") == 0);
  CHECK(sizeof(configuration) <= 553U);
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
 * Cap'n Web control traffic and high-volume PCM deliberately use independent
 * sockets: a large audio frame must never head-of-line block capabilities,
 * reconnect, or diagnostics. Pin `/pcm` separately from `/api` so a future URL
 * refactor cannot silently merge the lanes and reintroduce that coupling.
 */
static void builds_the_independent_pcm_websocket_endpoint(void) {
  char endpoint[ITERATE_KIT_PCM_WEBSOCKET_URL_CAPACITY];

  CHECK(iterate_kit_configuration_build_pcm_websocket_url(
      "https://os.iterate.com", endpoint, sizeof(endpoint)) ==
      ITERATE_KIT_CONFIGURATION_OK);
  CHECK(strcmp(endpoint, "wss://os.iterate.com/pcm") == 0);

  CHECK(iterate_kit_configuration_build_pcm_websocket_url(
      "http://localhost:8787", endpoint, sizeof(endpoint)) ==
      ITERATE_KIT_CONFIGURATION_OK);
  CHECK(strcmp(endpoint, "ws://localhost:8787/pcm") == 0);
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

int main(void) {
  decodes_the_typescript_golden_image();
  classifies_corruption_without_partial_credentials();
  rejects_truncated_and_wrong_version_images();
  builds_the_itx_websocket_endpoint_without_allocation();
  builds_the_independent_pcm_websocket_endpoint();
  rejects_invalid_or_truncated_itx_websocket_endpoints();
  return 0;
}
