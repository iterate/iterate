#include "fake_esp_idf_pcm_websocket.h"
#include "fake_esp_idf_platform.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/platforms/esp_idf_pcm_transport.h"
#include "iterate/kit/platforms/esp_idf_websocket_policy.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      fprintf(stderr, "%s:%d: check failed: %s\n",                         \
          __FILE__, __LINE__, #condition);                                   \
      abort();                                                               \
    }                                                                        \
  } while (0)

enum {
  SLOT_COUNT = 4,
  WAIT_TIMEOUT_MS = 2000,
};

struct fixture {
  struct iterate_kit_configuration configuration;
  struct iterate_kit_spsc_ring uplink;
  struct iterate_kit_spsc_ring downlink;
  struct iterate_kit_pcm_uplink_slot uplink_storage[SLOT_COUNT];
  struct iterate_kit_pcm_downlink_slot
      downlink_storage[SLOT_COUNT];
  size_t uplink_lengths[SLOT_COUNT];
  size_t downlink_lengths[SLOT_COUNT];
  struct iterate_kit_pcm_lane lane;
  struct iterate_kit_esp_idf_pcm_transport transport;
  uint32_t generation_barrier_calls;
  uint32_t generation_barrier_generation;
  uint32_t simulated_hardware_frames;
  bool generation_barrier_connected;
  bool generation_barrier_ready;
};

static int64_t monotonic_milliseconds(void) {
  struct timespec now;
  (void)clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000 +
      (int64_t)now.tv_nsec / 1000000;
}

static void pause_one_millisecond(void) {
  const struct timespec delay = {
    .tv_sec = 0,
    .tv_nsec = 1000000L,
  };
  (void)nanosleep(&delay, NULL);
}

static enum iterate_kit_status generation_barrier(
    void *context,
    uint32_t generation,
    bool connected) {
  struct fixture *fixture = context;
  ++fixture->generation_barrier_calls;
  fixture->generation_barrier_generation = generation;
  fixture->generation_barrier_connected = connected;
  if (!fixture->generation_barrier_ready) {
    /*
     * Real firmware posts a command to the priority-19 audio owner and returns
     * here until that owner has stopped/deleted cyclic DMA. Keeping hardware
     * state separate from the lane catches the unsafe implementation that
     * admits a socket after clearing only application memory.
     */
    return ITERATE_KIT_UNAVAILABLE;
  }
  fixture->simulated_hardware_frames = 0U;
  return ITERATE_KIT_OK;
}

static void fixture_init(struct fixture *fixture) {
  struct iterate_kit_esp_idf_pcm_transport_options options;
  memset(fixture, 0, sizeof(*fixture));
  iterate_kit_fake_pcm_websocket_reset();
  fixture->configuration = (struct iterate_kit_configuration){
    .wifi_ssid = "host-test-network",
    .wifi_password = "host-test-password",
    .os_base_url = "https://example.invalid",
    .project_id = "prj_host_test",
    .project_api_key = "itxk_host_test",
  };
  CHECK(iterate_kit_spsc_ring_init(
      &fixture->uplink,
      fixture->uplink_storage,
      sizeof(fixture->uplink_storage[0]),
      SLOT_COUNT,
      fixture->uplink_lengths) == ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_init(
      &fixture->downlink,
      fixture->downlink_storage,
      sizeof(fixture->downlink_storage[0]),
      SLOT_COUNT,
      fixture->downlink_lengths) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_init(
      &fixture->lane,
      &fixture->uplink,
      &fixture->downlink) == ITERATE_KIT_OK);
  options = (struct iterate_kit_esp_idf_pcm_transport_options){
    .configuration = &fixture->configuration,
    .lane = &fixture->lane,
    .downlink_generation_barrier = generation_barrier,
    .downlink_generation_barrier_context = fixture,
  };
  CHECK(iterate_kit_esp_idf_pcm_transport_prepare(
      &fixture->transport, &options) == ITERATE_KIT_OK);
}

