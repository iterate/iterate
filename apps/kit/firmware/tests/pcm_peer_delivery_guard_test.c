#include "iterate/kit/pcm_peer_delivery_guard.h"

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
  BARRIER_INTERVAL_FRAMES = 4,
  MAXIMUM_UNCONFIRMED_FRAMES = 8,
  MAXIMUM_CONFIRMATION_AGE_MS = 200,
  IDLE_PEER_PROBE_INTERVAL_MS = 500,
  IDLE_PEER_PROBE_TIMEOUT_MS = 100,
};

/*
 * Keep the guard test at the real sans-I/O WebSocket boundary. The raw writer
 * receives bytes produced by the production masking/framing code, which makes
 * these tests sensitive to ordering and payload-identity mistakes without
 * importing ESP-IDF or inventing a second implementation of the protocol.
 */
struct raw_writer {
  uint8_t bytes[256];
  size_t byte_count;
};

struct fixture {
  uint8_t transmit_storage[ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES)];
  uint8_t next_random;
  struct raw_writer raw;
  struct iterate_kit_websocket_tx tx;
  struct iterate_kit_pcm_peer_delivery_guard guard;
};

static enum iterate_kit_websocket_tx_raw_write_result
write_all(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct raw_writer *writer = context;
  CHECK(byte_count <= sizeof(writer->bytes) - writer->byte_count);
  memcpy(writer->bytes + writer->byte_count, bytes, byte_count);
  writer->byte_count += byte_count;
  *bytes_written = byte_count;
  return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
}

static enum iterate_kit_status fixed_random(
    void *context, uint8_t *bytes, size_t byte_count) {
  uint8_t *next = context;
  size_t index;
  for (index = 0U; index < byte_count; ++index) {
    bytes[index] = (*next)++;
  }
  return ITERATE_KIT_OK;
}

static void fixture_init(struct fixture *fixture) {
  struct iterate_kit_websocket_tx_options tx_options;
  struct iterate_kit_pcm_peer_delivery_guard_options options;
  memset(fixture, 0, sizeof(*fixture));
  fixture->next_random = 1U;
  tx_options =
      (struct iterate_kit_websocket_tx_options){
        .frame_storage = fixture->transmit_storage,
        .frame_storage_capacity =
            sizeof(fixture->transmit_storage),
        .raw_write = write_all,
        .raw_write_context = &fixture->raw,
        .random = fixed_random,
        .random_context = &fixture->next_random,
      };
  CHECK(iterate_kit_websocket_tx_init(
            &fixture->tx, &tx_options) == ITERATE_KIT_OK);
  options =
      (struct iterate_kit_pcm_peer_delivery_guard_options){
        .tx = &fixture->tx,
        .barrier_interval_frames = BARRIER_INTERVAL_FRAMES,
        .maximum_unconfirmed_frames =
            MAXIMUM_UNCONFIRMED_FRAMES,
        .maximum_barrier_delay_ms = 40U,
        .maximum_confirmation_age_ms =
            MAXIMUM_CONFIRMATION_AGE_MS,
        .idle_peer_probe_interval_ms =
            IDLE_PEER_PROBE_INTERVAL_MS,
        .idle_peer_probe_timeout_ms =
            IDLE_PEER_PROBE_TIMEOUT_MS,
      };
  CHECK(iterate_kit_pcm_peer_delivery_guard_init(
            &fixture->guard, &options) == ITERATE_KIT_OK);
  iterate_kit_pcm_peer_delivery_guard_reset(
      &fixture->guard, 7U);
}

static size_t unmask_single_control_frame(
    const struct raw_writer *writer,
    enum iterate_kit_websocket_opcode expected_opcode,
    uint8_t *payload,
    size_t payload_capacity) {
  size_t payload_size;
  size_t index;
  CHECK(writer->byte_count >= 6U);
  CHECK(writer->bytes[0] ==
      (uint8_t)(0x80U | (uint8_t)expected_opcode));
  CHECK((writer->bytes[1] & 0x80U) != 0U);
  payload_size = writer->bytes[1] & 0x7fU;
  CHECK(payload_size <= payload_capacity);
  CHECK(writer->byte_count == payload_size + 6U);
  for (index = 0U; index < payload_size; ++index) {
    payload[index] = writer->bytes[6U + index] ^
        writer->bytes[2U + (index % 4U)];
  }
  return payload_size;
}

/*
 * A pong must echo the actual payload put on the wire. Extracting it from the
 * masked client frame, instead of reaching into guard state, proves the test
 * peer observes only what a real RFC 6455 server would observe.
 */
