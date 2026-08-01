#include "iterate/kit/pcm_lane.h"

#include <stdbool.h>
#include <stddef.h>
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

enum {
  SLOT_COUNT = 4,
};

struct lane_fixture {
  struct iterate_kit_spsc_ring uplink;
  struct iterate_kit_spsc_ring downlink;
  struct iterate_kit_pcm_uplink_slot
      uplink_storage[SLOT_COUNT];
  struct iterate_kit_pcm_downlink_slot
      downlink_storage[SLOT_COUNT];
  size_t uplink_lengths[SLOT_COUNT];
  size_t downlink_lengths[SLOT_COUNT];
  struct iterate_kit_pcm_lane lane;
};

static void fill_frame(uint8_t *frame, uint8_t seed) {
  size_t index;
  for (index = 0U;
       index < ITERATE_KIT_PCM_V1_FRAME_BYTES;
       ++index) {
    frame[index] = (uint8_t)(seed + index);
  }
}

static void fixture_init(struct lane_fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
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
}

/*
 * The microphone task hands fixed-duration PCM to a different network task,
 * so the lane must copy once into owned storage and preserve the capture
 * timestamp without duplicating delivery. Borrowing the producer's stack or
 * treating acquire as consumption would race the next capture and corrupt
 * latency metrics. This pins copy ownership, timestamp fidelity, and the
 * acquire/release exactly-once boundary.
 */
