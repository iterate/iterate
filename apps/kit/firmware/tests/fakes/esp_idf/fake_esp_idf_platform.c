#include "fake_esp_idf_platform.h"

#include "fake_esp_idf.h"

#include "esp_system.h"

#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_reset_reason.h"
#include "iterate/kit/platforms/esp_idf_restart_note.h"
#include "iterate/kit/platforms/esp_idf_system_update.h"

#include <stdio.h>
#include <string.h>

/*
 * See fake_esp_idf_platform.h and README.md in this directory.
 */

enum {
  FAKE_SENT_CAPACITY = 32,
  FAKE_MESSAGE_CAPACITY = 4096,
};

static struct {
  struct iterate_kit_esp_idf_itx_transport *transport;
  struct iterate_kit_itx_connection *connection;
  char sent[FAKE_SENT_CAPACITY][FAKE_MESSAGE_CAPACITY];
  size_t sent_lengths[FAKE_SENT_CAPACITY];
  size_t sent_count;
  bool message_open;
  size_t probes_requested;
  size_t restarts_requested;
  bool hop_answers;
  uint32_t pongs;
  char restart_note[128];
} platform;

void iterate_kit_fake_platform_reset(void) {
  memset(&platform, 0, sizeof(platform));
  platform.hop_answers = true;
}

struct iterate_kit_itx_connection *iterate_kit_fake_platform_connection(void) {
  return platform.connection;
}

void iterate_kit_fake_platform_set_state(
    enum iterate_kit_esp_idf_itx_transport_state state) {
  if (platform.transport == NULL) return;
  platform.transport->state = state;
}

void iterate_kit_fake_platform_connect(void) {
  if (platform.connection == NULL) return;
  (void)iterate_kit_itx_connection_open(platform.connection);
  iterate_kit_fake_platform_set_state(ITERATE_KIT_ESP_IDF_ITX_READY);
}

size_t iterate_kit_fake_platform_sent_count(void) { return platform.sent_count; }

const char *iterate_kit_fake_platform_sent(size_t index) {
  if (index >= platform.sent_count) return "";
  return platform.sent[index];
}

const char *iterate_kit_fake_platform_find_sent(const char *needle) {
  size_t index;
  if (needle == NULL) return NULL;
  for (index = 0U; index < platform.sent_count; ++index) {
    if (strstr(platform.sent[index], needle) != NULL) {
      return platform.sent[index];
    }
  }
  return NULL;
}

size_t iterate_kit_fake_platform_probes_requested(void) {
  return platform.probes_requested;
}

size_t iterate_kit_fake_platform_restarts_requested(void) {
  return platform.restarts_requested;
}

void iterate_kit_fake_platform_set_hop_answers(bool answers) {
  platform.hop_answers = answers;
}

/* --- provisioning --------------------------------------------------------- */

/*
 * A PROVISIONED BOARD, because an unprovisioned one returns from init before
 * anything else in the loop runs and every test would be about that.
 */
struct iterate_kit_esp_configuration_result
iterate_kit_esp_read_configuration(
    struct iterate_kit_configuration *configuration) {
  struct iterate_kit_esp_configuration_result result;
  memset(&result, 0, sizeof(result));
  if (configuration == NULL) {
    result.status = ITERATE_KIT_ESP_CONFIGURATION_INVALID_ARGUMENT;
    return result;
  }
  memset(configuration, 0, sizeof(*configuration));
  (void)snprintf(
      configuration->wifi_ssid, sizeof(configuration->wifi_ssid), "%s",
      "fake-network");
  (void)snprintf(
      configuration->wifi_password, sizeof(configuration->wifi_password), "%s",
      "fake-password");
  (void)snprintf(
      configuration->os_base_url, sizeof(configuration->os_base_url), "%s",
      "https://os.example.invalid");
  (void)snprintf(
      configuration->project_id, sizeof(configuration->project_id), "%s",
      "prj_fake");
  (void)snprintf(
      configuration->project_api_key, sizeof(configuration->project_api_key),
      "%s", "itxk_fake");
  result.status = ITERATE_KIT_ESP_CONFIGURATION_OK;
  return result;
}

const char *iterate_kit_esp_configuration_status_name(
    enum iterate_kit_esp_configuration_status status) {
  return status == ITERATE_KIT_ESP_CONFIGURATION_OK ? "ok" : "fake-failure";
}

/* --- restart bookkeeping -------------------------------------------------- */

const char *iterate_kit_esp_reset_reason_name(void) { return "fake"; }

/*
 * RECORDED, NOT HONOURED, for the same reason esp_restart() is: this does not
 * return on hardware, and ending the test process is not a test result.
 */
void iterate_kit_esp_restart_with_note(const char *why) {
  (void)snprintf(
      platform.restart_note, sizeof(platform.restart_note), "%s",
      why == NULL ? "" : why);
  esp_restart();
}

const char *iterate_kit_esp_last_restart_note(void) {
  return platform.restart_note;
}

/*
 * ACCEPTED, NOT DOWNLOADED: the host has no OTA slots and no radio. The loop
 * under test only needs the driver to exist so system.update mounts; what an
 * update DOES is the device's integration proof, not this harness's.
 */
enum iterate_kit_status iterate_kit_esp_idf_system_update_begin(
    void *context, const char *url, const char *sha256_hex) {
  (void)context;
  (void)url;
  (void)sha256_hex;
  return ITERATE_KIT_OK;
}

