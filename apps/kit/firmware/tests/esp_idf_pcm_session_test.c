#include "iterate/kit/platforms/esp_idf_pcm_session.h"
#include "pcm_transport_lifecycle.h"

#include <stdbool.h>
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

struct fixture {
  struct iterate_kit_esp_idf_itx_transport control;
  struct iterate_kit_esp_idf_pcm_transport transport;
  struct iterate_kit_esp_idf_pcm_session session;
  uint32_t generation_lost_calls;
  uint32_t media_gate_calls;
  bool conversation_is_active;
  bool media_ready;
  bool fail_next_media_gate;
};

static uint32_t ready_control_generation;
static uint32_t start_calls;
static uint32_t poll_calls;
static uint32_t restart_calls;
static enum iterate_kit_status next_start_status;

/*
 * The session test replaces only the raw transport boundary. This keeps the
 * test deterministic without weakening its architectural claim: production
 * targets are separately forbidden from calling these functions directly,
 * and the raw transport has its own fault/reconnect suite. Here we prove the
 * ownership policy which decides when those already-tested operations occur.
 */
enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_start(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  ++start_calls;
  if (next_start_status == ITERATE_KIT_OK) {
    transport->state = ITERATE_KIT_ESP_IDF_PCM_CONNECTING;
  }
  return next_start_status;
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_poll(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  (void)transport;
  ++poll_calls;
  return ITERATE_KIT_OK;
}

void iterate_kit_esp_idf_pcm_transport_request_restart(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  (void)transport;
  ++restart_calls;
}

const char *iterate_kit_esp_idf_pcm_transport_state_name(
    enum iterate_kit_esp_idf_pcm_transport_state state) {
  (void)state;
  return "host-test";
}

void iterate_kit_esp_idf_itx_transport_lifecycle(
    const struct iterate_kit_esp_idf_itx_transport *transport,
    struct iterate_kit_esp_idf_itx_transport_lifecycle *lifecycle) {
  (void)transport;
  memset(lifecycle, 0, sizeof(*lifecycle));
  lifecycle->ready_socket_generation = ready_control_generation;
}

static bool conversation_active(void *context) {
  const struct fixture *fixture = context;
  return fixture->conversation_is_active;
}

static enum iterate_kit_status set_media_ready(
    void *context, bool ready) {
  struct fixture *fixture = context;
  ++fixture->media_gate_calls;
  if (fixture->fail_next_media_gate) {
    fixture->fail_next_media_gate = false;
    return ITERATE_KIT_IO_ERROR;
  }
  fixture->media_ready = ready;
  return ITERATE_KIT_OK;
}

static void generation_lost(void *context) {
  struct fixture *fixture = context;
  ++fixture->generation_lost_calls;
}

static void reset_calls(void) {
  ready_control_generation = 0U;
  start_calls = 0U;
  poll_calls = 0U;
  restart_calls = 0U;
  next_start_status = ITERATE_KIT_OK;
}

static void fixture_init(struct fixture *fixture) {
  struct iterate_kit_esp_idf_pcm_session_options session_options;
  memset(fixture, 0, sizeof(*fixture));
  reset_calls();
  fixture->control.state = ITERATE_KIT_ESP_IDF_ITX_WIFI_CONNECTING;
  fixture->transport.initialized = true;
  fixture->transport.state = ITERATE_KIT_ESP_IDF_PCM_IDLE;
  session_options =
      (struct iterate_kit_esp_idf_pcm_session_options){
          .control_transport = &fixture->control,
          .pcm_transport = &fixture->transport,
          .hook_context = fixture,
          .conversation_active = conversation_active,
          .set_media_ready = set_media_ready,
          .generation_lost = generation_lost,
          .log_tag = "pcm-session-test",
      };
  CHECK(iterate_kit_esp_idf_pcm_session_prepare(
            &fixture->session, &session_options) == ITERATE_KIT_OK);
}

static enum iterate_kit_status poll_session(
    struct fixture *fixture, bool conversation_is_active) {
  fixture->conversation_is_active = conversation_is_active;
  return iterate_kit_esp_idf_pcm_session_poll(&fixture->session);
}

static void test_requires_both_shared_state_hooks(void) {
  struct fixture fixture;
  struct iterate_kit_esp_idf_pcm_session_options options;
  memset(&fixture, 0, sizeof(fixture));
  fixture.transport.initialized = true;
  options = (struct iterate_kit_esp_idf_pcm_session_options){
      .control_transport = &fixture.control,
      .pcm_transport = &fixture.transport,
      .hook_context = &fixture,
      .conversation_active = conversation_active,
      .set_media_ready = set_media_ready,
  };

  /*
   * Making either hook optional would reopen the exact target-local escape
   * hatch this owner exists to remove: a board could pass conversation state
   * into poll manually or reconstruct the media conjunction in its UI/audio
   * layer. Reject incomplete composition at boot instead.
   */
  options.conversation_active = NULL;
  CHECK(iterate_kit_esp_idf_pcm_session_prepare(
            &fixture.session, &options) ==
        ITERATE_KIT_INVALID_ARGUMENT);
  options.conversation_active = conversation_active;
  options.set_media_ready = NULL;
  CHECK(iterate_kit_esp_idf_pcm_session_prepare(
            &fixture.session, &options) ==
        ITERATE_KIT_INVALID_ARGUMENT);
}

static void test_media_gate_sink_failure_stays_closed_and_retries_boundedly(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.control.state = ITERATE_KIT_ESP_IDF_ITX_READY;
  ready_control_generation = 1U;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_READY;
  fixture.fail_next_media_gate = true;

  /*
   * A hardware-facing desired-state sink can fail transiently. The shared
   * owner must never publish optimistic readiness in that interval, and must
   * retry from its ordinary cooperative cadence rather than spawning a target
   * retry loop. One later successful edge opens the gate without restarting
   * the already-warm transport.
   */
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_IO_ERROR);
  CHECK(!fixture.media_ready);
  CHECK(!iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
  const uint32_t failed_gate_calls = fixture.media_gate_calls;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(fixture.media_gate_calls == failed_gate_calls + 1U);
  CHECK(fixture.media_ready);
  CHECK(iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
  CHECK(start_calls == 1U);
}

static void test_prewarms_once_and_gates_media_separately(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  /*
   * Wi-Fi or a bare WebSocket is not authenticated device readiness. Starting
   * before Cap'n Web publishes a nonzero mounted generation would let `/pcm`
   * race an invalid or not-yet-authorized project configuration.
   */
  CHECK(poll_session(&fixture, false) == ITERATE_KIT_OK);
  CHECK(start_calls == 0U);

  fixture.control.state = ITERATE_KIT_ESP_IDF_ITX_READY;
  ready_control_generation = 1U;
  CHECK(poll_session(&fixture, false) == ITERATE_KIT_OK);
  CHECK(start_calls == 1U);
  CHECK(iterate_kit_esp_idf_pcm_session_started(&fixture.session));
  CHECK(!iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));

  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_READY;
  CHECK(poll_session(&fixture, false) == ITERATE_KIT_OK);
  CHECK(iterate_kit_esp_idf_pcm_session_transport_ready(&fixture.session));
  CHECK(!iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
  CHECK(!fixture.media_ready);
  CHECK(fixture.media_gate_calls == 1U);

  /*
   * Conversation state changes admission only. It must not create a second
   * transport start or tie the provider credential lifetime to one call.
   */
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(start_calls == 1U);
  CHECK(fixture.media_ready);
  CHECK(fixture.media_gate_calls == 2U);
  CHECK(iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
  CHECK(poll_session(&fixture, false) == ITERATE_KIT_OK);
  CHECK(start_calls == 1U);
  CHECK(!fixture.media_ready);
  CHECK(fixture.media_gate_calls == 3U);
  CHECK(iterate_kit_esp_idf_pcm_session_transport_ready(&fixture.session));
}

static void test_control_remount_restarts_one_generation_without_stopping_owner(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.control.state = ITERATE_KIT_ESP_IDF_ITX_READY;
  ready_control_generation = 7U;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_READY;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));

  /*
   * Cap'n Web callbacks cannot cross mount generations. Replacing exactly one
   * socket generation is necessary, but stopping/recreating the static task
   * would also throw away credential prewarm and reopen allocator/lifecycle
   * failure modes. Admission closes synchronously even if the network owner
   * needs another scheduler turn to leave READY.
   */
  ready_control_generation = 8U;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(restart_calls == 1U);
  CHECK(!iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
  CHECK(!iterate_kit_esp_idf_pcm_session_transport_ready(&fixture.session));
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(restart_calls == 1U);

  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_CONNECTING;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(fixture.generation_lost_calls == 1U);
  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_READY;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
  CHECK(start_calls == 1U);
}

static void test_control_loss_closes_media_without_destroying_prewarm(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.control.state = ITERATE_KIT_ESP_IDF_ITX_READY;
  ready_control_generation = 7U;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_READY;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));

  /*
   * A raw PCM WebSocket can survive after its Cap'n Web peer has disappeared.
   * Treating that socket as conversationally authorized would keep the live
   * microphone and speaker open under stale capability state. Control loss
   * must therefore close media admission immediately, while preserving the
   * warm raw owner so a bounded remount can replace only its generation.
   */
  fixture.control.state = ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING;
  ready_control_generation = 0U;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(!iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
  CHECK(iterate_kit_esp_idf_pcm_session_transport_ready(&fixture.session));
  CHECK(start_calls == 1U);
  CHECK(restart_calls == 0U);

  fixture.control.state = ITERATE_KIT_ESP_IDF_ITX_READY;
  ready_control_generation = 8U;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(restart_calls == 1U);
  CHECK(!iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
}

static void test_network_recovery_never_replays_outer_start(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.control.state = ITERATE_KIT_ESP_IDF_ITX_READY;
  ready_control_generation = 1U;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_READY;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);

  /*
   * FAILED and CONNECTING are raw transport generations governed by its
   * exponential retry gate. Calling start() again from the device loop would
   * create a second owner or a hot retry path and is therefore forbidden.
   */
  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_FAILED;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_CONNECTING;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  fixture.transport.state = ITERATE_KIT_ESP_IDF_PCM_READY;
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_OK);
  CHECK(start_calls == 1U);
  CHECK(iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
}

static void test_local_start_failure_is_one_shot(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.control.state = ITERATE_KIT_ESP_IDF_ITX_READY;
  ready_control_generation = 1U;
  next_start_status = ITERATE_KIT_IO_ERROR;

  CHECK(poll_session(&fixture, true) == ITERATE_KIT_IO_ERROR);
  /*
   * A static-task creation failure means there is no network owner capable of
   * later recovering. Reporting OK on the next cooperative poll would erase
   * the only actionable diagnosis and make every board's UI falsely return to
   * READY. Retain the failure while also proving that recovery is bounded: no
   * hot start loop may repeatedly ask FreeRTOS for the same owner task.
   */
  CHECK(poll_session(&fixture, true) == ITERATE_KIT_IO_ERROR);
  CHECK(start_calls == 1U);
  CHECK(!iterate_kit_esp_idf_pcm_session_started(&fixture.session));
  CHECK(iterate_kit_esp_idf_pcm_session_failed(&fixture.session));
  CHECK(!iterate_kit_esp_idf_pcm_session_media_ready(&fixture.session));
}

int main(void) {
  test_requires_both_shared_state_hooks();
  test_media_gate_sink_failure_stays_closed_and_retries_boundedly();
  test_prewarms_once_and_gates_media_separately();
  test_control_remount_restarts_one_generation_without_stopping_owner();
  test_control_loss_closes_media_without_destroying_prewarm();
  test_network_recovery_never_replays_outer_start();
  test_local_start_failure_is_one_shot();
  puts("esp idf pcm session tests passed");
  return 0;
}
