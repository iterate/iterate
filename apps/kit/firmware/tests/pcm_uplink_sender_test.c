#include "iterate/kit/pcm_uplink_sender.h"

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
  NO_PROGRESS_TIMEOUT_MS = 500,
  MAXIMUM_FRAME_SEND_DURATION_MS = 1000,
};

struct fake_sender {
  enum iterate_kit_pcm_uplink_send_outcome outcomes[32];
  size_t outcome_count;
  size_t calls;
  const void *first_frame;
};

struct fixture {
  struct iterate_kit_spsc_ring uplink;
  struct iterate_kit_spsc_ring downlink;
  struct iterate_kit_pcm_uplink_slot
      uplink_storage[SLOT_COUNT];
  struct iterate_kit_pcm_downlink_slot
      downlink_storage[SLOT_COUNT];
  size_t uplink_lengths[SLOT_COUNT];
  size_t downlink_lengths[SLOT_COUNT];
  struct iterate_kit_pcm_lane lane;
  struct fake_sender fake;
  struct iterate_kit_pcm_uplink_sender sender;
};

static enum iterate_kit_pcm_uplink_send_outcome fake_send(
    void *context, const void *frame, size_t frame_bytes) {
  struct fake_sender *fake = context;
  CHECK(fake != NULL);
  CHECK(frame != NULL);
  CHECK(frame_bytes == ITERATE_KIT_PCM_V1_FRAME_BYTES);
  CHECK(fake->calls < fake->outcome_count);
  if (fake->first_frame == NULL) {
    fake->first_frame = frame;
  } else {
    CHECK(frame == fake->first_frame);
  }
  return fake->outcomes[fake->calls++];
}

static void fixture_init_with_capture_age(
    struct fixture *fixture,
    uint64_t maximum_capture_age_ms) {
  const struct iterate_kit_pcm_uplink_sender_options options = {
    .lane = &fixture->lane,
    .send = fake_send,
    .send_context = &fixture->fake,
    .restart_after_no_progress_ms = NO_PROGRESS_TIMEOUT_MS,
    .maximum_frame_send_duration_ms =
        MAXIMUM_FRAME_SEND_DURATION_MS,
    .maximum_capture_age_ms = maximum_capture_age_ms,
  };
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
  CHECK(iterate_kit_pcm_uplink_sender_init(
      &fixture->sender, &options) == ITERATE_KIT_OK);
}

static void fixture_init(struct fixture *fixture) {
  fixture_init_with_capture_age(
      fixture, MAXIMUM_FRAME_SEND_DURATION_MS * 2U);
}

static enum iterate_kit_pcm_uplink_sender_poll_result poll_at(
    struct fixture *fixture, uint64_t now_ms) {
  return iterate_kit_pcm_uplink_sender_poll(
      &fixture->sender, now_ms, NULL);
}

static void submit_frame_at(
    struct fixture *fixture,
    uint8_t seed,
    uint64_t capture_completed_at_ms) {
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  size_t index;
  for (index = 0U; index < sizeof(frame); ++index) {
    frame[index] = (uint8_t)(seed + index);
  }
  CHECK(iterate_kit_pcm_lane_submit_uplink_at(
      &fixture->lane,
      frame,
      sizeof(frame),
      capture_completed_at_ms) == ITERATE_KIT_OK);
}

static void submit_frame(
    struct fixture *fixture, uint8_t seed) {
  submit_frame_at(fixture, seed, 0U);
}

/*
 * A brief lwIP/TLS would-block is normal and should not punch holes in speech,
 * provided the frame is still inside the realtime age budget. Releasing the
 * ring slot on the first deferral would lose audio, while copying into another
 * retry queue would add memory and an untracked backlog. This proves the sender
 * retains one borrowed slot, retries that exact storage, and releases it only
 * after local transport acceptance.
 */
