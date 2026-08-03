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
 * Decode the bytes seen by the fake server rather than peeking into the
 * transmitter. Tests therefore prove what a tunnel-shaped RFC 6455 peer sees
 * after client masking, extended-length framing, and partial raw writes.
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

/*
 * A tunnel or reverse proxy is allowed to forward binary PCM forever without
 * ever originating a PONG for the device. RFC 6455 PONG is a reply to a PING,
 * not application delivery credit, and even an echoed client PING would prove
 * only that this WebSocket hop parsed an earlier byte prefix. Treating its
 * absence as admission backpressure stopped a healthy long push-to-talk after
 * a handful of frames.
 *
 * Model a continuously writable tunnel for longer than the removed
 * confirmation deadline, submit each freshly captured 20 ms frame only when
 * it exists, and deliberately inject no peer control traffic. Every current
 * frame must leave promptly and the device must not emit its own PING.
 */
static void continuous_fresh_audio_needs_no_peer_pong(void) {
  enum { FRAME_COUNT = 16 };
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  uint32_t parsed_frames = 0U;
  uint32_t frame_index;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);

  for (frame_index = 0U;
       frame_index < FRAME_COUNT;
       ++frame_index) {
    const uint64_t capture_ms =
        (uint64_t)frame_index * 20U;
    submit_frame(
        &fixture,
        (uint8_t)(0x20U + frame_index),
        capture_ms);
    CHECK(iterate_kit_pcm_uplink_conductor_poll(
              &fixture.conductor, capture_ms) ==
        ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  }
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 320U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);

  while (parse_frame(&fixture.raw, &offset, &frame)) {
    CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
    CHECK(frame.payload_size == ITERATE_KIT_PCM_V1_FRAME_BYTES);
    CHECK(frame.payload[0] ==
        (uint8_t)(0x20U + parsed_frames));
    ++parsed_frames;
  }
  CHECK(parsed_frames == FRAME_COUNT);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.frames_sent == FRAME_COUNT);
  CHECK(metrics.sender.restart_incidents == 0U);
  CHECK(metrics.sender.frames_discarded == 0U);
}

/*
 * Button release travels over Cap'n Web while microphone bytes travel over a
 * separate WebSocket. Network scheduling may deliver that control event first,
 * so the PCM socket needs its own ordered turn fence. The fence is an empty
 * binary message queued behind the final capture frame—not a PING/PONG and not
 * an out-of-band flag which could overtake audio. Decode the actual masked wire
 * bytes to prove the exact frame-then-marker contract used by userspace.
 */
static void end_of_turn_marker_follows_final_pcm_on_the_wire(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x2aU, 100U);
  CHECK(iterate_kit_pcm_lane_submit_uplink_end_marker_at(
            &fixture.lane, 120U) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 120U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 120U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);

  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload_size == ITERATE_KIT_PCM_V1_FRAME_BYTES);
  CHECK(frame.payload[0] == 0x2aU);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload_size == 0U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));

  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.frames_sent == 1U);
  CHECK(metrics.sender.end_markers_sent == 1U);
  CHECK(metrics.sender.frames_discarded == 0U);
  CHECK(metrics.sender.end_markers_discarded == 0U);
}

/*
 * Workerd cannot tell the proxy how many server-side WebSocket bytes remain
 * below send(). The connection owner therefore acknowledges complete device
 * downlink items on this same ordered socket. The receipt is audio flow
 * control, so one tiny coalesced write must precede acquiring a new microphone
 * slot; otherwise a permanently busy PTT stream could starve receipts and let
 * the server rebuild the exact opaque backlog this protocol removes.
 */
