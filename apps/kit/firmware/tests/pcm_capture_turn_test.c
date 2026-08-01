#include "iterate/kit/pcm_capture_turn.h"

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

enum { LANE_SLOT_COUNT = 8 };

struct fixture {
  struct iterate_kit_spsc_ring uplink;
  struct iterate_kit_spsc_ring downlink;
  struct iterate_kit_pcm_uplink_slot uplink_storage[LANE_SLOT_COUNT];
  struct iterate_kit_pcm_downlink_slot downlink_storage[LANE_SLOT_COUNT];
  size_t uplink_lengths[LANE_SLOT_COUNT];
  size_t downlink_lengths[LANE_SLOT_COUNT];
  struct iterate_kit_pcm_lane lane;
  struct iterate_kit_pcm_capture_turn turn;
  uint32_t uplink_notifications;
};

static void notify_uplink(void *context) {
  struct fixture *fixture = context;
  ++fixture->uplink_notifications;
}

static void fixture_init(struct fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  CHECK(iterate_kit_spsc_ring_init(
            &fixture->uplink,
            fixture->uplink_storage,
            sizeof(fixture->uplink_storage[0]),
            LANE_SLOT_COUNT,
            fixture->uplink_lengths) == ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_init(
            &fixture->downlink,
            fixture->downlink_storage,
            sizeof(fixture->downlink_storage[0]),
            LANE_SLOT_COUNT,
            fixture->downlink_lengths) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_init(
            &fixture->lane,
            &fixture->uplink,
            &fixture->downlink) == ITERATE_KIT_OK);
  const struct iterate_kit_pcm_capture_turn_options options = {
      .lane = &fixture->lane,
      .notify_uplink = notify_uplink,
      .notify_uplink_context = fixture,
  };
  CHECK(iterate_kit_pcm_capture_turn_init(
            &fixture->turn, &options) == ITERATE_KIT_OK);
}

static void fill_frame(int16_t *frame, int16_t seed) {
  for (size_t index = 0U;
       index < ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME;
       ++index) {
    frame[index] = (int16_t)(seed + (int16_t)index);
  }
}

/*
 * CoreS3 must run capture and AEC continuously so the adaptive filter retains
 * an aligned reference even while nobody holds PTT. Routing those clean idle
 * frames into the PCM lane would fill its realtime budget in milliseconds and
 * misclassify normal idle time as a network outage. The gate therefore treats
 * inactive publication as an accounted policy discard and returns success to
 * the DSP bridge without waking the network owner.
 */
static void inactive_aec_never_builds_a_pcm_backlog(void) {
  struct fixture fixture;
  int16_t frame[ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME];
  struct iterate_kit_pcm_capture_turn_metrics metrics;
  struct iterate_kit_pcm_lane_metrics lane_metrics;
  fill_frame(frame, 100);
  fixture_init(&fixture);

  for (uint32_t index = 0U; index < 100U; ++index) {
    CHECK(iterate_kit_pcm_capture_turn_submit(
              &fixture.turn,
              frame,
              ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
              ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ,
              (uint64_t)index * 20000U) == ITERATE_KIT_OK);
  }

  iterate_kit_pcm_capture_turn_metrics(
      &fixture.turn, &metrics);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &lane_metrics);
  CHECK(!metrics.requested_active);
  CHECK(!metrics.active);
  CHECK(metrics.inactive_frames_discarded == 100U);
  CHECK(metrics.frames_accepted == 0U);
  CHECK(lane_metrics.uplink.current_slots == 0U);
  CHECK(lane_metrics.uplink.producer_backpressure == 0U);
  CHECK(fixture.uplink_notifications == 0U);
}

/*
 * A physical release is observed on the cooperative control task while the
 * AEC task is the sole producer of PCM. If the control task wrote the marker
 * itself, it could overtake a final frame already being copied on the other
 * core. Queue both transitions and prove that the one producer publishes the
 * complete frame before the zero-length commit marker.
 */