static void exact_uplink_frame_emerges_once(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  const void *borrowed = NULL;
  size_t borrowed_size = 0U;
  uint64_t capture_completed_at_ms = 0U;
  fixture_init(&fixture);
  fill_frame(frame, 17U);

  CHECK(iterate_kit_pcm_lane_submit_uplink_at(
      &fixture.lane,
      frame,
      sizeof(frame),
      123U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_uplink_acquire(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &capture_completed_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed != frame);
  CHECK(borrowed_size == sizeof(frame));
  CHECK(capture_completed_at_ms == 123U);
  CHECK(memcmp(borrowed, frame, sizeof(frame)) == 0);
  CHECK(iterate_kit_pcm_lane_uplink_release(&fixture.lane) ==
      ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_uplink_acquire(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &capture_completed_at_ms) ==
      ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.uplink_frames_accepted == 1U);
  CHECK(metrics.uplink_invalid_frames == 0U);
  CHECK(metrics.uplink.messages_published == 1U);
  CHECK(metrics.uplink.messages_consumed == 1U);
  CHECK(metrics.uplink.current_slots == 0U);
}

/*
 * PTT release crosses the low-rate Cap'n Web socket while captured PCM crosses
 * the independent realtime socket. Waiting for the control event alone cannot
 * prove that the final microphone frame reached userspace: the two TCP streams
 * may be scheduled in either order. The release edge therefore publishes an
 * empty binary item behind all accepted microphone frames in this same SPSC
 * ring. Userspace commits only after observing both the control edge and this
 * ordered marker. This test is deliberately symmetric with the downlink end
 * marker below; an out-of-band flag was rejected because it could overtake the
 * queued audio it is meant to fence.
 */
static void uplink_end_marker_follows_the_final_capture_frame(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  const void *borrowed = NULL;
  size_t borrowed_size = 99U;
  uint64_t capture_completed_at_ms = 0U;
  fixture_init(&fixture);
  fill_frame(frame, 71U);

  CHECK(iterate_kit_pcm_lane_submit_uplink_at(
      &fixture.lane,
      frame,
      sizeof(frame),
      123U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_submit_uplink_end_marker_at(
      &fixture.lane, 124U) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_lane_uplink_acquire(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &capture_completed_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed_size == sizeof(frame));
  CHECK(capture_completed_at_ms == 123U);
  CHECK(memcmp(borrowed, frame, sizeof(frame)) == 0);
  CHECK(iterate_kit_pcm_lane_uplink_release(
      &fixture.lane) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_lane_uplink_acquire(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &capture_completed_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed == NULL);
  CHECK(borrowed_size == 0U);
  CHECK(capture_completed_at_ms == 124U);
  CHECK(iterate_kit_pcm_lane_uplink_release(
      &fixture.lane) == ITERATE_KIT_OK);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.uplink_frames_accepted == 1U);
  CHECK(metrics.uplink_end_markers_accepted == 1U);
  CHECK(metrics.uplink.messages_published == 2U);
  CHECK(metrics.uplink.messages_consumed == 2U);
}

/*
 * Speaker playback must receive exactly the binary frame sent by the server,
 * independent of the WebSocket callback buffer's lifetime. Passing that
 * callback pointer through is cheaper but becomes use-after-reuse as soon as
 * the client reads another packet. This scenario proves the lane owns a byte-
 * exact copy and exposes it once until the speaker explicitly releases it.
 */
static void exact_binary_downlink_frame_emerges_once(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  const void *borrowed = NULL;
  size_t borrowed_size = 0U;
  fixture_init(&fixture);
  fill_frame(frame, 91U);

  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      0U,
      frame,
      sizeof(frame)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_downlink_acquire(
      &fixture.lane, &borrowed, &borrowed_size) == ITERATE_KIT_OK);
  CHECK(borrowed != frame);
  CHECK(borrowed_size == sizeof(frame));
  CHECK(memcmp(borrowed, frame, sizeof(frame)) == 0);
  CHECK(iterate_kit_pcm_lane_downlink_release(&fixture.lane) ==
      ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_downlink_acquire(
      &fixture.lane, &borrowed, &borrowed_size) ==
      ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_frames_accepted == 1U);
  CHECK(metrics.downlink.messages_published == 1U);
  CHECK(metrics.downlink.messages_consumed == 1U);
  CHECK(metrics.downlink.current_slots == 0U);
}

/*
 * A control-plane "response done" event is not ordered against a separate PCM
 * socket. Protocol v1 therefore reserves a zero-length server binary message
 * as an in-band end marker. It must occupy the same SPSC order as audio: the
 * final frame emerges first, then one explicit marker, then the lane is empty.
 * Treating zero bytes as malformed makes finite playback indistinguishable from
 * a network underrun and causes the endurance harness to false-fail every run.
 */
static void zero_length_end_marker_follows_the_final_frame(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  const void *borrowed = NULL;
  size_t borrowed_size = 99U;
  uint64_t received_at_ms = 0U;
  fixture_init(&fixture);
  fill_frame(frame, 52U);

  CHECK(iterate_kit_pcm_lane_receive_downlink_at(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      0U,
      frame,
      sizeof(frame),
      100U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_receive_downlink_at(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      0U,
      0U,
      NULL,
      0U,
      101U) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_lane_downlink_acquire_at(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &received_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed_size == sizeof(frame));
  CHECK(received_at_ms == 100U);
  CHECK(memcmp(borrowed, frame, sizeof(frame)) == 0);
  CHECK(iterate_kit_pcm_lane_downlink_release(
      &fixture.lane) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_lane_downlink_acquire_at(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &received_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed == NULL);
  CHECK(borrowed_size == 0U);
  CHECK(received_at_ms == 101U);
  CHECK(iterate_kit_pcm_lane_downlink_release(
      &fixture.lane) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_downlink_acquire_at(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &received_at_ms) == ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_frames_accepted == 1U);
  CHECK(metrics.downlink_end_markers_accepted == 1U);
  CHECK(metrics.downlink.messages_published == 2U);
  CHECK(metrics.downlink.messages_consumed == 2U);
}

/*
 * ESP-IDF may split one WebSocket message at any byte boundary, including
 * boundaries unrelated to PCM samples. Assuming callback-sized messages works
 * on a quiet LAN but rejects or plays partial frames under normal TLS/socket
 * fragmentation. Exercising every two-chunk split proves reassembly is offset-
 * based, publishes only after the complete frame, and never double-counts a
 * fragmented transport delivery as multiple audio messages.
 */
static void every_two_chunk_split_reassembles_exactly_once(void) {
  size_t split;
  for (split = 1U;
       split < ITERATE_KIT_PCM_V1_FRAME_BYTES;
       ++split) {
    struct lane_fixture fixture;
    struct iterate_kit_pcm_lane_metrics metrics;
    uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
    const void *borrowed = NULL;
    size_t borrowed_size = 0U;
    fixture_init(&fixture);
    fill_frame(frame, (uint8_t)split);

    CHECK(iterate_kit_pcm_lane_receive_downlink(
        &fixture.lane,
        ITERATE_KIT_PCM_MESSAGE_BINARY,
        true,
        sizeof(frame),
        0U,
        frame,
        split) == ITERATE_KIT_UNAVAILABLE);
    CHECK(iterate_kit_pcm_lane_downlink_acquire(
        &fixture.lane, &borrowed, &borrowed_size) ==
        ITERATE_KIT_UNAVAILABLE);

    CHECK(iterate_kit_pcm_lane_receive_downlink(
        &fixture.lane,
        ITERATE_KIT_PCM_MESSAGE_BINARY,
        true,
        sizeof(frame),
        split,
        frame + split,
        sizeof(frame) - split) == ITERATE_KIT_OK);
    CHECK(iterate_kit_pcm_lane_downlink_acquire(
        &fixture.lane, &borrowed, &borrowed_size) ==
        ITERATE_KIT_OK);
    CHECK(borrowed_size == sizeof(frame));
    CHECK(memcmp(borrowed, frame, sizeof(frame)) == 0);
    CHECK(iterate_kit_pcm_lane_downlink_release(
        &fixture.lane) == ITERATE_KIT_OK);

    iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
    CHECK(metrics.downlink_frames_accepted == 1U);
    CHECK(metrics.downlink_fragmented_messages == 0U);
    CHECK(metrics.downlink.messages_published == 1U);
    CHECK(metrics.downlink.messages_consumed == 1U);
  }
}

/*
 * A disconnect or parser defect can make a later callback's offset disagree
 * with the partial frame already being assembled. Keeping that reserved slot
 * for a hoped-for continuation would permanently reduce a tiny realtime ring
 * and eventually wedge playback. This incident proves malformed reassembly is
 * classified, abandons its partial write immediately, and leaves the lane able
 * to accept the next complete conversational epoch.
 */
static void malformed_fragment_sequence_releases_the_ring_slot(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  const void *borrowed = NULL;
  size_t borrowed_size = 0U;
  fixture_init(&fixture);
  fill_frame(frame, 33U);

  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      0U,
      frame,
      200U) == ITERATE_KIT_UNAVAILABLE);
  CHECK(fixture.downlink.write_acquired);
  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      201U,
      frame + 201U,
      sizeof(frame) - 201U) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  CHECK(!fixture.downlink.write_acquired);

  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      0U,
      frame,
      sizeof(frame)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_downlink_acquire(
      &fixture.lane, &borrowed, &borrowed_size) ==
      ITERATE_KIT_OK);
  CHECK(borrowed_size == sizeof(frame));
  CHECK(memcmp(borrowed, frame, sizeof(frame)) == 0);
  CHECK(iterate_kit_pcm_lane_downlink_release(
      &fixture.lane) == ITERATE_KIT_OK);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_fragmented_messages == 1U);
  CHECK(metrics.downlink_frames_accepted == 1U);
  CHECK(metrics.downlink.messages_published == 1U);
}

/*
 * A socket can disappear after ESP-IDF has delivered the first TLS chunk of a
 * 640-byte frame. That reservation belongs to the network producer, so a
 * consumer-side reconnect purge cannot release it. Without an explicit
 * producer generation fence, the next socket's offset-zero frame is rejected
 * and the first audible frame is lost. This reproduces that ownership split
 * and requires the new generation to emerge with its first-byte timestamp.
 */
static void generation_reset_abandons_a_partial_producer_slot(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t old_frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  uint8_t fresh_frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  const void *borrowed = NULL;
  size_t borrowed_size = 0U;
  uint64_t received_at_ms = 0U;
  fixture_init(&fixture);
  fill_frame(old_frame, 11U);
  fill_frame(fresh_frame, 87U);

  CHECK(iterate_kit_pcm_lane_receive_downlink_at(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(old_frame),
      0U,
      old_frame,
      173U,
      100U) == ITERATE_KIT_UNAVAILABLE);
  CHECK(fixture.downlink.write_acquired);
  CHECK(iterate_kit_pcm_lane_reset_downlink_producer(
      &fixture.lane) == ITERATE_KIT_OK);
  CHECK(!fixture.downlink.write_acquired);

  CHECK(iterate_kit_pcm_lane_receive_downlink_at(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(fresh_frame),
      0U,
      fresh_frame,
      sizeof(fresh_frame),
      250U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_downlink_acquire_at(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &received_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed_size == sizeof(fresh_frame));
  CHECK(received_at_ms == 250U);
  CHECK(memcmp(borrowed, fresh_frame, sizeof(fresh_frame)) == 0);
  CHECK(iterate_kit_pcm_lane_downlink_release(
      &fixture.lane) == ITERATE_KIT_OK);

  /*
   * Idempotent resets without a live partial are ordinary connection
   * bookkeeping, not additional loss incidents.
   */
  CHECK(iterate_kit_pcm_lane_reset_downlink_producer(
      &fixture.lane) == ITERATE_KIT_OK);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_generation_fragment_resets == 1U);
  CHECK(metrics.downlink_frames_accepted == 1U);
}

/*
 * A clean host bridge does not prove that the ESP network task delivered PCM
 * to the application on time. lwIP, Wi-Fi, the WebSocket client, or task
 * scheduling can still hold bytes after the bridge's send callback. Measure
 * the interval at the first device-owned PCM boundary so an acoustic underrun
 * can be attributed to ingress or to the later I2S owner path.
 *
 * EOS and a socket-generation reset deliberately break continuity. Including
 * either quiet/reconnect interval would manufacture a huge "network jitter"
 * sample unrelated to one response. The maximum remains lifetime evidence,
 * while the private previous-frame baseline restarts for the next response.
 */
static void downlink_interarrival_is_bounded_by_response_generation(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES] = {0};
  const void *borrowed = NULL;
  size_t borrowed_size = 0U;
  uint64_t received_at_ms = 0U;
  fixture_init(&fixture);

#define RECEIVE_AND_RELEASE(timestamp_ms)                                  \
  do {                                                                     \
    CHECK(iterate_kit_pcm_lane_receive_downlink_at(                         \
        &fixture.lane,                                                      \
        ITERATE_KIT_PCM_MESSAGE_BINARY,                                     \
        true,                                                               \
        sizeof(frame),                                                      \
        0U,                                                                 \
        frame,                                                              \
        sizeof(frame),                                                      \
        (timestamp_ms)) == ITERATE_KIT_OK);                                 \
    CHECK(iterate_kit_pcm_lane_downlink_acquire_at(                         \
        &fixture.lane,                                                      \
        &borrowed,                                                          \
        &borrowed_size,                                                     \
        &received_at_ms) == ITERATE_KIT_OK);                                \
    CHECK(borrowed_size == sizeof(frame));                                  \
    CHECK(received_at_ms == (timestamp_ms));                                \
    CHECK(iterate_kit_pcm_lane_downlink_release(                            \
        &fixture.lane) == ITERATE_KIT_OK);                                  \
  } while (0)

  RECEIVE_AND_RELEASE(UINT64_C(1000));
  RECEIVE_AND_RELEASE(UINT64_C(1020));
  RECEIVE_AND_RELEASE(UINT64_C(1105));

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_interarrival_samples == 2U);
  CHECK(metrics.downlink_maximum_interarrival_ms == 85U);

  CHECK(iterate_kit_pcm_lane_receive_downlink_at(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      0U,
      0U,
      NULL,
      0U,
      UINT64_C(1110)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_downlink_acquire_at(
      &fixture.lane,
      &borrowed,
      &borrowed_size,
      &received_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed == NULL);
  CHECK(borrowed_size == 0U);
  CHECK(iterate_kit_pcm_lane_downlink_release(
      &fixture.lane) == ITERATE_KIT_OK);

  RECEIVE_AND_RELEASE(UINT64_C(5000));
  RECEIVE_AND_RELEASE(UINT64_C(5020));
  CHECK(iterate_kit_pcm_lane_reset_downlink_producer(
      &fixture.lane) == ITERATE_KIT_OK);
  RECEIVE_AND_RELEASE(UINT64_C(9000));
  RECEIVE_AND_RELEASE(UINT64_C(9025));

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_interarrival_samples == 4U);
  CHECK(metrics.downlink_maximum_interarrival_ms == 85U);
#undef RECEIVE_AND_RELEASE
}

/*
 * The PCM socket deliberately accepts one narrow contract: complete binary
 * messages of the negotiated shape. Silently coercing text, fragmented
 * WebSocket messages, or wrong lengths would turn protocol faults into noise
 * or memory errors, while incrementing several counters for one fault would
 * make diagnostics ambiguous. This table pins rejection before publication
 * and one explicit diagnostic class per invalid input.
 */
static void invalid_downlink_outcomes_are_exclusive_and_observable(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES] = {0};
  const void *borrowed = NULL;
  size_t borrowed_size = 0U;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_TEXT,
      true,
      sizeof(frame),
      0U,
      frame,
      sizeof(frame)) == ITERATE_KIT_INVALID_ARGUMENT);
  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      false,
      sizeof(frame),
      0U,
      frame,
      sizeof(frame)) == ITERATE_KIT_INVALID_ARGUMENT);
  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      sizeof(frame) / 2U,
      frame,
      sizeof(frame) / 2U) == ITERATE_KIT_INVALID_ARGUMENT);
  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame) - 1U,
      0U,
      frame,
      sizeof(frame) - 1U) == ITERATE_KIT_INVALID_ARGUMENT);
  CHECK(iterate_kit_pcm_lane_downlink_acquire(
      &fixture.lane, &borrowed, &borrowed_size) ==
      ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_nonbinary_messages == 1U);
  CHECK(metrics.downlink_fragmented_messages == 2U);
  CHECK(metrics.downlink_malformed_frames == 1U);
  CHECK(metrics.downlink_frames_accepted == 0U);
  CHECK(metrics.downlink.messages_published == 0U);
}

