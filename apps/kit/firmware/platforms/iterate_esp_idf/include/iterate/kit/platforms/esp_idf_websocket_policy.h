#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_WEBSOCKET_POLICY_H
#define ITERATE_KIT_PLATFORMS_ESP_IDF_WEBSOCKET_POLICY_H

#include "iterate/kit/pcm_uplink_conductor.h"

/**
 * Shared control/PCM socket policy. Reconnects start promptly and then back off
 * to a bounded rate when the endpoint remains unavailable. PCM freshness is
 * governed only by observable local facts: capture age, total frame send age,
 * and elapsed time without raw-byte progress. WebSocket PONG is deliberately
 * absent from this policy because it cannot prove userspace or provider
 * delivery and must never gate a long push-to-talk.
 */
enum {
  /*
   * Both application-owned network tasks run on Core 0, but they must not have
   * equal service precedence. The physical loaded-playback rig observed a
   * control failure followed by complete PCM receive starvation even though
   * the sockets and application queues were independent. Giving PCM one
   * FreeRTOS level above control makes the intended lane priority real without
   * competing with ESP-IDF's much higher-priority Wi-Fi/TCP system tasks.
   *
   * The one-level difference is deliberate: PCM still blocks/yields whenever
   * no byte work is available, so control remains responsive, and we avoid
   * treating priority as a substitute for bounded work quanta. Raising this
   * toward the radio or I2S owner priorities was rejected because an erroneous
   * busy loop could then starve the very system services audio depends on.
   */
  ITERATE_KIT_ESP_IDF_CONTROL_NETWORK_TASK_PRIORITY = 5,
  ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_PRIORITY = 6,
  ITERATE_KIT_ESP_IDF_PCM_SEND_NO_PROGRESS_TIMEOUT_MS = 500,
  ITERATE_KIT_ESP_IDF_PCM_FRAME_MAX_SEND_DURATION_MS = 1000,
  /*
   * A production run observed one ordinary ~300 ms TLS/TCP stall. Expiring
   * capture at 250 ms tore down the socket and clipped an otherwise current
   * long PTT turn. The application ring already provides an exact 640 ms hard
   * bound, while the independent 500 ms no-byte-progress deadline still
   * replaces a genuinely stuck generation first. Using the ring bound admits
   * one TCP retransmission interval without authorizing catch-up playback; the
   * ordered end-of-turn marker makes commit integrity structural rather than
   * dependent on this tuning value.
   */
  ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS = 640,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_INITIAL_MS = 250,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_MAX_MS = 30000,
};

typedef char iterate_kit_pcm_network_preempts_control[
    ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_PRIORITY >
            ITERATE_KIT_ESP_IDF_CONTROL_NETWORK_TASK_PRIORITY
        ? 1
        : -1];

/*
 * A conductor pass is bounded for fairness, not because PROGRESS means the PCM
 * suffix can tolerate a scheduler tick. On the 100 Hz M5Stick target, blindly
 * waiting after each partial TLS write would add 10 ms at every bound and could
 * turn a deliberately small work quantum into audible queuing. Zero means
 * "yield through the outer receive/send/receive loop, then run again"; it does
 * not mean spin inside the conductor or skip downlink/control service.
 *
 * IDLE and DEFERRED use one tick because there is no immediately useful byte
 * work. A producer notification or restart request still wakes that wait early.
 * Keep this decision portable and host-tested rather than burying it as a
 * FreeRTOS local variable whose latency meaning is easy to erase in a refactor.
 */
static inline unsigned int
iterate_kit_esp_idf_pcm_network_wait_ticks(
    enum iterate_kit_pcm_uplink_conductor_poll_result result) {
  switch (result) {
    case ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS:
    case ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART:
    case ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED:
      return 0U;
    case ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE:
    case ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED:
    default:
      return 1U;
  }
}

#endif