static void temporary_deferrals_retain_then_send_the_same_frame(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  struct iterate_kit_pcm_lane_metrics lane_metrics;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  fixture.fake.outcomes[1] =
      ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  fixture.fake.outcomes[2] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  fixture.fake.outcome_count = 3U;
  submit_frame(&fixture, 17U);

  CHECK(poll_at(&fixture, 0U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  CHECK(poll_at(&fixture, 250U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &lane_metrics);
  CHECK(lane_metrics.uplink.current_slots == 1U);
  CHECK(lane_metrics.uplink.messages_consumed == 0U);

  CHECK(poll_at(&fixture, 499U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);
  CHECK(poll_at(&fixture, 500U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_IDLE);

  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &lane_metrics);
  CHECK(metrics.frames_sent == 1U);
  CHECK(metrics.frames_discarded == 0U);
  CHECK(metrics.send_deferrals == 2U);
  CHECK(metrics.send_failures == 0U);
  CHECK(metrics.consecutive_send_deferrals == 0U);
  CHECK(metrics.maximum_consecutive_send_deferrals == 2U);
  CHECK(lane_metrics.uplink.current_slots == 0U);
  CHECK(lane_metrics.uplink.messages_consumed == 1U);
}

/*
 * A WebSocket frame may take several nonblocking writes; positive progress is
 * not completion and the transport can still reference the original PCM.
 * Advancing the lane after the first written bytes would let the producer
 * overwrite the tail of an in-flight frame. This scenario pins ownership
 * through all partial writes and distinguishes progress from backpressure in
 * diagnostics.
 */
static void partial_transport_progress_retains_the_ring_slot(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  struct iterate_kit_pcm_lane_metrics lane_metrics;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_PROGRESS;
  fixture.fake.outcomes[1] =
      ITERATE_KIT_PCM_UPLINK_SEND_PROGRESS;
  fixture.fake.outcomes[2] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  fixture.fake.outcome_count = 3U;
  submit_frame(&fixture, 23U);

  CHECK(poll_at(&fixture, 0U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_PROGRESS);
  CHECK(poll_at(&fixture, 499U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_PROGRESS);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &lane_metrics);
  CHECK(lane_metrics.uplink.current_slots == 1U);
  CHECK(lane_metrics.uplink.messages_consumed == 0U);

  CHECK(poll_at(&fixture, 999U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);
  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &lane_metrics);
  CHECK(metrics.frames_sent == 1U);
  CHECK(metrics.frames_discarded == 0U);
  CHECK(metrics.send_deferrals == 0U);
  CHECK(metrics.send_failures == 0U);
  CHECK(metrics.consecutive_send_deferrals == 0U);
  CHECK(lane_metrics.uplink.current_slots == 0U);
  CHECK(lane_metrics.uplink.messages_consumed == 1U);
}

/*
 * A socket can remain connected while never accepting another byte. Counting
 * poll attempts is scheduler-dependent and can restart too quickly under a
 * busy loop or never restart under starvation, so the policy is elapsed-time
 * based. This test protects the bound: ordinary deferral retains the frame,
 * but reaching the no-progress deadline discards the epoch and requests a
 * fresh connection with an explicit reason.
 */
static void bounded_no_progress_time_requests_restart(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  fixture.fake.outcomes[1] =
      ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  fixture.fake.outcomes[2] =
      ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  fixture.fake.outcome_count = 3U;
  submit_frame(&fixture, 31U);

  CHECK(poll_at(&fixture, 0U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  CHECK(poll_at(&fixture, 499U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  CHECK(poll_at(&fixture, 500U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);

  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.frames_sent == 0U);
  CHECK(metrics.frames_discarded == 1U);
  CHECK(metrics.send_deferrals == 3U);
  CHECK(metrics.send_failures == 0U);
  CHECK(metrics.restart_incidents == 1U);
  CHECK(metrics.no_progress_timeout_restarts == 1U);
  CHECK(metrics.last_restart_reason ==
      ITERATE_KIT_PCM_UPLINK_RESTART_NO_PROGRESS_TIMEOUT);
  CHECK(metrics.last_restart_frames_discarded == 1U);
  CHECK(metrics.consecutive_send_deferrals == 0U);
  CHECK(metrics.maximum_consecutive_send_deferrals == 3U);
}

/*
 * Once the transport reports disconnect, retrying the same borrowed speech on
 * that connection cannot succeed and risks carrying it into a later session.
 * Treating disconnect as ordinary would-block would defer recovery until a
 * separate timeout. This proves one observation immediately abandons the frame,
 * requests reconnect, and records transport disconnect rather than a generic
 * send failure.
 */
static void disconnect_requests_restart_without_retry(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_DISCONNECTED;
  fixture.fake.outcome_count = 1U;
  submit_frame(&fixture, 47U);

  CHECK(poll_at(&fixture, 0U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);
  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.frames_discarded == 1U);
  CHECK(metrics.send_deferrals == 0U);
  CHECK(metrics.send_failures == 0U);
  CHECK(metrics.restart_incidents == 1U);
  CHECK(metrics.transport_disconnect_restarts == 1U);
  CHECK(metrics.last_restart_reason ==
      ITERATE_KIT_PCM_UPLINK_RESTART_TRANSPORT_DISCONNECTED);
}

/*
 * A disconnect invalidates not only the currently borrowed frame but every
 * later frame captured behind it; replaying those after reconnect produces a
 * delayed answer to speech the user already considers lost. A one-frame drop
 * is a tempting minimal cleanup but leaves that stale tail intact. This test
 * pins restart as an epoch boundary and requires the discarded-frame count to
 * include the whole lane.
 */
static void restart_discards_the_entire_microphone_epoch(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  struct iterate_kit_pcm_lane_metrics lane_metrics;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_DISCONNECTED;
  fixture.fake.outcome_count = 1U;
  submit_frame(&fixture, 51U);
  submit_frame(&fixture, 52U);
  submit_frame(&fixture, 53U);

  CHECK(poll_at(&fixture, 0U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);

  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &lane_metrics);
  CHECK(metrics.frames_discarded == 3U);
  CHECK(metrics.send_failures == 0U);
  CHECK(metrics.restart_incidents == 1U);
  CHECK(metrics.transport_disconnect_restarts == 1U);
  CHECK(metrics.last_restart_frames_discarded == 3U);
  CHECK(lane_metrics.uplink.current_slots == 0U);
  CHECK(lane_metrics.uplink.messages_consumed == 3U);
}

/*
 * Ring overflow is proof that the realtime contract has already been broken:
 * at least one newest microphone frame could not enter the lane. Sending the
 * oldest queued frame before noticing overflow would make recovery begin with
 * maximally stale speech. This scenario requires the cross-task overflow
 * request to win before any transport call, purge the epoch, and surface the
 * exact recovery reason.
 */
static void producer_backpressure_purges_before_an_old_frame_is_sent(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  struct iterate_kit_pcm_lane_metrics lane_metrics;
  uint8_t overflow_frame[ITERATE_KIT_PCM_V1_FRAME_BYTES] = {0};
  size_t index;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  fixture.fake.outcome_count = 1U;
  for (index = 0U; index < SLOT_COUNT - 1U; ++index) {
    submit_frame(&fixture, (uint8_t)(81U + index));
  }

  CHECK(iterate_kit_pcm_lane_submit_uplink_at(
      &fixture.lane,
      overflow_frame,
      sizeof(overflow_frame),
      0U) == ITERATE_KIT_BACKPRESSURE);
  CHECK(poll_at(&fixture, 100U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);

  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &lane_metrics);
  CHECK(fixture.fake.calls == 0U);
  CHECK(metrics.frames_sent == 0U);
  CHECK(metrics.frames_discarded == SLOT_COUNT - 1U);
  CHECK(metrics.send_failures == 0U);
  CHECK(metrics.restart_incidents == 1U);
  CHECK(metrics.producer_backpressure_restarts == 1U);
  CHECK(metrics.last_restart_reason ==
      ITERATE_KIT_PCM_UPLINK_RESTART_PRODUCER_BACKPRESSURE);
  CHECK(metrics.last_restart_frames_discarded == SLOT_COUNT - 1U);
  CHECK(lane_metrics.uplink.current_slots == 0U);
  CHECK(lane_metrics.uplink.producer_backpressure == 1U);
}

/*
 * Teardown can occur while the sender owns the head slot after a would-block.
 * Draining only the ring's apparently queued tail would omit that borrowed slot
 * from accounting or leave it pinned across object reuse. This proves explicit
 * disconnect cleanup releases both the retained head and following frames as
 * one observable discard operation.
 */
static void disconnected_drain_includes_a_retained_frame(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  uint32_t discarded = 99U;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  fixture.fake.outcome_count = 1U;
  submit_frame(&fixture, 61U);
  submit_frame(&fixture, 73U);

  CHECK(poll_at(&fixture, 0U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_sender_discard_pending(
      &fixture.sender, &discarded) == ITERATE_KIT_OK);
  CHECK(discarded == 2U);

  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.frames_discarded == 2U);
  CHECK(metrics.consecutive_send_deferrals == 0U);
}

/*
 * The outer connection owner may tear down immediately after the producer has
 * reported overflow, before the normal poll path turns it into a restart. If
 * cleanup leaves that request latched, the freshly connected empty lane would
 * spuriously restart again. This test pins teardown as a complete epoch reset:
 * queued audio and the pending overflow signal are consumed without inventing
 * a second incident.
 */
static void disconnected_drain_consumes_a_prior_overflow_request(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  uint8_t overflow_frame[ITERATE_KIT_PCM_V1_FRAME_BYTES] = {0};
  uint32_t discarded = 0U;
  size_t index;
  fixture_init(&fixture);
  for (index = 0U; index < SLOT_COUNT - 1U; ++index) {
    submit_frame(&fixture, (uint8_t)(121U + index));
  }
  CHECK(iterate_kit_pcm_lane_submit_uplink_at(
      &fixture.lane,
      overflow_frame,
      sizeof(overflow_frame),
      0U) == ITERATE_KIT_BACKPRESSURE);

  CHECK(iterate_kit_pcm_uplink_sender_discard_pending(
      &fixture.sender, &discarded) == ITERATE_KIT_OK);
  CHECK(discarded == SLOT_COUNT - 1U);
  CHECK(poll_at(&fixture, 100U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_IDLE);

  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.restart_incidents == 0U);
  CHECK(metrics.frames_discarded == SLOT_COUNT - 1U);
}

/*
 * Wi-Fi routinely pauses for tens or hundreds of milliseconds without losing
 * the connection. A retry-count threshold would mistake frequent scheduler
 * polls during that pause for a dead socket and create reconnect churn. This
 * scenario exercises many deferrals inside the elapsed-time budget and proves
 * a fresh frame can still complete without discard or restart.
 */
static void a_normal_wifi_stall_does_not_restart_the_socket(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  size_t index;
  fixture_init(&fixture);
  for (index = 0U; index < 16U; ++index) {
    fixture.fake.outcomes[index] =
        ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  }
  fixture.fake.outcomes[16] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  fixture.fake.outcome_count = 17U;
  submit_frame(&fixture, 89U);

  for (index = 0U; index < 16U; ++index) {
    CHECK(poll_at(&fixture, index * 10U) ==
        ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  }
  CHECK(poll_at(&fixture, 160U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);

  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.frames_sent == 1U);
  CHECK(metrics.frames_discarded == 0U);
  CHECK(metrics.send_deferrals == 16U);
  CHECK(metrics.send_failures == 0U);
}

/*
 * The physical production run retained in the landing evidence observed one
 * roughly 300 ms TCP no-ACK interval. A 250 ms capture-age preference turned
 * that recoverable radio event into a destroyed Grok conversation even though
 * the application ring is deliberately bounded to 640 ms. Once the ordered
 * PTT end marker prevents delayed PCM crossing a turn boundary, capture age is
 * a latency policy rather than the turn-integrity mechanism: one ordinary RTO
 * should recover, but data older than the complete ring budget must still
 * purge the epoch instead of becoming catch-up speech.
 */
static void one_rto_survives_but_ring_age_still_restarts(void) {
  struct fixture recovered;
  struct fixture stale;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;

  fixture_init_with_capture_age(&recovered, 640U);
  recovered.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  recovered.fake.outcomes[1] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  recovered.fake.outcome_count = 2U;
  submit_frame_at(&recovered, 90U, 0U);
  CHECK(poll_at(&recovered, 0U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  CHECK(poll_at(&recovered, 400U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);
  iterate_kit_pcm_uplink_sender_metrics(
      &recovered.sender, &metrics);
  CHECK(metrics.frames_sent == 1U);
  CHECK(metrics.restart_incidents == 0U);

  fixture_init_with_capture_age(&stale, 640U);
  stale.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  stale.fake.outcome_count = 1U;
  submit_frame_at(&stale, 91U, 0U);
  CHECK(poll_at(&stale, 700U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);
  CHECK(stale.fake.calls == 0U);
  iterate_kit_pcm_uplink_sender_metrics(
      &stale.sender, &metrics);
  CHECK(metrics.frames_sent == 0U);
  CHECK(metrics.capture_stale_restarts == 1U);
  CHECK(metrics.frames_discarded == 1U);
}

/*
 * A pathological peer can accept a byte occasionally, continually resetting a
 * pure no-progress timer while one PCM frame becomes conversationally useless.
 * Trusting any progress forever therefore reintroduces an unbounded latency
 * queue inside the transport. This test pins a separate wall-clock lifetime for
 * a frame: even genuine trickle progress must end in an epoch restart at the
 * maximum send duration.
 */
static void trickle_progress_cannot_keep_one_frame_alive_forever(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  size_t index;
  fixture_init(&fixture);
  for (index = 0U; index < 11U; ++index) {
    fixture.fake.outcomes[index] =
        ITERATE_KIT_PCM_UPLINK_SEND_PROGRESS;
  }
  fixture.fake.outcome_count = 11U;
  submit_frame(&fixture, 101U);

  for (index = 0U; index < 10U; ++index) {
    CHECK(poll_at(&fixture, index * 100U) ==
        ITERATE_KIT_PCM_UPLINK_SENDER_PROGRESS);
  }
  CHECK(poll_at(
      &fixture, MAXIMUM_FRAME_SEND_DURATION_MS) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);
  CHECK(fixture.fake.calls == 10U);

  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.frames_sent == 0U);
  CHECK(metrics.frames_discarded == 1U);
  CHECK(metrics.send_failures == 0U);
  CHECK(metrics.restart_incidents == 1U);
  CHECK(metrics.frame_send_timeout_restarts == 1U);
  CHECK(metrics.last_restart_reason ==
      ITERATE_KIT_PCM_UPLINK_RESTART_FRAME_SEND_TIMEOUT);
}

/*
 * The peer-delivery guard needs the microphone timestamp at the precise moment
 * a complete WebSocket frame enters the local transport. Metrics alone are not
 * a composable boundary, and poll time after the lane slot is released loses
 * the frame's timestamp. This event test pins both values while also preserving
 * the crucial non-guarantee: local acceptance is not peer receipt.
 */
static void capture_age_is_measured_at_local_transport_acceptance(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_event event;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  fixture.fake.outcomes[1] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  fixture.fake.outcome_count = 2U;

  submit_frame_at(&fixture, 111U, 100U);
  CHECK(iterate_kit_pcm_uplink_sender_poll(
            &fixture.sender, 175U, &event) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);
  CHECK(event.transport_accepted);
  CHECK(event.capture_completed_at_ms == 100U);
  CHECK(event.transport_accepted_at_ms == 175U);
  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.last_transport_accept_age_ms == 75U);
  CHECK(metrics.maximum_transport_accept_age_ms == 75U);

  fixture.fake.first_frame = NULL;
  submit_frame_at(&fixture, 112U, 160U);
  CHECK(poll_at(&fixture, 180U) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);
  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.last_transport_accept_age_ms == 20U);
  CHECK(metrics.maximum_transport_accept_age_ms == 75U);
}

/*
 * The microphone producer and network consumer run on different ESP32 cores.
 * A network pass can sample its millisecond clock, then acquire a frame stamped
 * one tick later by the producer. That is scheduling skew—not a backwards
 * monotonic clock—and treating it as a local invariant failure permanently
 * bricks voice until reboot. The sender must normalize the acceptance boundary
 * to the capture timestamp, report zero age, and continue without a failure.
 */
static void a_newer_cross_task_capture_timestamp_is_age_zero(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_sender_event event;
  struct iterate_kit_pcm_uplink_sender_metrics metrics;
  fixture_init(&fixture);
  fixture.fake.outcomes[0] =
      ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
  fixture.fake.outcome_count = 1U;
  submit_frame_at(&fixture, 113U, 101U);

  CHECK(iterate_kit_pcm_uplink_sender_poll(
            &fixture.sender, 100U, &event) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);
  CHECK(event.transport_accepted);
  CHECK(event.capture_completed_at_ms == 101U);
  CHECK(event.transport_accepted_at_ms == 101U);
  iterate_kit_pcm_uplink_sender_metrics(
      &fixture.sender, &metrics);
  CHECK(metrics.last_transport_accept_age_ms == 0U);
  CHECK(metrics.maximum_transport_accept_age_ms == 0U);
  CHECK(metrics.send_failures == 0U);
}

int main(void) {
  temporary_deferrals_retain_then_send_the_same_frame();
  partial_transport_progress_retains_the_ring_slot();
  bounded_no_progress_time_requests_restart();
  disconnect_requests_restart_without_retry();
  restart_discards_the_entire_microphone_epoch();
  producer_backpressure_purges_before_an_old_frame_is_sent();
  disconnected_drain_includes_a_retained_frame();
  disconnected_drain_consumes_a_prior_overflow_request();
  a_normal_wifi_stall_does_not_restart_the_socket();
  one_rto_survives_but_ring_age_still_restarts();
  trickle_progress_cannot_keep_one_frame_alive_forever();
  capture_age_is_measured_at_local_transport_acceptance();
  a_newer_cross_task_capture_timestamp_is_age_zero();
  return 0;
}