static void downlink_receipt_preempts_a_new_microphone_frame(void) {
  struct fixture fixture;
  struct parsed_frame frame;
  size_t offset = 0U;
  uint32_t accepted_items = 0U;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  CHECK(iterate_kit_pcm_uplink_conductor_note_downlink_item(
            &fixture.conductor) == ITERATE_KIT_OK);
  submit_frame(&fixture, 0x4cU, 20U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload_size ==
      ITERATE_KIT_PCM_V1_DOWNLINK_RECEIPT_BYTES);
  CHECK(iterate_kit_pcm_websocket_decode_downlink_receipt(
            frame.payload,
            frame.payload_size,
            &accepted_items) == ITERATE_KIT_OK);
  CHECK(accepted_items == 1U);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.payload_size == ITERATE_KIT_PCM_V1_FRAME_BYTES);
  CHECK(frame.payload[0] == 0x4cU);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
}

/*
 * A short socket write owns its masked WebSocket frame until completion. If
 * more speaker frames arrive meanwhile, rewriting the cumulative value would
 * corrupt the frame already partly accepted by TLS; abandoning it would break
 * RFC framing. Preserve that immutable receipt, then emit one coalesced latest
 * receipt before microphone PCM. This is the awkward network condition the
 * production device must handle, not merely a happy-path encoding check.
 */
static void partial_receipt_is_immutable_and_later_progress_coalesces(void) {
  struct fixture fixture;
  struct parsed_frame frame;
  size_t offset = 0U;
  uint32_t accepted_items = 0U;
  uint32_t polls;
  fixture_init(&fixture);
  fixture.raw.maximum_write = 3U;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  CHECK(iterate_kit_pcm_uplink_conductor_note_downlink_item(
            &fixture.conductor) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 0U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_note_downlink_item(
            &fixture.conductor) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_uplink_conductor_note_downlink_item(
            &fixture.conductor) == ITERATE_KIT_OK);
  submit_frame(&fixture, 0x5cU, 20U);

  for (polls = 0U; polls < 256U; ++polls) {
    const enum iterate_kit_pcm_uplink_conductor_poll_result result =
        iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U);
    CHECK(
        result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS ||
        result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);
    if (result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE) break;
  }
  CHECK(polls < 256U);

  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(iterate_kit_pcm_websocket_decode_downlink_receipt(
            frame.payload,
            frame.payload_size,
            &accepted_items) == ITERATE_KIT_OK);
  CHECK(accepted_items == 1U);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(iterate_kit_pcm_websocket_decode_downlink_receipt(
            frame.payload,
            frame.payload_size,
            &accepted_items) == ITERATE_KIT_OK);
  CHECK(accepted_items == 3U);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.payload_size == ITERATE_KIT_PCM_V1_FRAME_BYTES);
  CHECK(frame.payload[0] == 0x5cU);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
}

/*
 * The microphone and network tasks run on different cores. The network task
 * can sample 100 ms and then acquire a frame the producer completed at 101 ms.
 * That ordinary scheduling race is zero known age, not a broken clock. The
 * conductor advances its policy floor and remains usable on the same sample.
 */
static void newer_capture_timestamp_does_not_poison_conductor(void) {
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
  CHECK(metrics.policy_time_normalizations == 1U);
  CHECK(metrics.maximum_policy_time_adjustment_ms == 1U);
  CHECK(metrics.owner_clock_regressions == 0U);
}

/*
 * Producer skew may move the policy floor ahead, but the connection owner's
 * samples themselves must remain monotonic. Clamping a truly older owner
 * sample would silently disable every elapsed-time freshness deadline.
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
 * A server PING can arrive while a PCM frame is partly written. RFC 6455
 * forbids interleaving its PONG into that frame, but delaying the mandatory
 * reply behind later microphone frames can fail the server's hop-level
 * timeout. Queue the PONG exactly as the production receive path does and
 * prove the only legal wire order: finish current PCM, reply PONG, then send
 * later PCM. Nothing about this PONG grants audio-delivery credit.
 */