static void start_frame_stop_preserves_wire_order(void) {
  struct fixture fixture;
  int16_t frame[ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME];
  const void *borrowed = NULL;
  size_t borrowed_bytes = 0U;
  uint64_t captured_at_ms = 0U;
  struct iterate_kit_pcm_capture_turn_metrics metrics;
  fill_frame(frame, -400);
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_OK);
  /* Publication changes only when the AEC owner consumes the command. */
  CHECK(iterate_kit_pcm_capture_turn_submit(
            &fixture.turn,
            frame,
            ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
            ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ,
            100000U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 101U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_submit(
            &fixture.turn,
            frame,
            ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
            ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ,
            120000U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, false) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 123U) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_lane_uplink_acquire(
            &fixture.lane,
            &borrowed,
            &borrowed_bytes,
            &captured_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed != NULL);
  CHECK(borrowed_bytes == sizeof(frame));
  CHECK(captured_at_ms == 120U);
  CHECK(memcmp(borrowed, frame, sizeof(frame)) == 0);
  CHECK(iterate_kit_pcm_lane_uplink_release(
            &fixture.lane) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_lane_uplink_acquire(
            &fixture.lane,
            &borrowed,
            &borrowed_bytes,
            &captured_at_ms) == ITERATE_KIT_OK);
  CHECK(borrowed == NULL);
  CHECK(borrowed_bytes == 0U);
  CHECK(captured_at_ms == 123U);
  CHECK(iterate_kit_pcm_lane_uplink_release(
            &fixture.lane) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_uplink_acquire(
            &fixture.lane,
            &borrowed,
            &borrowed_bytes,
            &captured_at_ms) == ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_capture_turn_metrics(
      &fixture.turn, &metrics);
  CHECK(metrics.inactive_frames_discarded == 1U);
  CHECK(metrics.frames_accepted == 1U);
  CHECK(metrics.end_markers_accepted == 1U);
  CHECK(metrics.transitions_applied == 2U);
  CHECK(!metrics.active);
  CHECK(fixture.uplink_notifications == 2U);
}

/*
 * Remote and physical edges may arrive in one owner-loop interval. Replacing
 * the command FIFO with one atomic desired-state bit would collapse
 * start/stop/start/stop into "still stopped", losing two complete empty turns
 * and making the capability report success for actions that never happened.
 * The four-entry budget retains that bounded burst; a fifth edge is rejected
 * explicitly and becomes admissible again after the AEC owner drains it.
 */
static void rapid_edges_are_ordered_and_saturation_is_recoverable(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_capture_turn_metrics metrics;
  const void *borrowed = NULL;
  size_t borrowed_bytes = 1U;
  uint64_t captured_at_ms = 0U;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, false) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, false) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_BACKPRESSURE);

  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 700U) == ITERATE_KIT_OK);
  for (uint32_t marker = 0U; marker < 2U; ++marker) {
    CHECK(iterate_kit_pcm_lane_uplink_acquire(
              &fixture.lane,
              &borrowed,
              &borrowed_bytes,
              &captured_at_ms) == ITERATE_KIT_OK);
    CHECK(borrowed == NULL);
    CHECK(borrowed_bytes == 0U);
    CHECK(captured_at_ms == 700U);
    CHECK(iterate_kit_pcm_lane_uplink_release(
              &fixture.lane) == ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 701U) == ITERATE_KIT_OK);

  iterate_kit_pcm_capture_turn_metrics(
      &fixture.turn, &metrics);
  CHECK(metrics.commands_accepted == 5U);
  CHECK(metrics.command_backpressure == 1U);
  CHECK(metrics.transitions_applied == 5U);
  CHECK(metrics.end_markers_accepted == 2U);
  CHECK(metrics.requested_active);
  CHECK(metrics.active);
  CHECK(metrics.commands.current_slots == 0U);
}

