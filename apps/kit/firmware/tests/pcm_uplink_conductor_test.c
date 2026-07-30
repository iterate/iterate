#include "iterate/kit/pcm_uplink_conductor.h"

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
  SLOT_COUNT = 8,
  RAW_CAPTURE_CAPACITY = 16384,
  BARRIER_INTERVAL_FRAMES = 2,
  MAXIMUM_UNCONFIRMED_FRAMES = 4,
};

struct fake_raw_writer {
  uint8_t bytes[RAW_CAPTURE_CAPACITY];
  size_t byte_count;
  size_t maximum_write;
  uint32_t writes_to_defer;
  uint32_t writes_to_disconnect;
  uint32_t invalid_zero_writes;
};

struct parsed_frame {
  enum iterate_kit_websocket_opcode opcode;
  uint8_t payload[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  size_t payload_size;
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
  uint8_t transmit_storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
          ITERATE_KIT_PCM_V1_FRAME_BYTES)];
  uint8_t next_random;
  struct fake_raw_writer raw;
  struct iterate_kit_websocket_tx tx;
  struct iterate_kit_pcm_uplink_conductor conductor;
};

static enum iterate_kit_websocket_tx_raw_write_result
fake_raw_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct fake_raw_writer *writer = context;
  size_t written;
  *bytes_written = 0U;
  if (writer->invalid_zero_writes > 0U) {
    writer->invalid_zero_writes--;
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
  }
  if (writer->writes_to_disconnect > 0U) {
    writer->writes_to_disconnect--;
    return ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED;
  }
  if (writer->writes_to_defer > 0U) {
    writer->writes_to_defer--;
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WOULD_BLOCK;
  }
  written = byte_count < writer->maximum_write
      ? byte_count
      : writer->maximum_write;
  CHECK(written > 0U);
  CHECK(written <=
      sizeof(writer->bytes) - writer->byte_count);
  memcpy(
      writer->bytes + writer->byte_count, bytes, written);
  writer->byte_count += written;
  *bytes_written = written;
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
  struct iterate_kit_pcm_uplink_conductor_options
      conductor_options;
  memset(fixture, 0, sizeof(*fixture));
  fixture->raw.maximum_write = SIZE_MAX;
  fixture->next_random = 1U;

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

  tx_options =
      (struct iterate_kit_websocket_tx_options){
        .frame_storage = fixture->transmit_storage,
        .frame_storage_capacity =
            sizeof(fixture->transmit_storage),
        .raw_write = fake_raw_write,
        .raw_write_context = &fixture->raw,
        .random = fixed_random,
        .random_context = &fixture->next_random,
      };
  CHECK(iterate_kit_websocket_tx_init(
            &fixture->tx, &tx_options) == ITERATE_KIT_OK);

  conductor_options =
      (struct iterate_kit_pcm_uplink_conductor_options){
        .lane = &fixture->lane,
        .tx = &fixture->tx,
        .restart_after_no_progress_ms = 40U,
        .maximum_frame_send_duration_ms = 80U,
        .maximum_capture_age_ms = 200U,
        .barrier_interval_frames =
            BARRIER_INTERVAL_FRAMES,
        .maximum_unconfirmed_frames =
            MAXIMUM_UNCONFIRMED_FRAMES,
        .maximum_barrier_delay_ms = 30U,
        .maximum_confirmation_age_ms = 100U,
        .idle_peer_probe_interval_ms = 500U,
        .idle_peer_probe_timeout_ms = 100U,
        .maximum_work_steps = 16U,
      };
  CHECK(iterate_kit_pcm_uplink_conductor_init(
            &fixture->conductor,
            &conductor_options) == ITERATE_KIT_OK);
}

static void begin_generation(
    struct fixture *fixture, uint32_t generation) {
  uint32_t discarded = UINT32_MAX;
  CHECK(iterate_kit_pcm_uplink_conductor_begin_generation(
            &fixture->conductor,
            generation,
            &discarded) == ITERATE_KIT_OK);
  CHECK(discarded == 0U);
}

static enum iterate_kit_status try_submit_frame(
    struct fixture *fixture,
    uint8_t seed,
    uint64_t capture_completed_at_ms) {
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  size_t index;
  for (index = 0U; index < sizeof(frame); ++index) {
    frame[index] = (uint8_t)(seed + index);
  }
  return iterate_kit_pcm_lane_submit_uplink_at(
      &fixture->lane,
      frame,
      sizeof(frame),
      capture_completed_at_ms);
}