static void send_pending_barrier(
    struct fixture *fixture,
    uint8_t *payload,
    size_t *payload_size) {
  enum iterate_kit_websocket_tx_result tx_result;
  do {
    tx_result =
        iterate_kit_websocket_tx_poll_control(&fixture->tx);
  } while (tx_result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(tx_result == ITERATE_KIT_WEBSOCKET_TX_SENT);
  *payload_size = unmask_single_control_frame(
      &fixture->raw,
      ITERATE_KIT_WEBSOCKET_PING,
      payload,
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES);
}

/*
 * Continuous push-to-talk should amortize confirmation overhead rather than
 * pinging for every 20 ms PCM frame. At the configured fourth frame the exact
 * production WebSocket transmitter must contain one barrier, while all four
 * frames remain conservatively unconfirmed until its pong returns.
 */
static void four_frames_queue_a_peer_delivery_barrier(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  uint32_t frame;
  fixture_init(&fixture);

  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 60U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);
  CHECK(payload_size > 0U);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.unconfirmed_frames == 4U);
  CHECK(metrics.maximum_unconfirmed_frames == 4U);
  CHECK(metrics.barriers_queued == 1U);
  CHECK(metrics.barriers_confirmed == 0U);
}

/*
 * Push-to-talk frequently ends after one or two frames. Waiting only for the
 * normal four-frame cadence would leave that final speech prefix below
 * TLS/lwIP with no proof of peer progress. Idle polling must therefore queue a
 * barrier at the age boundary, but not one millisecond early; that distinction
 * keeps short utterances safe without turning every frame into a ping.
 */
static void short_ptt_tail_queues_a_barrier_at_the_age_limit(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
            &fixture.guard, 100U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 139U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 140U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.unconfirmed_frames == 1U);
  CHECK(metrics.barriers_queued == 1U);
}

/*
 * TCP keepalive can prove that a network stack still acknowledges packets
 * while the application or WebSocket peer has stopped processing them. During
 * silence there are no PCM delivery barriers, so that half-open state would
 * otherwise survive until the next utterance or server downlink and add a
 * multi-second failure to the first word of a conversation.
 *
 * Start the policy clock with an empty generation, withhold every pong, and
 * prove that exactly one allocation-free WebSocket probe becomes due at the
 * interval boundary. The connection remains usable during its short response
 * allowance, then becomes RESTART—not FAILED—at the explicit liveness
 * deadline. Waiting for the next audio frame was rejected because liveness is
 * a property of the connection, not of microphone traffic.
 */
static void silent_half_open_peer_has_a_bounded_liveness_failure(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 1000U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            1000U + IDLE_PEER_PROBE_INTERVAL_MS - 1U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            1000U + IDLE_PEER_PROBE_INTERVAL_MS) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);
  CHECK(payload_size ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            1000U + IDLE_PEER_PROBE_INTERVAL_MS +
                IDLE_PEER_PROBE_TIMEOUT_MS - 1U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            1000U + IDLE_PEER_PROBE_INTERVAL_MS +
                IDLE_PEER_PROBE_TIMEOUT_MS) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_RESTART);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.idle_peer_probes_queued == 1U);
  CHECK(metrics.idle_peer_probes_confirmed == 0U);
  CHECK(metrics.idle_peer_probe_timeouts == 1U);
  CHECK(metrics.confirmation_timeouts == 0U);
  CHECK(metrics.unconfirmed_frames == 0U);
}

/*
 * A healthy silent connection should pay only one tiny control frame per
 * interval, not reconnect periodically. Echo the actual masked wire payload
 * and prove that its receipt starts a fresh silence interval. This catches the
 * tempting implementation that clears `barrier_outstanding` but forgets to
 * refresh the evidence clock, which would schedule another probe immediately
 * and then falsely time out a healthy peer.
 */
static void idle_peer_pong_starts_a_fresh_liveness_interval(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 1000U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            1000U + IDLE_PEER_PROBE_INTERVAL_MS) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);
  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard,
            payload,
            payload_size,
            1550U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            1550U + IDLE_PEER_PROBE_INTERVAL_MS - 1U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            1550U + IDLE_PEER_PROBE_INTERVAL_MS) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.idle_peer_probes_queued == 2U);
  CHECK(metrics.idle_peer_probes_confirmed == 1U);
  CHECK(metrics.idle_peer_probe_timeouts == 0U);
}

