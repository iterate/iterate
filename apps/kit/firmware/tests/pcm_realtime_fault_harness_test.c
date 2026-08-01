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
  PCM_SLOT_COUNT = 32,
  MAXIMUM_SEQUENCE = 128,
  NO_PROGRESS_TIMEOUT_MS = 500,
  MAXIMUM_FRAME_SEND_DURATION_MS = 1000,
  MAXIMUM_CAPTURE_AGE_MS = 250,
};

enum rig_link_mode {
  RIG_LINK_ACCEPT = 0,
  RIG_LINK_WOULD_BLOCK,
  RIG_LINK_TRICKLE_PROGRESS,
  RIG_LINK_DISCONNECTED,
};

struct rig_link {
  uint32_t accepted_sequences[PCM_SLOT_COUNT];
  uint64_t accepted_at_ms[PCM_SLOT_COUNT];
  size_t accepted_count;
  size_t send_calls;
  uint64_t now_ms;
  enum rig_link_mode mode;
};

struct rig {
  uint64_t now_ms;
  uint64_t captured_at_ms[MAXIMUM_SEQUENCE];
  bool captured[MAXIMUM_SEQUENCE];
  struct iterate_kit_spsc_ring uplink;
  struct iterate_kit_spsc_ring downlink;
  struct iterate_kit_pcm_uplink_slot
      uplink_storage[PCM_SLOT_COUNT];
  struct iterate_kit_pcm_downlink_slot
      downlink_storage[PCM_SLOT_COUNT];
  size_t uplink_lengths[PCM_SLOT_COUNT];
  size_t downlink_lengths[PCM_SLOT_COUNT];
  struct iterate_kit_pcm_lane lane;
  struct rig_link link;
  struct iterate_kit_pcm_uplink_sender sender;
};

static uint32_t frame_sequence(const void *frame) {
  const uint8_t *bytes = frame;
  return (uint32_t)bytes[0] |
      ((uint32_t)bytes[1] << 8U) |
      ((uint32_t)bytes[2] << 16U) |
      ((uint32_t)bytes[3] << 24U);
}

static enum iterate_kit_pcm_uplink_send_outcome accept_frame(
    void *context, const void *frame, size_t frame_bytes) {
  struct rig_link *link = context;
  CHECK(link != NULL);
  CHECK(frame != NULL);
  CHECK(frame_bytes == ITERATE_KIT_PCM_V1_FRAME_BYTES);
  ++link->send_calls;
  if (link->mode == RIG_LINK_WOULD_BLOCK) {
    return
        ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
  }
  if (link->mode == RIG_LINK_TRICKLE_PROGRESS) {
    return ITERATE_KIT_PCM_UPLINK_SEND_PROGRESS;
  }
  if (link->mode == RIG_LINK_DISCONNECTED) {
    return ITERATE_KIT_PCM_UPLINK_SEND_DISCONNECTED;
  }
  CHECK(link->accepted_count < PCM_SLOT_COUNT);
  link->accepted_sequences[link->accepted_count] =
      frame_sequence(frame);
  link->accepted_at_ms[link->accepted_count] = link->now_ms;
  ++link->accepted_count;
  return ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
}

static void rig_init(struct rig *rig) {
  const struct iterate_kit_pcm_uplink_sender_options options = {
    .lane = &rig->lane,
    .send = accept_frame,
    .send_context = &rig->link,
    .restart_after_no_progress_ms = NO_PROGRESS_TIMEOUT_MS,
    .maximum_frame_send_duration_ms =
        MAXIMUM_FRAME_SEND_DURATION_MS,
    .maximum_capture_age_ms =
        MAXIMUM_CAPTURE_AGE_MS,
  };
  memset(rig, 0, sizeof(*rig));
  CHECK(iterate_kit_spsc_ring_init(
      &rig->uplink,
      rig->uplink_storage,
      sizeof(rig->uplink_storage[0]),
      PCM_SLOT_COUNT,
      rig->uplink_lengths) == ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_init(
      &rig->downlink,
      rig->downlink_storage,
      sizeof(rig->downlink_storage[0]),
      PCM_SLOT_COUNT,
      rig->downlink_lengths) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_lane_init(
      &rig->lane,
      &rig->uplink,
      &rig->downlink) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_uplink_sender_init(
      &rig->sender, &options) == ITERATE_KIT_OK);
}