static void submit_frame(
    struct fixture *fixture,
    uint8_t seed,
    uint64_t capture_completed_at_ms) {
  CHECK(try_submit_frame(
            fixture, seed, capture_completed_at_ms) ==
      ITERATE_KIT_OK);
}

/*
 * Decode bytes seen by the fake server, rather than peeking into transmitter
 * state. That keeps generation and ordering tests honest: they prove what a
 * real RFC 6455 peer could observe after client masking and extended-length
 * framing, not merely what the firmware intended to queue.
 */
static bool parse_frame(
    const struct fake_raw_writer *writer,
    size_t *offset,
    struct parsed_frame *frame) {
  size_t cursor = *offset;
  size_t payload_size;
  size_t mask_offset;
  size_t payload_offset;
  size_t index;
  if (cursor == writer->byte_count) {
    return false;
  }
  CHECK(writer->byte_count - cursor >= 6U);
  frame->opcode =
      (enum iterate_kit_websocket_opcode)
          (writer->bytes[cursor] & 0x0fU);
  CHECK((writer->bytes[cursor + 1U] & 0x80U) != 0U);
  payload_size = writer->bytes[cursor + 1U] & 0x7fU;
  if (payload_size == 126U) {
    CHECK(writer->byte_count - cursor >= 8U);
    payload_size =
        ((size_t)writer->bytes[cursor + 2U] << 8U) |
        writer->bytes[cursor + 3U];
    mask_offset = cursor + 4U;
  } else {
    CHECK(payload_size < 126U);
    mask_offset = cursor + 2U;
  }
  payload_offset = mask_offset + 4U;
  CHECK(payload_size <= sizeof(frame->payload));
  CHECK(payload_size <=
      writer->byte_count - payload_offset);
  for (index = 0U; index < payload_size; ++index) {
    frame->payload[index] =
        writer->bytes[payload_offset + index] ^
        writer->bytes[mask_offset + (index % 4U)];
  }
  frame->payload_size = payload_size;
  *offset = payload_offset + payload_size;
  return true;
}

static void find_last_ping(
    const struct fake_raw_writer *writer,
    uint8_t *payload,
    size_t *payload_size) {
  struct parsed_frame frame;
  size_t offset = 0U;
  bool found = false;
  while (parse_frame(writer, &offset, &frame)) {
    if (frame.opcode == ITERATE_KIT_WEBSOCKET_PING) {
      memcpy(payload, frame.payload, frame.payload_size);
      *payload_size = frame.payload_size;
      found = true;
    }
  }
  CHECK(found);
}

/*
 * The microphone and network tasks run on different ESP32 cores. The network
 * task can sample 100 ms and then acquire a frame the producer completed at
 * 101 ms. Treating this ordinary scheduling race as a backwards clock poisons
 * the peer guard immediately after a successful send. The composed policy must
 * advance its time floor to the producer boundary and remain usable.
 */
static void newer_capture_timestamp_does_not_poison_guard(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x31U, 101U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 100U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 100U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);

  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.frames_sent == 1U);
  CHECK(metrics.sender.send_failures == 0U);
  CHECK(metrics.peer_delivery.unconfirmed_frames == 1U);
  CHECK(metrics.policy_time_normalizations == 1U);
  CHECK(metrics.maximum_policy_time_adjustment_ms == 1U);
  CHECK(metrics.owner_clock_regressions == 0U);
}

/*
 * Producer skew may move the policy floor ahead, but the connection owner's
 * own clock samples still have to be monotonic. Silently clamping a sample
 * below the previous owner sample would hide a broken time source and disable
 * every age deadline. This test protects the distinction: equal cached samples
 * are valid; an actually older later sample is a fatal local invariant.
 */
static void true_owner_clock_regression_is_not_normalized(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 100U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 99U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.owner_clock_regressions == 1U);
}

/*
 * A TCP/TLS stack may accept microphone bytes while the route is black-holed.
 * If its ping never returns, preserving the socket lets those old words escape
 * in a burst when Wi-Fi recovers. The timeout must atomically abandon the peer
 * prefix and every application frame, after which a new generation can carry
 * only newly captured audio.
 */