/*
 * When either audio owner is starved, preserving every new frame would require
 * unbounded memory and would replay old conversation after recovery. The lane
 * instead has a fixed capacity and reports backpressure so the outer recovery
 * policy can reset an epoch. Filling both directions proves there is no hidden
 * overflow allocation or overwrite: depth stops at capacity, old borrowed
 * data remains intact, and saturation is visible in metrics.
 */
static void full_queues_drop_new_frames_without_growing_latency(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  size_t index;
  fixture_init(&fixture);

  for (index = 0U; index < SLOT_COUNT; ++index) {
    fill_frame(frame, (uint8_t)index);
    CHECK(iterate_kit_pcm_lane_submit_uplink_at(
        &fixture.lane,
        frame,
        sizeof(frame),
        index) == ITERATE_KIT_OK);
    CHECK(iterate_kit_pcm_lane_receive_downlink(
        &fixture.lane,
        ITERATE_KIT_PCM_MESSAGE_BINARY,
        true,
        sizeof(frame),
        0U,
        frame,
        sizeof(frame)) == ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_lane_submit_uplink_at(
      &fixture.lane,
      frame,
      sizeof(frame),
      SLOT_COUNT) ==
      ITERATE_KIT_BACKPRESSURE);
  CHECK(iterate_kit_pcm_lane_receive_downlink(
      &fixture.lane,
      ITERATE_KIT_PCM_MESSAGE_BINARY,
      true,
      sizeof(frame),
      0U,
      frame,
      sizeof(frame)) == ITERATE_KIT_BACKPRESSURE);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.uplink_frames_accepted == SLOT_COUNT);
  CHECK(metrics.downlink_frames_accepted == SLOT_COUNT);
  CHECK(metrics.uplink.producer_backpressure == 1U);
  CHECK(metrics.downlink.producer_backpressure == 1U);
  CHECK(metrics.uplink.current_slots == SLOT_COUNT);
  CHECK(metrics.downlink.current_slots == SLOT_COUNT);
  CHECK(metrics.uplink.high_water_slots == SLOT_COUNT);
  CHECK(metrics.downlink.high_water_slots == SLOT_COUNT);
}