static enum iterate_kit_status offer_capture_frame(
    struct rig *rig, uint32_t sequence) {
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES] = {0};
  enum iterate_kit_status status;
  CHECK(sequence < MAXIMUM_SEQUENCE);
  frame[0] = (uint8_t)sequence;
  frame[1] = (uint8_t)(sequence >> 8U);
  frame[2] = (uint8_t)(sequence >> 16U);
  frame[3] = (uint8_t)(sequence >> 24U);
  rig->captured_at_ms[sequence] = rig->now_ms;
  rig->captured[sequence] = true;
  status = iterate_kit_pcm_lane_submit_uplink_at(
      &rig->lane,
      frame,
      sizeof(frame),
      rig->now_ms);
  return status;
}

static void capture_frame(struct rig *rig, uint32_t sequence) {
  CHECK(offer_capture_frame(rig, sequence) == ITERATE_KIT_OK);
}

static enum iterate_kit_pcm_uplink_sender_poll_result
poll_network(struct rig *rig) {
  rig->link.now_ms = rig->now_ms;
  return iterate_kit_pcm_uplink_sender_poll(
      &rig->sender, rig->now_ms, NULL);
}

static void check_every_accepted_frame_was_fresh(
    const struct rig *rig) {
  size_t index;
  for (index = 0U;
       index < rig->link.accepted_count;
       ++index) {
    const uint32_t sequence =
        rig->link.accepted_sequences[index];
    CHECK(sequence < MAXIMUM_SEQUENCE);
    CHECK(rig->captured[sequence]);
    CHECK(rig->link.accepted_at_ms[index] >=
        rig->captured_at_ms[sequence]);
    CHECK(rig->link.accepted_at_ms[index] -
            rig->captured_at_ms[sequence] <
        MAXIMUM_CAPTURE_AGE_MS);
  }
}

/*
 * The microphone task can remain runnable while networking is starved by TLS,
 * Wi-Fi, display work, or another ESP32 task. A freshness policy based only on
 * ring fullness misses a short PTT utterance that ends after one queued frame,
 * allowing it to be transmitted much later. This simulated scheduling incident
 * requires capture time itself to bound validity and makes expiry a classified
 * epoch restart rather than silent loss.
 */
static void network_task_starvation_never_transmits_expired_audio(
    void) {
  struct rig rig;
  struct iterate_kit_pcm_uplink_sender_metrics sender_metrics;
  struct iterate_kit_pcm_lane_metrics lane_metrics;
  rig_init(&rig);

  rig.now_ms = 0U;
  capture_frame(&rig, 1U);

  /*
   * Model a runnable microphone owner and a starved network owner. A stopped
   * PTT epoch containing only one frame never fills the ring, so fullness
   * cannot be the freshness oracle.
   */
  rig.now_ms = MAXIMUM_CAPTURE_AGE_MS + 1U;
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);

  iterate_kit_pcm_uplink_sender_metrics(
      &rig.sender, &sender_metrics);
  iterate_kit_pcm_lane_metrics(&rig.lane, &lane_metrics);
  CHECK(rig.link.accepted_count == 0U);
  CHECK(sender_metrics.frames_sent == 0U);
  CHECK(sender_metrics.frames_discarded == 1U);
  CHECK(sender_metrics.send_failures == 0U);
  CHECK(sender_metrics.restart_incidents == 1U);
  CHECK(sender_metrics.capture_stale_restarts == 1U);
  CHECK(sender_metrics.last_restart_reason ==
      ITERATE_KIT_PCM_UPLINK_RESTART_CAPTURE_STALE);
  CHECK(sender_metrics.last_restart_frames_discarded == 1U);
  CHECK(sender_metrics.last_restart_oldest_capture_age_ms ==
      MAXIMUM_CAPTURE_AGE_MS + 1U);
  CHECK(lane_metrics.uplink.current_slots == 0U);
  check_every_accepted_frame_was_fresh(&rig);
}

/*
 * The freshness guard must not turn every momentary socket stall into audible
 * gaps or reconnect storms. Dropping immediately on would-block is simple but
 * unnecessarily loses a frame that remains within the conversation budget.
 * This control case proves one retained frame is delivered after a realistic
 * short pause, with no restart and with its measured age still demonstrably
 * fresh.
 */