static void confirmation_timeout_purges_old_epoch_and_recovers(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x10U, 0U);
  submit_frame(&fixture, 0x20U, 20U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  submit_frame(&fixture, 0x30U, 40U);
  submit_frame(&fixture, 0x40U, 60U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 60U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);

  /*
   * This fifth frame is deliberately waiting in the application ring at the
   * confirmation deadline. A reconnect that clears only opaque socket buffers
   * would replay it immediately on the fresh connection and still produce
   * delayed conversation.
   */
  submit_frame(&fixture, 0x50U, 90U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 100U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.peer_delivery.confirmation_timeouts == 1U);
  CHECK(metrics.peer_delivery.frames_abandoned == 4U);
  CHECK(metrics.sender.frames_discarded == 1U);

  fixture.raw.byte_count = 0U;
  begin_generation(&fixture, 2U);
  submit_frame(&fixture, 0xa0U, 110U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 110U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload_size == ITERATE_KIT_PCM_V1_FRAME_BYTES);
  CHECK(frame.payload[0] == 0xa0U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
}

/*
 * Barrier ids restart from one on each socket. Without a connection generation
 * in the proof payload, a delayed pong from the abandoned socket can release
 * the new socket's unconfirmed window. Replay the exact old on-wire payload to
 * prove only the new generation's pong grants admission.
 */
static void old_generation_pong_cannot_confirm_new_audio(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  uint8_t old_ping[
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES];
  uint8_t new_ping[
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES];
  size_t old_ping_size = 0U;
  size_t new_ping_size = 0U;
  uint32_t discarded = UINT32_MAX;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x11U, 0U);
  submit_frame(&fixture, 0x12U, 20U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  find_last_ping(
      &fixture.raw, old_ping, &old_ping_size);

  CHECK(iterate_kit_pcm_uplink_conductor_abandon_generation(
            &fixture.conductor,
            &discarded) == ITERATE_KIT_OK);
  CHECK(discarded == 0U);
  fixture.raw.byte_count = 0U;
  begin_generation(&fixture, 2U);
  submit_frame(&fixture, 0x21U, 100U);
  submit_frame(&fixture, 0x22U, 120U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 120U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  find_last_ping(
      &fixture.raw, new_ping, &new_ping_size);

  CHECK(iterate_kit_pcm_uplink_conductor_receive_pong(
            &fixture.conductor,
            old_ping,
            old_ping_size,
            130U) == ITERATE_KIT_UNAVAILABLE);
  CHECK(iterate_kit_pcm_uplink_conductor_receive_pong(
            &fixture.conductor,
            new_ping,
            new_ping_size,
            140U) == ITERATE_KIT_OK);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.peer_delivery.frames_abandoned == 2U);
  CHECK(metrics.peer_delivery.frames_confirmed == 2U);
  CHECK(metrics.peer_delivery.unmatched_pongs == 1U);
  CHECK(metrics.peer_delivery.unconfirmed_frames == 0U);
}

/*
 * A disconnected byte stream is expected recovery; a raw writer that claims
 * success while accepting zero bytes violates the local callback contract.
 * Both paths abandon stale audio, but only the latter belongs in the generic
 * failure signal. This prevents reconnect logic from laundering a firmware
 * defect into an ordinary Wi-Fi incident.
 */
static void invalid_raw_writer_result_is_failed_not_restart(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  fixture.raw.invalid_zero_writes = 1U;
  submit_frame(&fixture, 0x71U, 10U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 10U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.send_failures == 1U);
  CHECK(metrics.sender.restart_incidents == 0U);
  CHECK(metrics.sender.frames_discarded == 1U);
}

/*
 * When the socket disappears during the first frame, retaining later ring
 * entries would make them the first speech on the replacement connection.
 * The conductor must reuse the sender's whole-epoch purge and classify the
 * incident specifically as a transport disconnect.
 */
static void disconnect_purges_the_whole_microphone_epoch(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  fixture.raw.writes_to_disconnect = 1U;
  submit_frame(&fixture, 0x81U, 10U);
  submit_frame(&fixture, 0x82U, 20U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.restart_incidents == 1U);
  CHECK(metrics.sender.transport_disconnect_restarts == 1U);
  CHECK(metrics.sender.frames_discarded == 2U);
  CHECK(metrics.sender.last_restart_frames_discarded == 2U);
}

/*
 * A nonblocking TLS write can accept only part of a 656-byte PCM WebSocket
 * frame. If the delivery barrier becomes due while that frame owns the stream,
 * RFC 6455 forbids inserting the PING into its continuation bytes; but delaying
 * the PING until after later PCM would invalidate the peer-proof boundary.
 *
 * Force many short writes and a one-write cooperative budget, then inspect the
 * actual masked wire. The only legal order is two complete PCM frames, their
 * barrier, and then the third PCM frame. This is the composition invariant that
 * separate sender, guard, and transmitter unit tests cannot prove.
 */
static void partial_pcm_finishes_before_its_barrier_and_later_audio(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  uint32_t polls;
  fixture_init(&fixture);
  fixture.raw.maximum_write = 97U;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x11U, 0U);
  submit_frame(&fixture, 0x22U, 20U);
  submit_frame(&fixture, 0x33U, 40U);

  /*
   * Finish frame one while its age is zero, then let exactly one short write
   * start frame two. Advancing to the 30 ms barrier deadline at that point
   * makes control become due while an RFC 6455 data frame owns the stream.
   */
  for (polls = 0U; polls < 16U; ++polls) {
    const enum iterate_kit_pcm_uplink_conductor_poll_result
        result = iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 0U);
    CHECK(result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
    iterate_kit_pcm_uplink_conductor_metrics(
        &fixture.conductor, &metrics);
    if (metrics.sender.frames_sent == 1U) {
      break;
    }
  }
  CHECK(polls < 16U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(
      fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 30U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.tx.control_pending);
  CHECK(
      fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA);

  for (polls = 0U; polls < 64U; ++polls) {
    const enum iterate_kit_pcm_uplink_conductor_poll_result
        result = iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 30U);
    CHECK(
        result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS ||
        result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);
    if (result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE) {
      break;
    }
  }
  CHECK(polls < 64U);
  CHECK(
      fixture.raw.byte_count ==
      3U * ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
               ITERATE_KIT_PCM_V1_FRAME_BYTES) +
          ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
              ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES));

  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0x11U);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0x22U);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_PING);
  CHECK(
      frame.payload_size ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0x33U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
}