static void mandatory_pong_waits_for_partial_pcm_then_preempts_later_audio(
    void) {
  static const uint8_t ping_payload[] = {0xa5U, 0x5aU};
  struct fixture fixture;
  struct parsed_frame frame;
  size_t offset = 0U;
  uint32_t polls;
  fixture_init(&fixture);
  fixture.raw.maximum_write = 97U;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x41U, 0U);
  submit_frame(&fixture, 0x42U, 20U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 0U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA);
  CHECK(iterate_kit_websocket_tx_queue_control(
            &fixture.tx,
            ITERATE_KIT_WEBSOCKET_PONG,
            ping_payload,
            sizeof(ping_payload)) == ITERATE_KIT_OK);

  for (polls = 0U; polls < 64U; ++polls) {
    const enum iterate_kit_pcm_uplink_conductor_poll_result
        result = iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U);
    CHECK(
        result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS ||
        result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE);
    if (result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE) {
      break;
    }
  }
  CHECK(polls < 64U);

  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0x41U);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_PONG);
  CHECK(frame.payload_size == sizeof(ping_payload));
  CHECK(memcmp(
      frame.payload,
      ping_payload,
      sizeof(ping_payload)) == 0);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0x42U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
}

/*
 * A connected TCP/TLS handle may remain permanently unwritable. Retaining the
 * oldest speech until the platform's multi-minute TCP timeout would create a
 * stale burst after recovery. The sender's elapsed no-byte-progress deadline,
 * not PONG, must purge the entire application epoch. Because the raw writer
 * accepted no byte, the same connection remains structurally valid and avoids
 * paying a new DNS/TCP/TLS handshake for an application-freshness decision.
 */
static void no_send_progress_purges_the_whole_microphone_epoch(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  fixture.raw.writes_to_defer = UINT32_MAX;
  submit_frame(&fixture, 0x51U, 0U);
  submit_frame(&fixture, 0x52U, 20U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 60U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.conductor.generation_active);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.no_progress_timeout_restarts == 1U);
  CHECK(metrics.sender.frames_discarded == 2U);
  CHECK(metrics.sender.last_restart_frames_discarded == 2U);
  CHECK(metrics.sender.last_restart_reason ==
      ITERATE_KIT_PCM_UPLINK_RESTART_NO_PROGRESS_TIMEOUT);
  CHECK(metrics.in_place_freshness_recoveries == 1U);
  CHECK(metrics.socket_restarts == 0U);
}

/*
 * Cancelling one wholly-unwritten frame is a useful cheap recovery: the peer's
 * WebSocket parser is unchanged, so paying DNS/TCP/TLS immediately only makes
 * a brief radio stall longer. It must not, however, reset the liveness clock
 * forever. A socket which accepts no complete PCM frame can otherwise cycle
 * through purge -> fresh frame -> purge indefinitely while looking connected,
 * exactly the accumulating-loss pattern observed on the physical StackChan.
 *
 * The per-frame total-send limit is also the outer bound for this continuous
 * no-completion epoch. The no-progress deadline still performs the first cheap
 * purge; once repeated cheap recoveries consume the outer elapsed-time budget,
 * the generation is replaced. This assertion is intentionally about elapsed
 * time, not poll/retry count, so task frequency cannot change the verdict.
 */
static void repeated_in_place_recovery_eventually_replaces_socket(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  fixture.raw.writes_to_defer = UINT32_MAX;

  submit_frame(&fixture, 0xa1U, 20U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 60U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);

  submit_frame(&fixture, 0xa2U, 60U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 60U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 100U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);

  submit_frame(&fixture, 0xa3U, 100U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 100U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 140U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
  CHECK(!fixture.conductor.generation_active);

  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.no_progress_timeout_restarts == 3U);
  CHECK(metrics.in_place_freshness_recoveries == 2U);
  CHECK(metrics.socket_restarts == 1U);
}

/*
 * A complete non-empty PCM frame is direct evidence that the current socket
 * recovered. Without this reset, two unrelated short Wi-Fi stalls separated
 * by healthy audio could inherit one degradation epoch and cause a needless
 * reconnect. An empty end marker is deliberately insufficient evidence: its
 * tiny header can pass while a normal 640-byte audio frame remains blocked.
 */