static bool wait_for_generation(
    struct fixture *fixture, uint32_t generation) {
  const int64_t deadline =
      monotonic_milliseconds() + WAIT_TIMEOUT_MS;
  while (monotonic_milliseconds() < deadline) {
    if (__atomic_load_n(
            &fixture->transport.socket_connected,
            __ATOMIC_ACQUIRE) != 0U &&
        __atomic_load_n(
            &fixture->transport.socket_generation,
            __ATOMIC_ACQUIRE) == generation) {
      return true;
    }
    pause_one_millisecond();
  }
  return false;
}

static bool wait_for_deliveries(uint32_t expected) {
  const int64_t deadline =
      monotonic_milliseconds() + WAIT_TIMEOUT_MS;
  while (monotonic_milliseconds() < deadline) {
    if (iterate_kit_fake_pcm_websocket_deliveries() == expected) {
      return true;
    }
    pause_one_millisecond();
  }
  return false;
}

static bool wait_for_downlink_publications(
    struct fixture *fixture, uint32_t expected) {
  const int64_t deadline =
      monotonic_milliseconds() + WAIT_TIMEOUT_MS;
  while (monotonic_milliseconds() < deadline) {
    struct iterate_kit_esp_idf_pcm_transport_metrics metrics;
    iterate_kit_esp_idf_pcm_transport_metrics(
        &fixture->transport, &metrics);
    /*
     * The socket fake increments `deliveries` when it hands a chunk to
     * production. The transport still has to validate and publish that chunk
     * into the cross-task lane. Waiting on the fake counter and immediately
     * reading the lane raced those two operations about once in thirty stress
     * runs. Synchronize on the production publication counter instead: that is
     * the actual happens-before condition the consumer relies on.
     */
    if (metrics.lane.downlink.messages_published >= expected) {
      return true;
    }
    pause_one_millisecond();
  }
  return false;
}

static bool wait_for_idle_peer_probes(
    struct fixture *fixture, uint32_t expected) {
  const int64_t deadline =
      monotonic_milliseconds() + WAIT_TIMEOUT_MS;
  while (monotonic_milliseconds() < deadline) {
    struct iterate_kit_esp_idf_pcm_transport_metrics metrics;
    iterate_kit_esp_idf_pcm_transport_metrics(
        &fixture->transport, &metrics);
    if (metrics.peer_delivery.idle_peer_probes_queued ==
        expected) {
      return true;
    }
    pause_one_millisecond();
  }
  return false;
}

/*
 * ESP-IDF can finish the socket upgrade on the network task before the
 * application task has discarded the prior generation's playback frames. If
 * receive starts in that window, poll() cannot distinguish the first fresh
 * frame from stale buffered audio and deletes it. That was physically audible
 * as a gap at the beginning of the tunneled tone.
 *
 * The required ordering is therefore:
 *
 *   publish generation -> application purges/accepts -> network may receive
 *
 * This test holds one real-size server frame at the WebSocket boundary and
 * proves that the production transport does not even call receive before
 * application acceptance. It then proves the same frame emerges byte-exactly
 * with no discard counter. Merely testing the lane would miss the cross-task
 * generation race that caused the real device failure.
 */