/*
 * A black-holed route can accept the PCM frames into its TCP send buffer and
 * then become unwritable exactly when the delivery-barrier PING takes the
 * WebSocket transmitter. The PING is useful evidence, but it must never become
 * a loophole in the older 100 ms audio-freshness deadline: waiting for TCP's
 * own retransmission timeout could retain speech for minutes and replay it
 * when the network returns.
 *
 * Stop the first conductor pass after it has queued the barrier, then make
 * every control write report EAGAIN. The peer-confirmation deadline must still
 * replace the socket and purge the unproved prefix. An alternative
 * control-frame retry counter would measure scheduler attempts instead of
 * elapsed audio age, and would therefore change behavior with FreeRTOS tick
 * rate; the existing capture-time deadline is the invariant that matters.
 */
static void blocked_barrier_cannot_suspend_audio_freshness_deadline(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  fixture.conductor.maximum_work_steps = 3U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x21U, 0U);
  submit_frame(&fixture, 0x22U, 20U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.tx.control_pending);

  fixture.raw.writes_to_defer = UINT32_MAX;
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 101U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);

  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.peer_delivery.confirmation_timeouts == 1U);
  CHECK(metrics.peer_delivery.frames_abandoned == 2U);
  CHECK(metrics.peer_delivery.unconfirmed_frames == 0U);
}

/*
 * EAGAIN is not the only way a control write can monopolise the transmitter.
 * A congested TLS path may accept one byte per scheduler pass, which looks like
 * continuous progress even though a small PING can then take longer than the
 * audio confirmation budget. Progress is deliberately not treated as proof of
 * freshness: once the oldest microphone frame reaches 100 ms, the socket must
 * still be replaced rather than rewarding a trickle that can replay old words.
 */
static void trickling_barrier_cannot_suspend_audio_freshness_deadline(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  fixture.conductor.maximum_work_steps = 3U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x31U, 0U);
  submit_frame(&fixture, 0x32U, 20U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.tx.control_pending);

  fixture.raw.maximum_write = 1U;
  fixture.conductor.maximum_work_steps = 1U;
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 101U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);

  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.peer_delivery.confirmation_timeouts == 1U);
  CHECK(metrics.peer_delivery.frames_abandoned == 2U);
}