/* --- the transport -------------------------------------------------------- */

enum iterate_kit_status iterate_kit_esp_idf_itx_transport_prepare(
    struct iterate_kit_esp_idf_itx_transport *transport,
    const struct iterate_kit_esp_idf_itx_transport_options *options) {
  if (transport == NULL || options == NULL || options->connection == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(transport, 0, sizeof(*transport));
  transport->options = *options;
  transport->state = ITERATE_KIT_ESP_IDF_ITX_IDLE;
  transport->initialized = true;
  platform.transport = transport;
  platform.connection = options->connection;
  return ITERATE_KIT_OK;
}

/*
 * The loop's egress. Fragments in, whole messages out, because that is what the
 * real transport's outbox reassembles before anything can read one.
 */
enum capnweb_status iterate_kit_esp_idf_itx_transport_send_text(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  size_t *used;
  (void)context;
  if (platform.sent_count >= FAKE_SENT_CAPACITY) return CAPNWEB_E_TRANSPORT;
  if (kind == CAPNWEB_TEXT_BEGIN) {
    platform.message_open = true;
    platform.sent_lengths[platform.sent_count] = 0U;
    platform.sent[platform.sent_count][0] = '\0';
    return CAPNWEB_OK;
  }
  if (!platform.message_open) return CAPNWEB_E_TRANSPORT;
  used = &platform.sent_lengths[platform.sent_count];
  if (kind == CAPNWEB_TEXT_DATA) {
    if (data == NULL) return CAPNWEB_E_TRANSPORT;
    if (length + 1U > FAKE_MESSAGE_CAPACITY - *used) {
      return CAPNWEB_E_TRANSPORT;
    }
    memcpy(platform.sent[platform.sent_count] + *used, data, length);
    *used += length;
    platform.sent[platform.sent_count][*used] = '\0';
    return CAPNWEB_OK;
  }
  platform.message_open = false;
  ++platform.sent_count;
  return CAPNWEB_OK;
}

enum iterate_kit_status iterate_kit_esp_idf_itx_transport_start(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  if (transport == NULL || !transport->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  transport->started = true;
  /*
   * WIFI_CONNECTING, not READY. A transport that were ready the instant it
   * started would hide every state the loop has for coming up, and the loop's
   * whole launch ladder is about those states.
   */
  transport->state = ITERATE_KIT_ESP_IDF_ITX_WIFI_CONNECTING;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_esp_idf_itx_transport_poll(
    struct iterate_kit_esp_idf_itx_transport *transport,
    size_t max_control_messages) {
  (void)max_control_messages;
  if (transport == NULL || !transport->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return ITERATE_KIT_OK;
}

void iterate_kit_esp_idf_itx_transport_request_restart(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  if (transport == NULL) return;
  ++platform.restarts_requested;
}

/*
 * THE HOP, ANSWERING OR NOT. On hardware the PING is queued for the network
 * task and the PONG arrives some milliseconds later; here the answer is
 * immediate, because what the press probe is watching is the COUNT and not the
 * timing of the reply. A hop set not to answer is exactly the half-open socket
 * the probe exists for.
 */
void iterate_kit_esp_idf_itx_transport_request_probe(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  if (transport == NULL) return;
  ++platform.probes_requested;
  if (platform.hop_answers) ++platform.pongs;
}

enum iterate_kit_status iterate_kit_esp_idf_itx_transport_stop(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  if (transport == NULL) return ITERATE_KIT_INVALID_ARGUMENT;
  transport->started = false;
  transport->state = ITERATE_KIT_ESP_IDF_ITX_STOPPED;
  return ITERATE_KIT_OK;
}

void iterate_kit_esp_idf_itx_transport_metrics(
    const struct iterate_kit_esp_idf_itx_transport *transport,
    struct iterate_kit_esp_idf_itx_transport_metrics *metrics) {
  if (metrics == NULL) return;
  memset(metrics, 0, sizeof(*metrics));
  if (transport == NULL) return;
  metrics->websocket_pongs_received = platform.pongs;
  metrics->ready_socket_generation = transport->ready_socket_generation;
  metrics->control_inbox_capacity_slots = 1U;
  metrics->control_outbox_capacity_slots = 1U;
}

void iterate_kit_esp_idf_itx_transport_lifecycle(
    const struct iterate_kit_esp_idf_itx_transport *transport,
    struct iterate_kit_esp_idf_itx_transport_lifecycle *lifecycle) {
  if (lifecycle == NULL) return;
  memset(lifecycle, 0, sizeof(*lifecycle));
  if (transport == NULL) return;
  lifecycle->ready_socket_generation = transport->ready_socket_generation;
}

const char *iterate_kit_esp_idf_itx_transport_state_name(
    enum iterate_kit_esp_idf_itx_transport_state state) {
  switch (state) {
    case ITERATE_KIT_ESP_IDF_ITX_IDLE: return "idle";
    case ITERATE_KIT_ESP_IDF_ITX_WIFI_CONNECTING: return "wifi-connecting";
    case ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING: return "ws-connecting";
    case ITERATE_KIT_ESP_IDF_ITX_MOUNTING: return "mounting";
    case ITERATE_KIT_ESP_IDF_ITX_READY: return "ready";
    case ITERATE_KIT_ESP_IDF_ITX_FAILED: return "failed";
    case ITERATE_KIT_ESP_IDF_ITX_STOPPED: return "stopped";
  }
  return "unknown";
}