static void fresh_downlink_waits_for_generation_acceptance(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  const void *received = NULL;
  size_t received_size = 0U;
  size_t index;
  fixture_init(&fixture);
  for (index = 0U; index < sizeof(frame); ++index) {
    frame[index] = (uint8_t)(index * 17U + 3U);
  }
  CHECK(iterate_kit_pcm_lane_receive_downlink_at(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      0U,
      frame,
      sizeof(frame),
      0U) == ITERATE_KIT_OK);
  fixture.simulated_hardware_frames = 4U;
  /*
   * Model generation zero ending after only one transport chunk. The lane's
   * write reservation is producer-owned; application poll cannot cancel it.
   * The real network owner must abandon it before publishing generation one,
   * or the fresh offset-zero message below is rejected as a conflicting
   * fragment and creates the same missing-first-frame symptom.
   */
  CHECK(iterate_kit_pcm_lane_receive_downlink_at(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      0U,
      frame,
      173U,
      1U) == ITERATE_KIT_UNAVAILABLE);
  CHECK(fixture.downlink.write_acquired);
  CHECK(iterate_kit_fake_pcm_websocket_queue_binary(
      frame, sizeof(frame)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_esp_idf_pcm_transport_start(
      &fixture.transport) == ITERATE_KIT_OK);
  /*
   * Core 1 is reserved for the priority-19 audio owner. TLS/WebSocket work can
   * be CPU-heavy even when queues remain shallow, so sharing that core would
   * turn radio bursts into acoustic deadline misses.
   */
  CHECK(iterate_kit_fake_network_task_core_id() == 0);
  /*
   * Separate sockets do not imply separate service when both owners compete on
   * Core 0 at the same priority. A control overload on hardware first stranded
   * one RPC resolution and then stopped PCM receive progress. PCM networking
   * therefore needs one explicit scheduling class above ordinary capability
   * traffic, while remaining well below ESP-IDF's radio/TCP system tasks.
   */
  CHECK(iterate_kit_fake_network_task_priority() == 6U);
  CHECK(wait_for_generation(&fixture, 1U));
  CHECK(!fixture.downlink.write_acquired);

  /*
   * Give the independently scheduled owner several ordinary 10 ms loop
   * quanta. A correct gate keeps receive_calls at zero; relying on a lucky
   * application poll race would make this assertion fail deterministically.
   */
  for (index = 0U; index < 50U; ++index) {
    pause_one_millisecond();
  }
  CHECK(iterate_kit_fake_pcm_websocket_receive_calls() == 0U);

  CHECK(iterate_kit_esp_idf_pcm_transport_poll(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(fixture.generation_barrier_calls == 1U);
  CHECK(fixture.generation_barrier_generation == 1U);
  CHECK(fixture.generation_barrier_connected);
  CHECK(fixture.simulated_hardware_frames == 4U);
  CHECK(fixture.transport.accepted_socket_generation == 0U);
  CHECK(fixture.transport.state ==
      ITERATE_KIT_ESP_IDF_PCM_CONNECTING);
  CHECK(iterate_kit_fake_pcm_websocket_receive_calls() == 0U);

  /*
   * Only the audio-owner acknowledgement opens the socket. The same poll then
   * clears the application lane while the producer remains gated, so the first
   * fresh network frame cannot race the old hardware/lane purge.
   */
  fixture.generation_barrier_ready = true;
  CHECK(iterate_kit_esp_idf_pcm_transport_poll(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(fixture.generation_barrier_calls == 2U);
  CHECK(fixture.simulated_hardware_frames == 0U);
  CHECK(fixture.transport.accepted_socket_generation == 1U);
  CHECK(fixture.transport.state ==
      ITERATE_KIT_ESP_IDF_PCM_READY);
  /*
   * One stale complete message was published before start; the fresh network
   * message is publication two even though generation fencing discarded the
   * first.
   */
  CHECK(wait_for_downlink_publications(&fixture, 2U));
  CHECK(iterate_kit_pcm_lane_downlink_acquire(
      &fixture.lane,
      &received,
      &received_size) == ITERATE_KIT_OK);
  CHECK(received_size == sizeof(frame));
  CHECK(memcmp(received, frame, sizeof(frame)) == 0);
  CHECK(iterate_kit_pcm_lane_downlink_release(
      &fixture.lane) == ITERATE_KIT_OK);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_frames_accepted == 2U);
  CHECK(metrics.downlink_frames_discarded == 1U);
  CHECK(metrics.downlink_generation_fragment_resets == 1U);
  CHECK(iterate_kit_esp_idf_pcm_transport_stop(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(iterate_kit_fake_platform_finish() == ESP_OK);
}

/*
 * The voice proxy terminates every finite response with an empty binary
 * WebSocket frame. It is useful only if the actual ESP transport task
 * publishes it behind every prior PCM frame in the same SPSC lane. A separate
 * stop flag could win the cross-core race and clip the last 20 ms; dropping
 * the empty frame as "idle" would leave the speaker DMA cycling indefinitely.
 *
 * This fixture keeps the real production transport task and lane, replacing
 * only the upgraded socket with two immutable inbound messages. The consumer
 * must observe content, then EOS, then empty—exactly once each.
 */
static void content_and_eos_remain_ordered_across_the_transport_task(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  const void *received = NULL;
  size_t received_size = 0U;
  uint64_t received_at_ms = 0U;
  size_t index;

  fixture_init(&fixture);
  for (index = 0U; index < sizeof(frame); ++index) {
    frame[index] = (uint8_t)(index * 29U + 7U);
  }
  CHECK(iterate_kit_fake_pcm_websocket_queue_binary(
      frame, sizeof(frame)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_fake_pcm_websocket_queue_binary(
      NULL, 0U) == ITERATE_KIT_OK);
  fixture.generation_barrier_ready = true;
  CHECK(iterate_kit_esp_idf_pcm_transport_start(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(wait_for_generation(&fixture, 1U));
  CHECK(iterate_kit_esp_idf_pcm_transport_poll(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(fixture.transport.state ==
      ITERATE_KIT_ESP_IDF_PCM_READY);
  CHECK(wait_for_downlink_publications(&fixture, 2U));

  CHECK(iterate_kit_pcm_lane_downlink_acquire_at(
      &fixture.lane,
      &received,
      &received_size,
      &received_at_ms) == ITERATE_KIT_OK);
  CHECK(received == fixture.downlink_storage[0].frame);
  CHECK(received_size == sizeof(frame));
  CHECK(memcmp(received, frame, sizeof(frame)) == 0);
  CHECK(iterate_kit_pcm_lane_downlink_release(
      &fixture.lane) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_lane_downlink_acquire_at(
      &fixture.lane,
      &received,
      &received_size,
      &received_at_ms) == ITERATE_KIT_OK);
  CHECK(received == NULL);
  CHECK(received_size == 0U);
  CHECK(iterate_kit_pcm_lane_downlink_release(
      &fixture.lane) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_downlink_acquire_at(
      &fixture.lane,
      &received,
      &received_size,
      &received_at_ms) == ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_frames_accepted == 1U);
  CHECK(metrics.downlink_end_markers_accepted == 1U);
  CHECK(metrics.downlink_frames_discarded == 0U);
  CHECK(metrics.downlink_end_markers_discarded == 0U);
  CHECK(iterate_kit_esp_idf_pcm_transport_stop(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(iterate_kit_fake_platform_finish() == ESP_OK);
}

/*
 * Once a WebSocket item has been read, it cannot be replayed. If the bounded
 * application lane is full, counting BACKPRESSURE and continuing the same
 * generation silently removes 20 ms of speech—or removes EOS and prevents a
 * finite response from draining at all. Either outcome permanently shifts the
 * conversation away from realtime.
 *
 * Four frames fill the exact test lane and the fifth ordered item is EOS. The
 * only safe recovery is to invalidate generation one immediately, destroy all
 * opaque socket buffering, and reconnect at generation two. The application
 * generation fence will then discard the four now-stale frames before it
 * admits any fresh response.
 */
static void ordered_item_loss_forces_a_fresh_socket_generation(void) {
  struct fixture fixture;
  struct iterate_kit_esp_idf_pcm_transport_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  size_t index;

  fixture_init(&fixture);
  memset(frame, 0x4d, sizeof(frame));
  for (index = 0U; index < SLOT_COUNT; ++index) {
    CHECK(iterate_kit_fake_pcm_websocket_queue_binary(
        frame, sizeof(frame)) == ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_fake_pcm_websocket_queue_binary(
      NULL, 0U) == ITERATE_KIT_OK);
  fixture.generation_barrier_ready = true;
  CHECK(iterate_kit_esp_idf_pcm_transport_start(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(wait_for_generation(&fixture, 1U));
  CHECK(iterate_kit_esp_idf_pcm_transport_poll(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(fixture.transport.state ==
      ITERATE_KIT_ESP_IDF_PCM_READY);
  CHECK(wait_for_deliveries(SLOT_COUNT + 1U));

  /*
   * Remaining connected at generation one after the fifth delivery is the
   * original defect: the peer believes EOS was delivered, while this device
   * has discarded it. A reconnect is freshness recovery, not retransmission.
   */
  CHECK(wait_for_generation(&fixture, 2U));
  iterate_kit_esp_idf_pcm_transport_metrics(
      &fixture.transport, &metrics);
  CHECK(metrics.downlink_receive_failures == 1U);
  CHECK(metrics.downlink_ordered_item_losses == 1U);
  CHECK(metrics.protocol_failures == 0U);
  CHECK(metrics.websocket_disconnects == 1U);
  CHECK(metrics.lane.downlink_frames_accepted == SLOT_COUNT);
  CHECK(metrics.lane.downlink_end_markers_accepted == 0U);
  CHECK(iterate_kit_esp_idf_pcm_transport_stop(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(iterate_kit_fake_platform_finish() == ESP_OK);
}

/*
 * The portable peer-delivery guard already proves its state transitions with
 * a synthetic clock. That is insufficient for the physical failure we are
 * chasing: both device WebSockets stopped progressing, and a perfectly
 * correct guard is useless if the ESP task loop never services its RESTART
 * verdict or never destroys the old transport generation.
 *
 * Keep the upgraded socket silent and advance only the fake monotonic clock.
 * The real production task must put one ordered PING on generation one, time
 * it out, close that generation, and publish generation two without waiting
 * for microphone traffic or a server downlink. No sleep-based three-second
 * test is needed; wall time drives the pthread scheduler while the explicit
 * policy clock drives the deadline.
 */
static void silent_peer_timeout_replaces_the_platform_socket_generation(void) {
  struct fixture fixture;
  struct iterate_kit_esp_idf_pcm_transport_metrics metrics;

  fixture_init(&fixture);
  iterate_kit_fake_monotonic_clock_reset();
  fixture.generation_barrier_ready = true;
  CHECK(iterate_kit_esp_idf_pcm_transport_start(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(wait_for_generation(&fixture, 1U));
  CHECK(iterate_kit_esp_idf_pcm_transport_poll(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(fixture.transport.state ==
      ITERATE_KIT_ESP_IDF_PCM_READY);

  /*
   * Establish the fresh generation's silence baseline before jumping to the
   * interval. Otherwise the first post-jump poll would correctly treat that
   * later instant as time zero and no probe would yet be due.
   */
  iterate_kit_esp_idf_pcm_transport_notify_uplink(
      &fixture.transport);
  pause_one_millisecond();
  iterate_kit_fake_monotonic_clock_advance_ms(
      ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_INTERVAL_MS);
  iterate_kit_esp_idf_pcm_transport_notify_uplink(
      &fixture.transport);
  CHECK(wait_for_idle_peer_probes(&fixture, 1U));

  iterate_kit_fake_monotonic_clock_advance_ms(
      ITERATE_KIT_ESP_IDF_PCM_IDLE_PEER_PROBE_TIMEOUT_MS);
  iterate_kit_esp_idf_pcm_transport_notify_uplink(
      &fixture.transport);
  CHECK(wait_for_generation(&fixture, 2U));

  iterate_kit_esp_idf_pcm_transport_metrics(
      &fixture.transport, &metrics);
  CHECK(metrics.websocket_connections == 2U);
  CHECK(metrics.websocket_disconnects == 1U);
  CHECK(metrics.websocket_errors == 0U);
  CHECK(metrics.protocol_failures == 0U);
  CHECK(metrics.peer_delivery.idle_peer_probes_queued == 1U);
  CHECK(metrics.peer_delivery.idle_peer_probes_confirmed == 0U);
  CHECK(metrics.peer_delivery.idle_peer_probe_timeouts == 1U);

  CHECK(iterate_kit_esp_idf_pcm_transport_poll(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(fixture.transport.state ==
      ITERATE_KIT_ESP_IDF_PCM_READY);
  CHECK(iterate_kit_esp_idf_pcm_transport_stop(
      &fixture.transport) == ITERATE_KIT_OK);
  CHECK(iterate_kit_fake_platform_finish() == ESP_OK);
  iterate_kit_fake_monotonic_clock_reset();
}

int main(void) {
  fresh_downlink_waits_for_generation_acceptance();
  content_and_eos_remain_ordered_across_the_transport_task();
  ordered_item_loss_forces_a_fresh_socket_generation();
  silent_peer_timeout_replaces_the_platform_socket_generation();
  return 0;
}