/*
 * Delivery barriers and platform liveness PINGs deliberately share one local
 * control slot so a stalled network cannot grow a control backlog. The hard
 * case is a due barrier colliding with a liveness PING whose first write would
 * block: skipping the barrier makes peer-unconfirmed audio unbounded, while
 * waiting for it without draining the older PING deadlocks the lane.
 *
 * The conductor must drain the finite older obligation, queue the barrier, and
 * keep the third PCM frame behind both. A single deferred raw write models the
 * normal lwIP EAGAIN path and must remain recoverable rather than fatal.
 */
static void control_collision_defers_without_deadlock_or_reordering(
    void) {
  static const uint8_t liveness_payload[] = {0xa5U};
  struct fixture fixture;
  struct parsed_frame frame;
  size_t offset = 0U;
  fixture_init(&fixture);
  fixture.conductor.maximum_work_steps = 2U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x41U, 0U);
  submit_frame(&fixture, 0x42U, 20U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);

  CHECK(iterate_kit_websocket_tx_queue_control(
            &fixture.tx,
            ITERATE_KIT_WEBSOCKET_PING,
            liveness_payload,
            sizeof(liveness_payload)) == ITERATE_KIT_OK);
  fixture.raw.writes_to_defer = 1U;
  submit_frame(&fixture, 0x43U, 40U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 40U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 40U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 40U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 40U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);

  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0x41U);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0x42U);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_PING);
  CHECK(frame.payload_size == sizeof(liveness_payload));
  CHECK(frame.payload[0] == liveness_payload[0]);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_PING);
  CHECK(
      frame.payload_size ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0x43U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
}

/*
 * Reconnect can happen after some masked bytes of a PCM frame have entered the
 * old TLS stream. Those bytes cannot be completed on a replacement socket: a
 * continuation without its old header would corrupt framing, while replaying
 * from byte zero would duplicate speech. Closing the old socket destroys its
 * opaque prefix; abandoning the generation must simultaneously release the
 * retained ring slot, every later microphone frame, and transmitter state.
 *
 * Reset the fake server capture exactly where a real socket close creates a
 * new byte stream, then prove generation two begins with only new audio.
 */
static void generation_change_destroys_a_partial_old_frame(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  size_t old_socket_bytes;
  uint32_t discarded = UINT32_MAX;
  fixture_init(&fixture);
  fixture.raw.maximum_write = 37U;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x61U, 0U);
  submit_frame(&fixture, 0x62U, 20U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  old_socket_bytes = fixture.raw.byte_count;
  CHECK(old_socket_bytes == 37U);
  CHECK(
      old_socket_bytes <
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
          ITERATE_KIT_PCM_V1_FRAME_BYTES));

  CHECK(iterate_kit_pcm_uplink_conductor_abandon_generation(
            &fixture.conductor,
            &discarded) == ITERATE_KIT_OK);
  CHECK(discarded == 2U);
  CHECK(
      fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE);

  fixture.raw.byte_count = 0U;
  fixture.raw.maximum_write = SIZE_MAX;
  begin_generation(&fixture, 2U);
  submit_frame(&fixture, 0xa1U, 30U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 30U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 30U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);

  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0xa1U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.frames_discarded == 2U);
  CHECK(metrics.sender.frames_sent == 1U);
}

/*
 * A long push-to-talk can fill the application ring while the socket is part
 * way through an older frame. The producer cannot mutate consumer ownership,
 * so it raises an epoch-reset request after dropping the newest frame. Merely
 * clearing the ring at that point would leave the old partial WebSocket frame
 * resumable and let stale speech escape later.
 *
 * Fill the ring behind a retained partial frame and force one producer
 * backpressure event. The conductor must classify this as a socket-replacement
 * recovery, discard all eight retained/queued frames, and reset transmitter
 * state. Only closing the real socket can destroy the 37 bytes already below
 * us, which the fake link models by starting a fresh capture for generation
 * two.
 */