/*
 * A user interruption invalidates all assistant PCM from the old response, not
 * merely the frame currently at the speaker. Draining it later would make the
 * assistant continue talking after it was stopped. This test requires the
 * interruption path to consume the entire bounded downlink epoch at once and
 * account for every discarded frame so the loss is intentional and auditable.
 */
static void interruption_discards_every_queued_downlink_frame(void) {
  struct lane_fixture fixture;
  struct iterate_kit_pcm_lane_metrics metrics;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES] = {0};
  uint32_t discarded = 99U;
  size_t index;
  fixture_init(&fixture);

  for (index = 0U; index < 3U; ++index) {
    CHECK(iterate_kit_pcm_lane_receive_downlink(
        &fixture.lane,
        ITERATE_KIT_PCM_MESSAGE_BINARY,
        true,
        sizeof(frame),
        0U,
        frame,
        sizeof(frame)) == ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_lane_discard_downlink(
      &fixture.lane, &discarded) == ITERATE_KIT_OK);
  CHECK(discarded == 3U);

  iterate_kit_pcm_lane_metrics(&fixture.lane, &metrics);
  CHECK(metrics.downlink_frames_discarded == 3U);
  CHECK(metrics.downlink.current_slots == 0U);
  CHECK(metrics.downlink.messages_consumed == 3U);
}

int main(void) {
  exact_uplink_frame_emerges_once();
  uplink_end_marker_follows_the_final_capture_frame();
  exact_binary_downlink_frame_emerges_once();
  zero_length_end_marker_follows_the_final_frame();
  every_two_chunk_split_reassembles_exactly_once();
  malformed_fragment_sequence_releases_the_ring_slot();
  generation_reset_abandons_a_partial_producer_slot();
  downlink_interarrival_is_bounded_by_response_generation();
  invalid_downlink_outcomes_are_exclusive_and_observable();
  full_queues_drop_new_frames_without_growing_latency();
  interruption_discards_every_queued_downlink_frame();
  return 0;
}