/*
 * A full command queue is rare, but a rejected release is the dangerous
 * direction: treating it as an eventually-consistent desired-state write
 * would leave clean microphone frames flowing after the user released PTT.
 * Begin from active, fill the four-entry edge budget so it ends active, prove
 * the fifth stop is explicitly rejected, then drain and retry that same stop.
 * The requested-state snapshot must change only when the retry is accepted,
 * and the consumer must ultimately close with one marker for every stop.
 */
static void backpressured_stop_is_retried_and_closes_the_gate(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_capture_turn_metrics metrics;
  const void *borrowed = NULL;
  size_t borrowed_bytes = 1U;
  uint64_t captured_at_ms = 0U;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 1U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_is_active(&fixture.turn));

  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, false) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, false) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, false) == ITERATE_KIT_BACKPRESSURE);

  iterate_kit_pcm_capture_turn_metrics(&fixture.turn, &metrics);
  CHECK(metrics.requested_active);
  CHECK(metrics.active);
  CHECK(metrics.command_backpressure == 1U);

  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 2U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_is_active(&fixture.turn));
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, false) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 3U) == ITERATE_KIT_OK);
  CHECK(!iterate_kit_pcm_capture_turn_is_active(&fixture.turn));

  for (uint32_t marker = 0U; marker < 3U; ++marker) {
    CHECK(iterate_kit_pcm_lane_uplink_acquire(
              &fixture.lane,
              &borrowed,
              &borrowed_bytes,
              &captured_at_ms) == ITERATE_KIT_OK);
    CHECK(borrowed == NULL);
    CHECK(borrowed_bytes == 0U);
    CHECK(iterate_kit_pcm_lane_uplink_release(
              &fixture.lane) == ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_lane_uplink_acquire(
            &fixture.lane,
            &borrowed,
            &borrowed_bytes,
            &captured_at_ms) == ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_capture_turn_metrics(&fixture.turn, &metrics);
  CHECK(!metrics.requested_active);
  CHECK(!metrics.active);
  CHECK(metrics.end_markers_accepted == 3U);
  CHECK(metrics.commands.current_slots == 0U);
}

/*
 * If a network stall fills the microphone lane at release, silently losing
 * the end marker would leave userspace waiting on an ambiguous half-turn.
 * The lane's destructive epoch-reset request is the recovery contract. The
 * gate must surface the backpressure, remain inactive, and wake the transport
 * so it can purge/reconnect rather than queue more stale speech.
 */
static void full_lane_cannot_silently_lose_the_end_marker(void) {
  struct fixture fixture;
  int16_t frame[ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME];
  struct iterate_kit_pcm_capture_turn_metrics metrics;
  bool reset_requested = false;
  fill_frame(frame, 900);
  fixture_init(&fixture);
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 10U) == ITERATE_KIT_OK);

  for (uint32_t index = 0U; index < LANE_SLOT_COUNT; ++index) {
    CHECK(iterate_kit_pcm_capture_turn_submit(
              &fixture.turn,
              frame,
              ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
              ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ,
              (uint64_t)(index + 1U) * 20000U) == ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_capture_turn_request(
            &fixture.turn, false) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_capture_turn_poll(
            &fixture.turn, 200U) == ITERATE_KIT_BACKPRESSURE);
  CHECK(iterate_kit_pcm_lane_take_uplink_epoch_reset_request(
            &fixture.lane, &reset_requested) == ITERATE_KIT_OK);
  CHECK(reset_requested);

  iterate_kit_pcm_capture_turn_metrics(
      &fixture.turn, &metrics);
  CHECK(!metrics.active);
  CHECK(metrics.end_marker_backpressure == 1U);
  CHECK(metrics.frames_accepted == LANE_SLOT_COUNT);
  CHECK(fixture.uplink_notifications == LANE_SLOT_COUNT + 1U);
}

int main(void) {
  inactive_aec_never_builds_a_pcm_backlog();
  start_frame_stop_preserves_wire_order();
  rapid_edges_are_ordered_and_saturation_is_recoverable();
  backpressured_stop_is_retried_and_closes_the_gate();
  full_lane_cannot_silently_lose_the_end_marker();
  puts("pcm capture turn tests passed");
  return 0;
}