static void completed_pcm_resets_repeated_recovery_deadline(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  fixture.raw.writes_to_defer = UINT32_MAX;

  submit_frame(&fixture, 0xb1U, 20U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 60U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);

  fixture.raw.writes_to_defer = 0U;
  submit_frame(&fixture, 0xb2U, 61U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 61U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);

  fixture.raw.writes_to_defer = UINT32_MAX;
  submit_frame(&fixture, 0xb3U, 100U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 100U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 140U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.conductor.generation_active);

  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.in_place_freshness_recoveries == 2U);
  CHECK(metrics.socket_restarts == 0U);
}

/*
 * A release marker may already be queued when a long WAN stall expires the
 * oldest audio frame. Purging that marker together with stale PCM leaves the
 * still-connected userspace session waiting for a boundary which can never
 * arrive; production correctly closes it after its bounded timeout. The clean
 * zero-byte WebSocket recovery must therefore drop audio only up to the marker
 * and send that marker next. This does not claim the discarded audio reached
 * Grok—it merely terminates the incomplete turn explicitly so the same call
 * remains usable instead of paying a reconnect or wedging indefinitely.
 */
static void in_place_freshness_purge_preserves_end_marker(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  fixture_init(&fixture);
  fixture.conductor.maximum_work_steps = 1U;
  fixture.raw.writes_to_defer = UINT32_MAX;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x59U, 0U);
  submit_frame(&fixture, 0x5aU, 20U);
  CHECK(iterate_kit_pcm_lane_submit_uplink_end_marker_at(
            &fixture.lane, 21U) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 60U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.conductor.generation_active);
  CHECK(fixture.raw.byte_count == 0U);

  fixture.raw.writes_to_defer = 0U;
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 60U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload_size == 0U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));

  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.frames_discarded == 2U);
  CHECK(metrics.sender.end_markers_discarded == 0U);
  CHECK(metrics.sender.end_markers_sent == 1U);
  CHECK(metrics.in_place_freshness_recoveries == 1U);
  CHECK(metrics.socket_restarts == 0U);
}

/*
 * Continuous one-byte progress avoids the no-progress deadline but still
 * cannot keep one captured frame alive indefinitely. The total send-duration
 * cap is a separate protection against a trickling socket that would otherwise
 * turn old speech into a very slow, still-growing transport backlog.
 */
static void trickling_socket_cannot_hold_one_frame_forever(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  fixture.raw.maximum_write = 1U;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x61U, 0U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 0U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 39U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 79U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 80U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.frame_send_timeout_restarts == 1U);
  CHECK(metrics.sender.frames_discarded == 1U);
  CHECK(metrics.sender.last_restart_reason ==
      ITERATE_KIT_PCM_UPLINK_RESTART_FRAME_SEND_TIMEOUT);
  CHECK(metrics.in_place_freshness_recoveries == 0U);
  CHECK(metrics.socket_restarts == 1U);
}

/*
 * A current socket must not transmit a frame which already spent its complete
 * freshness budget in the application ring. Age is checked before the first
 * raw write and expiration purges every queued frame, so recovery begins with
 * live speech rather than catching up on history. No wire state exists in
 * this case, therefore reconnecting would add latency without buying safety.
 */
static void capture_age_expiry_purges_queued_history_before_send(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0x71U, 0U);
  submit_frame(&fixture, 0x72U, 20U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 200U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.conductor.generation_active);
  CHECK(fixture.raw.byte_count == 0U);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.capture_stale_restarts == 1U);
  CHECK(metrics.sender.frames_discarded == 2U);
  CHECK(metrics.sender.last_restart_reason ==
      ITERATE_KIT_PCM_UPLINK_RESTART_CAPTURE_STALE);
  CHECK(metrics.in_place_freshness_recoveries == 1U);
  CHECK(metrics.socket_restarts == 0U);
}