static void producer_epoch_reset_mid_partial_frame_replaces_socket(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  uint32_t frame_index;
  fixture_init(&fixture);
  fixture.raw.maximum_write = 37U;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x70U, 0U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 0U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.raw.byte_count == 37U);

  for (frame_index = 1U;
       frame_index < SLOT_COUNT;
       ++frame_index) {
    submit_frame(
        &fixture,
        (uint8_t)(0x70U + frame_index),
        (uint64_t)frame_index * 20U);
  }
  {
    uint8_t overflow_frame[ITERATE_KIT_PCM_V1_FRAME_BYTES] = {0};
    CHECK(iterate_kit_pcm_lane_submit_uplink_at(
              &fixture.lane,
              overflow_frame,
              sizeof(overflow_frame),
              160U) == ITERATE_KIT_BACKPRESSURE);
  }

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 160U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
  CHECK(
      fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.restart_incidents == 1U);
  CHECK(metrics.sender.producer_backpressure_restarts == 1U);
  CHECK(metrics.sender.frames_discarded == SLOT_COUNT);
  CHECK(
      metrics.sender.last_restart_frames_discarded ==
      SLOT_COUNT);

  fixture.raw.byte_count = 0U;
  fixture.raw.maximum_write = SIZE_MAX;
  begin_generation(&fixture, 2U);
  submit_frame(&fixture, 0xb1U, 170U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 170U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0xb1U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
}

/*
 * A silent TCP connection can remain ACK-responsive after the remote
 * WebSocket application wedges. This is the integration-level proof that the
 * portable conductor continues polling peer liveness when the microphone ring
 * is empty: one PING is framed through the real transmitter, no audio storage
 * is acquired, and a withheld PONG abandons the generation at the configured
 * deadline as expected network recovery.
 *
 * Putting this only in ESP-IDF would make the guarantee depend on scheduler
 * timing and hardware. Putting a second keepalive beside the conductor was
 * rejected because two independent control writers could collide or disagree
 * about which timeout owns the socket.
 */
static void idle_half_open_generation_restarts_without_audio(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct iterate_kit_spsc_ring_metrics ring_metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 1000U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 1499U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 1500U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_PING);
  CHECK(
      frame.payload_size ==
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
  iterate_kit_spsc_ring_metrics(
      &fixture.uplink, &ring_metrics);
  CHECK(ring_metrics.current_slots == 0U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 1599U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 1600U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
  CHECK(!fixture.conductor.generation_active);

  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.frames_sent == 0U);
  CHECK(metrics.sender.frames_discarded == 0U);
  CHECK(metrics.peer_delivery.idle_peer_probes_queued == 1U);
  CHECK(metrics.peer_delivery.idle_peer_probes_confirmed == 0U);
  CHECK(metrics.peer_delivery.idle_peer_probe_timeouts == 1U);
}

static uint32_t next_fault_choice(uint32_t *state) {
  /*
   * This is a reproducible state-space sampler, not entropy. A fixed generator
   * makes any discovered interleaving replayable from its scenario/step while
   * still mixing producer, transport, pong, and clock choices more densely
   * than a hand-written list. Unsigned overflow is the specified LCG modulus.
   */
  *state = (*state * 1664525U) + 1013904223U;
  return *state;
}

/*
 * RESTART is allowed for radio loss, stale capture, peer-confirmation expiry,
 * and producer overflow; FAILED is reserved for a violated local contract.
 * That distinction is easy to preserve in isolated unit tests yet lose in the
 * conductor's ordering—for example, a PONG arriving beside a partial write or
 * a +1 ms cross-core producer timestamp once bricked the generation.
 *
 * Exercise 16,384 deterministic legal interleavings of monotonic clocks,
 * monotonic-or-slightly-ahead capture stamps, full/short/EAGAIN/disconnected
 * writes, bounded-ring overflow, and matching/replayed/unsolicited PONGs.
 * Every recoverable incident starts a strictly newer socket generation. This
 * is a bounded model check rather than a claim to prove arbitrary C execution;
 * its job is to keep the public failure taxonomy honest as ordering changes.
 */
