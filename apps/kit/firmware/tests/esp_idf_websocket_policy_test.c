#include "iterate/kit/platforms/esp_idf_websocket_policy.h"

#include <assert.h>

/*
 * A TLS write may accept only part of one 640-byte PCM message. The portable
 * conductor deliberately returns after bounded work so receive/control traffic
 * gets a turn, but PROGRESS also promises that an immediately-ready suffix may
 * remain. Sleeping one 100 Hz FreeRTOS tick at that boundary would inject up to
 * 10 ms per short write and make the fairness bound itself an audio backlog.
 *
 * We rejected making the conductor spin until EAGAIN because a writable socket
 * could then starve downlink audio and PONG processing. The platform contract
 * is instead: yield through the outer receive/send/receive loop, then poll
 * again without a timed wait after PROGRESS; genuinely idle or blocked work may
 * use the one-tick wakeup bound.
 */
static void progress_gets_a_fair_but_zero_delay_followup(void) {
  assert(
      iterate_kit_esp_idf_pcm_network_wait_ticks(
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS) == 0U);
  assert(
      iterate_kit_esp_idf_pcm_network_wait_ticks(
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE) == 1U);
  assert(
      iterate_kit_esp_idf_pcm_network_wait_ticks(
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED) == 1U);
  /*
   * Recovery and local-failure verdicts also need a zero-delay outer pass so
   * the owner closes the old socket promptly; correctness must not depend on a
   * self-notification surviving a future task-notification refactor.
   */
  assert(
      iterate_kit_esp_idf_pcm_network_wait_ticks(
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART) == 0U);
  assert(
      iterate_kit_esp_idf_pcm_network_wait_ticks(
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED) == 0U);
}

/*
 * These are relationship tests rather than a duplicate table of preferred
 * numbers. A future tuner may change individual values for measured hardware,
 * but must not create an internally impossible policy: the barrier needs room
 * inside its window, the window needs room inside the freshness deadline, and
 * expected TLS jitter must not cause immediate reconnect churn.
 *
 * Independent "reasonable-looking" constants were rejected because their
 * interaction can let opaque lwIP/Wi-Fi backlog outlive the application sender
 * and become delayed speech after recovery. The realtime transport owns these
 * bounds as one policy, so any tuning change must preserve their ordering.
 */
static void latency_and_recovery_deadlines_remain_coherent(void) {
  assert(
      ITERATE_KIT_ESP_IDF_WEBSOCKET_SEND_TIMEOUT_MS >= 250);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_SEND_NO_PROGRESS_TIMEOUT_MS >=
      150);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_SEND_NO_PROGRESS_TIMEOUT_MS <=
      ITERATE_KIT_ESP_IDF_PCM_FRAME_MAX_SEND_DURATION_MS);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_FRAME_MAX_SEND_DURATION_MS <=
      2000);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS > 150);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS <
      ITERATE_KIT_ESP_IDF_PCM_FRAME_MAX_SEND_DURATION_MS);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_PEER_BARRIER_INTERVAL_FRAMES >
      0);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_PEER_BARRIER_INTERVAL_FRAMES <=
      ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_UNCONFIRMED_FRAMES);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_UNCONFIRMED_FRAMES *
          20 <=
      ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_BARRIER_DELAY_MS <
      ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_CONFIRMATION_AGE_MS);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_CONFIRMATION_AGE_MS <
      ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS);
  /*
   * This guards a different incident from the active-audio deadline above.
   * A silent half-open connection has no microphone frames with which to
   * create a delivery barrier, so it needs an application-level heartbeat.
   * We require a low-frequency probe (rather than continuously waking Wi-Fi)
   * and a bounded total outage (rather than trusting TCP keepalive, which can
   * prove only the transport peer and may take hours on embedded defaults).
   *
   * The timeout also permits at least one configured WebSocket send timeout.
   * Otherwise benign TLS scheduling jitter could make the liveness mechanism
   * manufacture reconnect churn—the opposite of the recovery it is meant to
   * provide.
   */
  assert(
      ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_INTERVAL_MS >=
      1000);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_TIMEOUT_MS >=
      ITERATE_KIT_ESP_IDF_WEBSOCKET_SEND_TIMEOUT_MS);
  assert(
      ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_INTERVAL_MS +
          ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_TIMEOUT_MS <=
      5000);
  assert(
      ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_INITIAL_MS <= 500);
  assert(
      ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_MAX_MS >= 30000);
  assert(
      ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_INITIAL_MS <
      ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_MAX_MS);
}

int main(void) {
  progress_gets_a_fair_but_zero_delay_followup();
  latency_and_recovery_deadlines_remain_coherent();
  return 0;
}