/*
 * Push-to-talk can begin while an idle liveness PING is already in flight.
 * RFC 6455 ordering then proves only the empty prefix before that PING; it must
 * not accidentally confirm microphone frames written afterward. Reusing the
 * audio barrier machinery is safe only if the first post-probe capture becomes
 * the oldest unconfirmed suffix when the pong arrives.
 */
static void idle_probe_pong_does_not_confirm_later_microphone_audio(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 1000U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            1000U + IDLE_PEER_PROBE_INTERVAL_MS) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);
  CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
            &fixture.guard, 1510U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard,
            payload,
            payload_size,
            1520U) == ITERATE_KIT_OK);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.idle_peer_probes_confirmed == 1U);
  CHECK(metrics.frames_confirmed == 0U);
  CHECK(metrics.unconfirmed_frames == 1U);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 1549U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 1550U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
}

/*
 * The microphone producer and socket owner use the same monotonic ESP timer,
 * but sample it on different cores. The producer can publish a frame stamped
 * 101 ms after the network task already sampled 100 ms for its bounded pass.
 * That is ordinary scheduling skew—not a clock regression. Treating unsigned
 * `now - capture` underflow as corruption used to turn one perfectly normal
 * PTT frame into a permanently latched fatal transport failure.
 *
 * Keep this defense in the guard even though the composed conductor also
 * advances its policy-time floor. The guard remains a public portable state
 * machine, and a future conductor refactor must not be able to reintroduce the
 * brick by omitting one outer clamp.
 */
static void producer_timestamp_ahead_of_owner_sample_has_zero_age(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  uint32_t frame;
  fixture_init(&fixture);

  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, 101U + frame) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 100U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);
  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard, payload, payload_size, 100U) ==
      ITERATE_KIT_OK);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.frames_confirmed ==
      BARRIER_INTERVAL_FRAMES);
  CHECK(metrics.unconfirmed_frames == 0U);
  CHECK(metrics.last_confirmation_oldest_age_ms == 0U);
  CHECK(metrics.confirmation_timeouts == 0U);
}

/*
 * The network can continue accepting PCM while a previously queued ping travels
 * through TLS/lwIP. RFC 6455 ordering proves only the four-frame prefix before
 * that ping. A tempting implementation that clears the entire eight-frame
 * window on pong would make the opaque suffix invisible and allow stale speech
 * to escape after a later stall.
 */
static void matching_pong_advances_only_its_ordered_prefix(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  uint32_t frame;
  fixture_init(&fixture);

  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 60U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);

  for (frame = BARRIER_INTERVAL_FRAMES;
       frame < MAXIMUM_UNCONFIRMED_FRAMES;
       ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 140U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_PAUSED);
  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard, payload, payload_size, 150U) ==
      ITERATE_KIT_OK);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.frames_confirmed == 4U);
  CHECK(metrics.unconfirmed_frames == 4U);
  CHECK(metrics.barriers_confirmed == 1U);
  CHECK(metrics.last_confirmation_oldest_age_ms == 150U);
  CHECK(metrics.maximum_confirmation_oldest_age_ms == 150U);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 150U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
}

/*
 * Once a pong confirms the prefix before its ping, freshness must be measured
 * from the first frame after that ping—not from either the old prefix or the
 * newest suffix frame. This boundary test catches both mistakes: reusing the old
 * timestamp would restart too early, while using the newest timestamp would
 * permit stale suffix audio to survive too long.
 */
static void confirmed_prefix_promotes_the_suffix_capture_timestamp(void) {
  struct fixture fixture;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  uint32_t frame;
  fixture_init(&fixture);

  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 60U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);
  CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
            &fixture.guard, 80U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
            &fixture.guard, 100U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard, payload, payload_size, 100U) ==
      ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 119U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 120U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 279U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 280U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_RESTART);
}

/*
 * Reconnects and unrelated protocol pings can produce pongs that are valid
 * WebSocket control frames but not evidence for this PCM prefix. Mutating one
 * byte models both a stale generation and an unsolicited peer pong: neither may
 * release admission pressure, and the mismatch must remain visible in metrics
 * without being classified as a fatal transport error.
 */
static void stale_or_unsolicited_pong_cannot_release_the_window(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  uint32_t frame;
  fixture_init(&fixture);

  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 60U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);
  payload[payload_size - 1U] ^= 1U;
  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard, payload, payload_size, 100U) ==
      ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.unconfirmed_frames == 4U);
  CHECK(metrics.frames_confirmed == 0U);
  CHECK(metrics.unmatched_pongs == 1U);
}