/*
 * A raw writer claiming success without accepting bytes violates the local
 * callback contract. Reconnecting would launder a deterministic firmware
 * defect into ordinary radio telemetry, so the conductor fails and still
 * purges the retained microphone epoch.
 */
static void invalid_raw_writer_result_is_failed_not_restart(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  fixture.raw.invalid_zero_writes = 1U;
  submit_frame(&fixture, 0x81U, 10U);

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
 * A disconnected byte stream makes delivery uncertain immediately. Keeping
 * later ring entries would make stale speech the first data on the replacement
 * connection, so the conductor abandons the whole epoch and records a
 * transport-specific recoverable restart.
 */
static void disconnect_purges_the_whole_microphone_epoch(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  fixture_init(&fixture);
  begin_generation(&fixture, 1U);
  fixture.raw.writes_to_disconnect = 1U;
  submit_frame(&fixture, 0x91U, 10U);
  submit_frame(&fixture, 0x92U, 20U);

  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.transport_disconnect_restarts == 1U);
  CHECK(metrics.sender.frames_discarded == 2U);
  CHECK(metrics.sender.last_restart_frames_discarded == 2U);
}

/*
 * Reconnect can happen after some masked PCM bytes entered the old TLS stream.
 * Those bytes cannot be resumed on another socket, and replaying from byte zero
 * would duplicate speech. Abandonment releases the retained ring slot and
 * transmitter; the next generation can contain only newly captured audio.
 */
static void generation_change_destroys_a_partial_old_frame(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  uint32_t discarded = UINT32_MAX;
  fixture_init(&fixture);
  fixture.raw.maximum_write = 37U;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0xa1U, 0U);
  submit_frame(&fixture, 0xa2U, 20U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 20U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.raw.byte_count == 37U);

  CHECK(iterate_kit_pcm_uplink_conductor_abandon_generation(
            &fixture.conductor,
            &discarded) == ITERATE_KIT_OK);
  CHECK(discarded == 2U);
  CHECK(fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE);

  fixture.raw.byte_count = 0U;
  fixture.raw.maximum_write = SIZE_MAX;
  begin_generation(&fixture, 2U);
  submit_frame(&fixture, 0xb1U, 30U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 30U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0xb1U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.frames_discarded == 2U);
  CHECK(metrics.sender.frames_sent == 1U);
}

/*
 * During a long PTT, producer overflow is an explicit epoch-reset request: the
 * SPSC producer cannot mutate the consumer's retained partial frame. The
 * conductor must replace the socket and purge all seven accepted older audio
 * frames, not keep a catch-up FIFO whose contents become audible after network
 * recovery. The eighth physical slot is reserved for the ordered PTT end
 * marker and therefore cannot disguise audio saturation.
 */
static void producer_epoch_reset_mid_partial_frame_replaces_socket(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  uint32_t frame_index;
  fixture_init(&fixture);
  fixture.raw.maximum_write = 37U;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0xc0U, 0U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 0U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);

  for (frame_index = 1U;
       frame_index < SLOT_COUNT - 1U;
       ++frame_index) {
    submit_frame(
        &fixture,
        (uint8_t)(0xc0U + frame_index),
        (uint64_t)frame_index * 20U);
  }
  CHECK(try_submit_frame(&fixture, 0xdfU, 160U) ==
      ITERATE_KIT_BACKPRESSURE);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 160U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
  CHECK(fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE);
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.producer_backpressure_restarts == 1U);
  CHECK(metrics.sender.frames_discarded == SLOT_COUNT - 1U);
  CHECK(metrics.sender.last_restart_frames_discarded ==
      SLOT_COUNT - 1U);
}