static void legal_fault_interleavings_never_latch_local_failure(
    void) {
  enum {
    SCENARIO_COUNT = 8,
    STEPS_PER_SCENARIO = 2048,
  };
  uint32_t scenario;
  uint32_t observed_restarts = 0U;
  uint32_t observed_deferrals = 0U;
  uint32_t observed_matching_pongs = 0U;
  uint32_t observed_unmatched_pongs = 0U;
  uint32_t observed_confirmation_expiries = 0U;

  for (scenario = 0U;
       scenario < SCENARIO_COUNT;
       ++scenario) {
    struct fixture fixture;
    uint32_t choice =
        0x6d2b79f5U ^ (scenario * 0x9e3779b9U);
    uint32_t generation = 1U;
    uint32_t step;
    uint64_t now_ms = 0U;
    uint64_t last_capture_ms = 0U;
    fixture_init(&fixture);
    fixture.conductor.maximum_work_steps = 3U;
    begin_generation(&fixture, generation);

    /*
     * Seed every scenario with the liveness boundary before sampling broader
     * events. The barrier is queued on an otherwise healthy link, then its
     * write behavior varies by scenario. This guarantees the model actually
     * visits the stale-proof state instead of relying on a random walk that
     * may reconnect or receive a PONG first.
     */
    submit_frame(&fixture, 0x10U, 0U);
    submit_frame(&fixture, 0x11U, 20U);
    CHECK(iterate_kit_pcm_uplink_conductor_poll(
              &fixture.conductor, 20U) ==
        ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
    CHECK(fixture.tx.control_pending);
    switch (scenario % 4U) {
      case 0U:
        fixture.raw.writes_to_defer = UINT32_MAX;
        break;
      case 1U:
        fixture.raw.maximum_write = 1U;
        break;
      case 2U:
        fixture.raw.maximum_write = 7U;
        break;
      default:
        fixture.raw.writes_to_disconnect = 1U;
        break;
    }
    fixture.conductor.maximum_work_steps =
        1U + (scenario % 4U);
    CHECK(iterate_kit_pcm_uplink_conductor_poll(
              &fixture.conductor, 101U) ==
        ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
    ++observed_confirmation_expiries;
    ++observed_restarts;
    now_ms = 101U;
    last_capture_ms = 20U;

    for (step = 0U;
         step < STEPS_PER_SCENARIO;
         ++step) {
      enum iterate_kit_pcm_uplink_conductor_poll_result
          result;
      const uint32_t event = next_fault_choice(&choice);
      bool confirmation_expired = false;

      if (!fixture.conductor.generation_active) {
        ++generation;
        fixture.raw.byte_count = 0U;
        fixture.raw.writes_to_defer = 0U;
        fixture.raw.writes_to_disconnect = 0U;
        fixture.raw.maximum_write = SIZE_MAX;
        begin_generation(&fixture, generation);
      }

      /*
       * The capture array below is only a fake peer transcript. Forgetting
       * already-observed bytes cannot affect transmitter state, and prevents
       * this long host-only model from needing an irrelevant megabyte buffer.
       */
      fixture.raw.byte_count = 0U;
      fixture.raw.writes_to_defer = 0U;
      fixture.raw.writes_to_disconnect = 0U;
      fixture.raw.maximum_write = SIZE_MAX;
      now_ms += (event >> 4U) % 6U;

      if ((event & 0x03U) != 0U) {
        enum iterate_kit_status submit_status;
        uint64_t capture_ms =
            now_ms + ((event >> 8U) & 0x01U);
        if (capture_ms < last_capture_ms) {
          capture_ms = last_capture_ms;
        }
        last_capture_ms = capture_ms;
        submit_status = try_submit_frame(
            &fixture, (uint8_t)event, capture_ms);
        CHECK(
            submit_status == ITERATE_KIT_OK ||
            submit_status == ITERATE_KIT_BACKPRESSURE);
      }

      /*
       * A matching PONG is legal only after its PING has completely left our
       * transmitter. Arbitrary payloads remain legal peer noise at any time.
       * Avoiding an impossible early matching reply keeps a FAILED verdict
       * attributable to firmware composition rather than a dishonest model.
       */
      if ((event & 0x18U) == 0x18U &&
          fixture.conductor.peer_delivery
              .barrier_outstanding &&
          !fixture.tx.control_pending &&
          fixture.tx.active_kind ==
              ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE) {
        uint8_t pong[
            ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES];
        memcpy(
            pong,
            fixture.conductor.peer_delivery.expected_pong,
            sizeof(pong));
        if ((event & 0x20U) == 0U) {
          CHECK(iterate_kit_pcm_uplink_conductor_receive_pong(
                    &fixture.conductor,
                    pong,
                    sizeof(pong),
                    now_ms) == ITERATE_KIT_OK);
          ++observed_matching_pongs;
        } else {
          pong[0] ^= 0xffU;
          CHECK(iterate_kit_pcm_uplink_conductor_receive_pong(
                    &fixture.conductor,
                    pong,
                    sizeof(pong),
                    now_ms) == ITERATE_KIT_UNAVAILABLE);
          ++observed_unmatched_pongs;
        }
      } else if ((event & 0x3fU) == 0U) {
        const uint8_t unsolicited[] = {0xdeU, 0xadU};
        CHECK(iterate_kit_pcm_uplink_conductor_receive_pong(
                  &fixture.conductor,
                  unsolicited,
                  sizeof(unsolicited),
                  now_ms) == ITERATE_KIT_UNAVAILABLE);
        ++observed_unmatched_pongs;
      }

      switch ((event >> 12U) & 0x07U) {
        case 0U:
          fixture.raw.writes_to_defer = 1U;
          break;
        case 1U:
          fixture.raw.maximum_write = 1U;
          break;
        case 2U:
          fixture.raw.maximum_write = 17U;
          break;
        case 3U:
          fixture.raw.writes_to_disconnect = 1U;
          break;
        default:
          break;
      }

      if (fixture.conductor.peer_delivery
              .unconfirmed_frames > 0U) {
        const uint64_t policy_now_ms =
            now_ms >
                fixture.conductor.policy_time_floor_ms
            ? now_ms
            : fixture.conductor.policy_time_floor_ms;
        const uint64_t oldest_ms =
            fixture.conductor.peer_delivery
                .oldest_unconfirmed_capture_ms;
        confirmation_expired =
            policy_now_ms >= oldest_ms &&
            policy_now_ms - oldest_ms >=
                fixture.conductor.peer_delivery.options
                    .maximum_confirmation_age_ms;
      }
      result = iterate_kit_pcm_uplink_conductor_poll(
          &fixture.conductor, now_ms);
      if (result ==
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED) {
        fprintf(
            stderr,
            "legal fault model failed at scenario %u step %u"
            " generation %u now_ms %llu\n",
            (unsigned)scenario,
            (unsigned)step,
            (unsigned)generation,
            (unsigned long long)now_ms);
        abort();
      }
      if (confirmation_expired) {
        /*
         * This is the global liveness half of the model: irrespective of which
         * control/data write outcome was selected, one pass after the peer
         * proof becomes stale must close the generation. It generalises the
         * two byte-exact blocked/trickling barrier incidents above.
         */
        CHECK(
            result ==
            ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
        ++observed_confirmation_expiries;
      }
      if (result ==
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART) {
        ++observed_restarts;
        CHECK(!fixture.conductor.generation_active);
      } else if (result ==
                 ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED) {
        ++observed_deferrals;
      }
    }
  }

  /*
   * These are coverage obligations, not product thresholds. If a future edit
   * accidentally makes the deterministic sampler avoid one fault class, a
   * green "property" result would be meaningless and must fail visibly.
   */
  CHECK(observed_restarts > 0U);
  CHECK(observed_deferrals > 0U);
  CHECK(observed_matching_pongs > 0U);
  CHECK(observed_unmatched_pongs > 0U);
  CHECK(observed_confirmation_expiries > 0U);
}

int main(void) {
  newer_capture_timestamp_does_not_poison_guard();
  true_owner_clock_regression_is_not_normalized();
  confirmation_timeout_purges_old_epoch_and_recovers();
  old_generation_pong_cannot_confirm_new_audio();
  blocked_barrier_cannot_suspend_audio_freshness_deadline();
  trickling_barrier_cannot_suspend_audio_freshness_deadline();
  invalid_raw_writer_result_is_failed_not_restart();
  disconnect_purges_the_whole_microphone_epoch();
  partial_pcm_finishes_before_its_barrier_and_later_audio();
  control_collision_defers_without_deadlock_or_reordering();
  generation_change_destroys_a_partial_old_frame();
  producer_epoch_reset_mid_partial_frame_replaces_socket();
  idle_half_open_generation_restarts_without_audio();
  legal_fault_interleavings_never_latch_local_failure();
  return 0;
}