/*
 * A byte-perfect pong from the previous socket is more dangerous than random
 * unsolicited traffic because its barrier id can be reused after reset. The
 * connection generation is the only distinguishing evidence. Replay the exact
 * old wire payload—not a mutated approximation—to prove it cannot confirm the
 * new generation while the new generation's own pong still can.
 */
static void exact_old_generation_pong_cannot_confirm_new_audio(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t old_payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  uint8_t new_payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t old_payload_size = 0U;
  size_t new_payload_size = 0U;
  uint32_t frame;
  fixture_init(&fixture);

  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 60U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(
      &fixture, old_payload, &old_payload_size);

  iterate_kit_pcm_peer_delivery_guard_reset(
      &fixture.guard, 8U);
  fixture.raw.byte_count = 0U;
  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard,
              100U + (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 160U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(
      &fixture, new_payload, &new_payload_size);

  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard,
            old_payload,
            old_payload_size,
            170U) == ITERATE_KIT_UNAVAILABLE);
  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard,
            new_payload,
            new_payload_size,
            180U) == ITERATE_KIT_OK);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.frames_confirmed == 4U);
  CHECK(metrics.unconfirmed_frames == 0U);
  CHECK(metrics.frames_abandoned == 4U);
  CHECK(metrics.unmatched_pongs == 1U);
}

/*
 * A platform liveness PING and the delivery guard's barrier PING share one
 * intentionally bounded local-policy slot. The separate reply-PONG slot must
 * not hide this real collision: accepting more audio without a queued barrier
 * would make the unproven prefix unbounded. The guard therefore pauses PCM,
 * exposes the deferral, and retries after the earlier local probe leaves.
 */
static void occupied_control_slot_defers_without_skipping_the_barrier(void) {
  static const uint8_t liveness_ping_payload[] = {0xa5U};
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint32_t frame;
  fixture_init(&fixture);

  CHECK(iterate_kit_websocket_tx_queue_control(
            &fixture.tx,
            ITERATE_KIT_WEBSOCKET_PING,
            liveness_ping_payload,
            sizeof(liveness_ping_payload)) == ITERATE_KIT_OK);
  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 60U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_PAUSED);
  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.barrier_deferrals == 1U);
  CHECK(metrics.barriers_queued == 0U);

  CHECK(iterate_kit_websocket_tx_poll_control(
            &fixture.tx) == ITERATE_KIT_WEBSOCKET_TX_SENT);
  fixture.raw.byte_count = 0U;
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 61U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.barriers_queued == 1U);
}

/*
 * A dead radio may leave locally accepted bytes below every application queue.
 * When no pong proves progress by the freshness deadline, the only reliable
 * purge is to replace the connection. Restart is latched so a caller cannot
 * resume the same generation, and reset must account for every abandoned frame
 * before making the new generation ready.
 */
static void unconfirmed_audio_expires_and_reset_abandons_it(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint32_t frame;
  fixture_init(&fixture);

  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 60U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            MAXIMUM_CONFIRMATION_AGE_MS - 1U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, MAXIMUM_CONFIRMATION_AGE_MS) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_RESTART);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, MAXIMUM_CONFIRMATION_AGE_MS + 1U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_RESTART);

  iterate_kit_pcm_peer_delivery_guard_reset(
      &fixture.guard, 8U);
  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.confirmation_timeouts == 1U);
  CHECK(metrics.frames_abandoned == 4U);
  CHECK(metrics.last_timeout_oldest_age_ms ==
      MAXIMUM_CONFIRMATION_AGE_MS);
  CHECK(metrics.last_reset_frames_abandoned == 4U);
  CHECK(metrics.unconfirmed_frames == 0U);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 1000U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_READY);
}

/*
 * A pong can already be in flight when the freshness deadline makes us replace
 * the connection. Accepting it after RESTART has latched would relabel stale
 * speech as confirmed and erase the very bytes the reset path must report as
 * abandoned. The latch is therefore a one-way generation boundary: even a
 * byte-perfect late pong remains protocol noise until reset creates the next
 * connection generation.
 */