static void ordinary_stall_retains_then_sends_one_fresh_frame(
    void) {
  struct rig rig;
  struct iterate_kit_pcm_uplink_sender_metrics sender_metrics;
  rig_init(&rig);
  rig.link.mode = RIG_LINK_WOULD_BLOCK;

  rig.now_ms = 0U;
  capture_frame(&rig, 1U);
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);

  rig.now_ms = 150U;
  rig.link.mode = RIG_LINK_ACCEPT;
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);

  iterate_kit_pcm_uplink_sender_metrics(
      &rig.sender, &sender_metrics);
  CHECK(rig.link.accepted_count == 1U);
  CHECK(rig.link.accepted_sequences[0] == 1U);
  CHECK(sender_metrics.frames_sent == 1U);
  CHECK(sender_metrics.frames_discarded == 0U);
  CHECK(sender_metrics.restart_incidents == 0U);
  CHECK(sender_metrics.send_failures == 0U);
  check_every_accepted_frame_was_fresh(&rig);
}

/*
 * During prolonged backpressure, continuous PTT capture can build a bounded
 * but already stale sequence behind the retained head. Flushing that FIFO when
 * the network recovers would replay old speech before the user's current words.
 * This incident proves the first expired frame invalidates the entire epoch and
 * that a post-reconnect frame can be accepted immediately without any survivor
 * from the backlog.
 */
static void blocked_socket_discards_the_backlog_then_sends_now(
    void) {
  struct rig rig;
  struct iterate_kit_pcm_uplink_sender_metrics sender_metrics;
  struct iterate_kit_pcm_lane_metrics lane_metrics;
  uint32_t sequence;
  rig_init(&rig);
  rig.link.mode = RIG_LINK_WOULD_BLOCK;

  rig.now_ms = 0U;
  capture_frame(&rig, 1U);
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  for (sequence = 2U; sequence <= 13U; ++sequence) {
    rig.now_ms = (uint64_t)(sequence - 1U) * 20U;
    capture_frame(&rig, sequence);
    CHECK(poll_network(&rig) ==
        ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED);
  }

  rig.now_ms = 260U;
  capture_frame(&rig, 14U);
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);
  CHECK(rig.link.accepted_count == 0U);

  rig.now_ms = 280U;
  rig.link.mode = RIG_LINK_ACCEPT;
  capture_frame(&rig, 15U);
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);

  iterate_kit_pcm_uplink_sender_metrics(
      &rig.sender, &sender_metrics);
  iterate_kit_pcm_lane_metrics(&rig.lane, &lane_metrics);
  CHECK(rig.link.accepted_count == 1U);
  CHECK(rig.link.accepted_sequences[0] == 15U);
  CHECK(sender_metrics.frames_sent == 1U);
  CHECK(sender_metrics.frames_discarded == 14U);
  CHECK(sender_metrics.restart_incidents == 1U);
  CHECK(sender_metrics.capture_stale_restarts == 1U);
  CHECK(sender_metrics.send_failures == 0U);
  CHECK(lane_metrics.uplink.current_slots == 0U);
  CHECK(lane_metrics.uplink.high_water_slots == 14U);
  check_every_accepted_frame_was_fresh(&rig);
}

/*
 * Partial writes can make the transport look healthy while the capture at the
 * head of the lane keeps aging and newer speech piles up behind it. Resetting
 * freshness on each written byte would let stale conversation masquerade as
 * progress. This test requires capture age to dominate transport activity:
 * all old frames are discarded before any can be called accepted.
 */