/*
 * A full microphone ring means the oldest captured speech is no longer a
 * realtime utterance, but it does not by itself mean the WebSocket is broken.
 * In the production failure that motivated this regression, the next masked
 * frame had been materialised locally while the nonblocking TLS writer had
 * accepted zero bytes. Reconnecting DNS/TCP/TLS at that clean RFC 6455 frame
 * boundary turned a bounded 640 ms radio stall into several seconds of dead
 * conversation.
 *
 * The safe alternative is deliberately narrow: cancel the entirely local
 * frame, purge the stale microphone epoch, and retain the socket. The sibling
 * partial-frame test above remains mandatory because even one accepted header
 * byte makes cancellation corrupt the WebSocket stream. Once capacity
 * returns, only newly captured audio may cross the same generation.
 */
static void producer_epoch_reset_before_first_wire_byte_keeps_socket(
    void) {
  struct fixture fixture;
  struct iterate_kit_pcm_uplink_conductor_metrics metrics;
  struct parsed_frame frame;
  size_t offset = 0U;
  uint32_t frame_index;
  fixture_init(&fixture);
  fixture.raw.writes_to_defer = UINT32_MAX;
  fixture.conductor.maximum_work_steps = 1U;
  begin_generation(&fixture, 1U);
  submit_frame(&fixture, 0xd0U, 0U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 0U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED);
  CHECK(fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA);
  CHECK(fixture.tx.frame.frame_offset == 0U);

  for (frame_index = 1U;
       frame_index < SLOT_COUNT - 1U;
       ++frame_index) {
    submit_frame(
        &fixture,
        (uint8_t)(0xd0U + frame_index),
        (uint64_t)frame_index * 20U);
  }
  CHECK(try_submit_frame(&fixture, 0xefU, 160U) ==
      ITERATE_KIT_BACKPRESSURE);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 160U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(fixture.conductor.generation_active);
  CHECK(fixture.tx.active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE);
  CHECK(fixture.raw.byte_count == 0U);

  fixture.raw.writes_to_defer = 0U;
  submit_frame(&fixture, 0xf1U, 180U);
  CHECK(iterate_kit_pcm_uplink_conductor_poll(
            &fixture.conductor, 180U) ==
      ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS);
  CHECK(parse_frame(&fixture.raw, &offset, &frame));
  CHECK(frame.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(frame.payload[0] == 0xf1U);
  CHECK(!parse_frame(&fixture.raw, &offset, &frame));
  iterate_kit_pcm_uplink_conductor_metrics(
      &fixture.conductor, &metrics);
  CHECK(metrics.sender.producer_backpressure_restarts == 1U);
  CHECK(metrics.sender.frames_discarded == SLOT_COUNT - 1U);
  CHECK(metrics.sender.frames_sent == 1U);
}

static uint32_t next_fault_choice(uint32_t *state) {
  /*
   * Fixed pseudo-randomness makes a failed interleaving replayable while still
   * mixing producer, raw-writer, and time choices more densely than a list of
   * hand-authored examples. Unsigned overflow is the specified LCG modulus.
   */
  *state = (*state * 1664525U) + 1013904223U;
  return *state;
}

/*
 * Removing PONG admission must not weaken the actual bounded-backlog contract.
 * Exercise thousands of legal tunnel schedules containing current capture,
 * ring overflow, EAGAIN, one-byte progress, disconnect, stale frames, and
 * generation replacement. Expected network pressure may defer or restart but
 * must never become a local FAILED verdict or leave a restarted generation
 * active. This is a deterministic bounded model, not proof of arbitrary C
 * execution; the byte-exact scenarios above remain the explanatory regressions.
 */
static void legal_tunnel_faults_never_latch_local_failure(void) {
  enum {
    SCENARIO_COUNT = 8,
    STEPS_PER_SCENARIO = 1024,
  };
  uint32_t scenario;
  uint32_t observed_deferrals = 0U;
  uint32_t observed_restarts = 0U;
  uint32_t observed_sends = 0U;

  for (scenario = 0U;
       scenario < SCENARIO_COUNT;
       ++scenario) {
    struct fixture fixture;
    uint32_t choice =
        0x6d2b79f5U ^ (scenario * 0x9e3779b9U);
    uint32_t generation = 1U;
    uint32_t step;
    uint64_t now_ms = 0U;
    fixture_init(&fixture);
    fixture.conductor.maximum_work_steps =
        1U + (scenario % 4U);
    begin_generation(&fixture, generation);

    for (step = 0U;
         step < STEPS_PER_SCENARIO;
         ++step) {
      enum iterate_kit_pcm_uplink_conductor_poll_result result;
      struct iterate_kit_pcm_uplink_conductor_metrics before;
      struct iterate_kit_pcm_uplink_conductor_metrics after;
      const uint32_t event = next_fault_choice(&choice);
      if (!fixture.conductor.generation_active) {
        ++generation;
        fixture.raw.byte_count = 0U;
        fixture.raw.writes_to_defer = 0U;
        fixture.raw.writes_to_disconnect = 0U;
        fixture.raw.maximum_write = SIZE_MAX;
        begin_generation(&fixture, generation);
      }

      /*
       * The capture is only a fake peer transcript. Forgetting prior complete
       * bytes cannot alter transmitter ownership and avoids allocating an
       * irrelevant multi-megabyte log for this long host-only model.
       */
      fixture.raw.byte_count = 0U;
      fixture.raw.writes_to_defer = 0U;
      fixture.raw.writes_to_disconnect = 0U;
      fixture.raw.maximum_write = SIZE_MAX;
      now_ms += (event >> 4U) % 7U;

      if ((event & 0x03U) != 0U) {
        const enum iterate_kit_status status =
            try_submit_frame(
                &fixture,
                (uint8_t)event,
                now_ms + ((event >> 8U) & 0x01U));
        CHECK(
            status == ITERATE_KIT_OK ||
            status == ITERATE_KIT_BACKPRESSURE);
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

      iterate_kit_pcm_uplink_conductor_metrics(
          &fixture.conductor, &before);
      result = iterate_kit_pcm_uplink_conductor_poll(
          &fixture.conductor, now_ms);
      CHECK(result != ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
      iterate_kit_pcm_uplink_conductor_metrics(
          &fixture.conductor, &after);
      observed_sends +=
          after.sender.frames_sent - before.sender.frames_sent;
      if (result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART) {
        ++observed_restarts;
        CHECK(!fixture.conductor.generation_active);
      } else if (result ==
                 ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED) {
        ++observed_deferrals;
      }
    }
  }
  CHECK(observed_sends > 0U);
  CHECK(observed_deferrals > 0U);
  CHECK(observed_restarts > 0U);
}

int main(void) {
  continuous_fresh_audio_needs_no_peer_pong();
  end_of_turn_marker_follows_final_pcm_on_the_wire();
  downlink_receipt_preempts_a_new_microphone_frame();
  partial_receipt_is_immutable_and_later_progress_coalesces();
  newer_capture_timestamp_does_not_poison_conductor();
  true_owner_clock_regression_is_not_normalized();
  mandatory_pong_waits_for_partial_pcm_then_preempts_later_audio();
  no_send_progress_purges_the_whole_microphone_epoch();
  repeated_in_place_recovery_eventually_replaces_socket();
  completed_pcm_resets_repeated_recovery_deadline();
  in_place_freshness_purge_preserves_end_marker();
  trickling_socket_cannot_hold_one_frame_forever();
  capture_age_expiry_purges_queued_history_before_send();
  invalid_raw_writer_result_is_failed_not_restart();
  disconnect_purges_the_whole_microphone_epoch();
  generation_change_destroys_a_partial_old_frame();
  producer_epoch_reset_mid_partial_frame_replaces_socket();
  producer_epoch_reset_before_first_wire_byte_keeps_socket();
  legal_tunnel_faults_never_latch_local_failure();
  return 0;
}