static void late_pong_cannot_reverse_a_latched_restart(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint8_t payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size = 0U;
  uint32_t frame;
  fixture_init(&fixture);

  for (frame = 0U; frame < BARRIER_INTERVAL_FRAMES; ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, (uint64_t)frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, 60U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED);
  send_pending_barrier(&fixture, payload, &payload_size);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard, MAXIMUM_CONFIRMATION_AGE_MS) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_RESTART);
  CHECK(iterate_kit_pcm_peer_delivery_guard_receive_pong(
            &fixture.guard,
            payload,
            payload_size,
            MAXIMUM_CONFIRMATION_AGE_MS + 1U) ==
      ITERATE_KIT_UNAVAILABLE);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.unconfirmed_frames == 4U);
  CHECK(metrics.frames_confirmed == 0U);
  CHECK(metrics.unmatched_pongs == 1U);
  CHECK(metrics.confirmation_timeouts == 1U);
  CHECK(iterate_kit_pcm_peer_delivery_guard_poll(
            &fixture.guard,
            MAXIMUM_CONFIRMATION_AGE_MS + 2U) ==
      ITERATE_KIT_PCM_PEER_DELIVERY_RESTART);
}

/*
 * Platform cleanup can call reset once while closing a failed socket and again
 * while publishing its replacement. The second reset has no audio to abandon;
 * overwriting the last non-empty incident with zero would make the diagnostic
 * record deny the loss that just occurred. Lifetime totals and the last
 * incident must therefore survive housekeeping resets that abandon nothing.
 */
static void empty_reset_preserves_the_last_abandonment_incident(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
            &fixture.guard, 10U) == ITERATE_KIT_OK);
  iterate_kit_pcm_peer_delivery_guard_reset(
      &fixture.guard, 8U);
  iterate_kit_pcm_peer_delivery_guard_reset(
      &fixture.guard, 9U);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.frames_abandoned == 1U);
  CHECK(metrics.last_reset_frames_abandoned == 1U);
}

/*
 * record_accept() is the admission boundary after a complete local WebSocket
 * write. Rejecting a non-monotonic capture timestamp prevents age accounting
 * from moving backwards; rejecting the ninth unconfirmed frame enforces the
 * hard latency window even if a caller accidentally polls in the wrong order.
 * Neither expected rejection may mutate the accepted-frame count.
 */
static void record_accept_enforces_time_and_window_invariants(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_peer_delivery_guard_metrics metrics;
  uint32_t frame;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
            &fixture.guard, 100U) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
            &fixture.guard, 99U) ==
      ITERATE_KIT_STATE_ERROR);
  for (frame = 1U;
       frame < MAXIMUM_UNCONFIRMED_FRAMES;
       ++frame) {
    CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
              &fixture.guard, 100U + frame * 20U) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_pcm_peer_delivery_guard_record_accept(
            &fixture.guard, 1000U) ==
      ITERATE_KIT_BACKPRESSURE);

  iterate_kit_pcm_peer_delivery_guard_metrics(
      &fixture.guard, &metrics);
  CHECK(metrics.unconfirmed_frames ==
      MAXIMUM_UNCONFIRMED_FRAMES);
  CHECK(metrics.maximum_unconfirmed_frames ==
      MAXIMUM_UNCONFIRMED_FRAMES);
}

int main(void) {
  /*
   * The guard runs beside fixed PCM rings on a small device. This gate prevents
   * future observability fields from quietly turning a bounded state machine
   * into material permanent RAM growth. The limit rose from 128 to 160 bytes
   * when idle peer liveness added one 64-bit evidence clock, two policy knobs,
   * and three saturating incident counters. That 32-byte cost is deliberate:
   * relying on TCP keepalive left silent half-open sockets unbounded, while
   * omitting the counters would make the new recovery path unprovable during
   * endurance runs. Larger designs still need another explicit budget decision.
   */
  _Static_assert(
      sizeof(struct iterate_kit_pcm_peer_delivery_guard) <= 160U,
      "peer delivery state must stay below 160 bytes");
  four_frames_queue_a_peer_delivery_barrier();
  short_ptt_tail_queues_a_barrier_at_the_age_limit();
  silent_half_open_peer_has_a_bounded_liveness_failure();
  idle_peer_pong_starts_a_fresh_liveness_interval();
  idle_probe_pong_does_not_confirm_later_microphone_audio();
  producer_timestamp_ahead_of_owner_sample_has_zero_age();
  matching_pong_advances_only_its_ordered_prefix();
  confirmed_prefix_promotes_the_suffix_capture_timestamp();
  stale_or_unsolicited_pong_cannot_release_the_window();
  exact_old_generation_pong_cannot_confirm_new_audio();
  occupied_control_slot_defers_without_skipping_the_barrier();
  unconfirmed_audio_expires_and_reset_abandons_it();
  late_pong_cannot_reverse_a_latched_restart();
  empty_reset_preserves_the_last_abandonment_incident();
  record_accept_enforces_time_and_window_invariants();
  return 0;
}
