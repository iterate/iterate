#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_WEBSOCKET_POLICY_H
#define ITERATE_KIT_PLATFORMS_ESP_IDF_WEBSOCKET_POLICY_H

#include "iterate/kit/pcm_uplink_conductor.h"

/**
 * Shared control/PCM socket policy. Reconnects must start promptly and then
 * back off to a bounded rate when the endpoint remains unavailable.
 *
 * The peer-delivery constants form one coupled latency budget:
 *
 * - queue a ping after four locally accepted frames (normally 80 ms);
 * - allow at most eight unconfirmed frames (160 ms of captured audio);
 * - force a ping after 40 ms so a short push-to-talk tail is also confirmed;
 * - replace the connection after 200 ms without a matching pong.
 *
 * Audio itself creates those delivery barriers, but a device can legitimately
 * remain silent for minutes. TCP keepalive is not enough during that silence:
 * an intermediary can continue acknowledging TCP while the application peer
 * is wedged, leaving the device apparently connected and unable to receive the
 * first response or interruption. We therefore send one application-visible
 * WebSocket probe after two seconds without peer evidence and replace the
 * generation after one further second without its matching pong. A shorter
 * heartbeat would spend radio wakeups and CPU on a condition that audio
 * barriers already detect in under 200 ms while the microphone is active; a
 * longer heartbeat would make the first post-idle interaction visibly stall.
 *
 * Four and eight are deliberately not a tiny one-frame stop-and-wait window:
 * that would add control traffic and make ordinary radio jitter interrupt
 * capture. They are also far below the 32-frame application-ring capacity:
 * spare RAM absorbs task-scheduling jitter, while this policy—not queue size—
 * determines how much speech may remain hidden below the application. The
 * confirmation deadline stays below capture max age so opaque transport bytes
 * trigger recovery before the sender's outer freshness guard.
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
  ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS = 250,
  ITERATE_KIT_ESP_IDF_PCM_PEER_BARRIER_INTERVAL_FRAMES = 4,
  ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_UNCONFIRMED_FRAMES = 8,
  ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_BARRIER_DELAY_MS = 40,
  ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_CONFIRMATION_AGE_MS = 200,
  ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_INTERVAL_MS = 2000,
  ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_TIMEOUT_MS = 1000,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_INITIAL_MS = 250,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_MAX_MS = 30000,
};

typedef char iterate_kit_pcm_network_preempts_control[
    ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_PRIORITY >
            ITERATE_KIT_ESP_IDF_CONTROL_NETWORK_TASK_PRIORITY
        ? 1
        : -1];

/*
 * These are compile-time proofs, not duplicated tuning preferences. A device
 * built with an inverted deadline can boot and pass ordinary Wi-Fi tests, then
 * preserve speech in an opaque queue longer than the sender considers fresh.
 * Keep the human-readable relationship test as documentation, but also reject
 * an impossible policy in every firmware build—even when host tests were
 * accidentally skipped. C99-compatible array bounds avoid imposing C11 on the
 * portable headers and work unchanged when included from C++.
 */
typedef char iterate_kit_barrier_fits_peer_window[
    ITERATE_KIT_ESP_IDF_PCM_PEER_BARRIER_INTERVAL_FRAMES <=
            ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_UNCONFIRMED_FRAMES
        ? 1
        : -1];
typedef char iterate_kit_barrier_precedes_confirmation_deadline[
    ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_BARRIER_DELAY_MS <
            ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_CONFIRMATION_AGE_MS
        ? 1
        : -1];
typedef char iterate_kit_confirmation_precedes_capture_expiry[
    ITERATE_KIT_ESP_IDF_PCM_PEER_MAX_CONFIRMATION_AGE_MS <
            ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS
        ? 1
        : -1];
/*
 * The idle probe's total failure bound stays under five seconds so silence
 * cannot turn an application-dead connection into a long first-turn outage.
 * The direct WebSocket adapter is nonblocking, so there is deliberately no
 * lower "send timeout" to order against this deadline. Reintroducing one would
 * let opaque transport code retain stale audio outside the measured sender
 * policy.
 */
typedef char iterate_kit_idle_peer_failure_is_bounded[
    ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_INTERVAL_MS +
                ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_TIMEOUT_MS <=
            5000
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