static void trickle_progress_cannot_turn_old_speech_into_new_speech(
    void) {
  struct rig rig;
  struct iterate_kit_pcm_uplink_sender_metrics sender_metrics;
  uint32_t sequence;
  rig_init(&rig);
  rig.link.mode = RIG_LINK_TRICKLE_PROGRESS;

  for (sequence = 1U; sequence <= 13U; ++sequence) {
    rig.now_ms = (uint64_t)(sequence - 1U) * 20U;
    capture_frame(&rig, sequence);
    CHECK(poll_network(&rig) ==
        ITERATE_KIT_PCM_UPLINK_SENDER_PROGRESS);
  }
  rig.now_ms = 260U;
  capture_frame(&rig, 14U);
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);

  iterate_kit_pcm_uplink_sender_metrics(
      &rig.sender, &sender_metrics);
  CHECK(rig.link.accepted_count == 0U);
  CHECK(sender_metrics.frames_discarded == 14U);
  CHECK(sender_metrics.capture_stale_restarts == 1U);
  CHECK(sender_metrics.frame_send_timeout_restarts == 0U);
  CHECK(sender_metrics.send_failures == 0U);
  check_every_accepted_frame_was_fresh(&rig);
}

/*
 * Under severe scheduling or memory pressure, a fixed ring must fail closed as
 * a realtime buffer rather than act like a lossless queue. Overwriting slots
 * would corrupt ownership; waiting for space would block the microphone; and
 * draining FIFO would emit stale speech. This scenario fills the audio budget
 * (one less than physical storage because the ordered end marker owns the last
 * slot), proves overflow requests an observable epoch reset, then verifies the
 * next current frame is the only one transmitted.
 */
static void full_static_ring_resets_instead_of_accumulating_delay(
    void) {
  struct rig rig;
  struct iterate_kit_pcm_uplink_sender_metrics sender_metrics;
  struct iterate_kit_pcm_lane_metrics lane_metrics;
  uint32_t sequence;
  rig_init(&rig);

  for (sequence = 1U;
       sequence < PCM_SLOT_COUNT;
       ++sequence) {
    rig.now_ms = (uint64_t)(sequence - 1U) * 20U;
    capture_frame(&rig, sequence);
  }
  rig.now_ms = (uint64_t)(PCM_SLOT_COUNT - 1U) * 20U;
  CHECK(offer_capture_frame(
      &rig, PCM_SLOT_COUNT) ==
      ITERATE_KIT_BACKPRESSURE);
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_RESTART);

  rig.now_ms += 20U;
  capture_frame(&rig, PCM_SLOT_COUNT + 1U);
  CHECK(poll_network(&rig) ==
      ITERATE_KIT_PCM_UPLINK_SENDER_SENT);

  iterate_kit_pcm_uplink_sender_metrics(
      &rig.sender, &sender_metrics);
  iterate_kit_pcm_lane_metrics(&rig.lane, &lane_metrics);
  CHECK(rig.link.accepted_count == 1U);
  CHECK(rig.link.accepted_sequences[0] ==
      PCM_SLOT_COUNT + 1U);
  CHECK(sender_metrics.frames_discarded == PCM_SLOT_COUNT - 1U);
  CHECK(sender_metrics.producer_backpressure_restarts == 1U);
  CHECK(sender_metrics.capture_stale_restarts == 0U);
  CHECK(sender_metrics.send_failures == 0U);
  CHECK(lane_metrics.uplink.producer_backpressure == 1U);
  CHECK(lane_metrics.uplink_epoch_reset_requests == 1U);
  CHECK(lane_metrics.uplink.current_slots == 0U);
  CHECK(lane_metrics.uplink.high_water_slots == PCM_SLOT_COUNT - 1U);
  check_every_accepted_frame_was_fresh(&rig);
}

int main(void) {
  /*
   * Each uplink slot already owns one full PCM frame. Timestamping it is needed
   * for the freshness proof, but padding or accidental metadata growth is
   * multiplied by every statically allocated slot on RAM-constrained devices.
   * Keep the incremental cost to one 64-bit capture timestamp; richer
   * diagnostics belong in aggregate counters, not per-frame storage.
   */
  _Static_assert(
      sizeof(struct iterate_kit_pcm_uplink_slot) <=
          ITERATE_KIT_PCM_V1_FRAME_BYTES + sizeof(uint64_t),
      "uplink timing metadata must remain an eight-byte-per-slot cost");
  network_task_starvation_never_transmits_expired_audio();
  ordinary_stall_retains_then_sends_one_fresh_frame();
  blocked_socket_discards_the_backlog_then_sends_now();
  trickle_progress_cannot_turn_old_speech_into_new_speech();
  full_static_ring_resets_instead_of_accumulating_delay();
  return 0;
}
