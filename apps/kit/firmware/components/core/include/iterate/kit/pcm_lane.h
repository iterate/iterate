#ifndef ITERATE_KIT_PCM_LANE_H
#define ITERATE_KIT_PCM_LANE_H

#include "iterate/kit/pcm_websocket.h"
#include "iterate/kit/spsc_ring.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_pcm_message_type {
  ITERATE_KIT_PCM_MESSAGE_BINARY = 0,
  ITERATE_KIT_PCM_MESSAGE_TEXT,
  ITERATE_KIT_PCM_MESSAGE_OTHER,
};

struct iterate_kit_pcm_lane_metrics {
  struct iterate_kit_spsc_ring_metrics uplink;
  struct iterate_kit_spsc_ring_metrics downlink;
  uint32_t uplink_frames_accepted;
  uint32_t uplink_invalid_frames;
  uint32_t uplink_epoch_reset_requests;
  uint32_t downlink_frames_accepted;
  uint32_t downlink_end_markers_accepted;
  uint32_t downlink_end_markers_discarded;
  uint32_t downlink_nonbinary_messages;
  uint32_t downlink_fragmented_messages;
  uint32_t downlink_malformed_frames;
  uint32_t downlink_frames_discarded;
  uint32_t downlink_generation_fragment_resets;
};

/**
 * Caller-owned storage envelope for one microphone frame. The capture
 * timestamp is local metadata and is never written to the PCM WebSocket.
 */
struct iterate_kit_pcm_uplink_slot {
  uint64_t capture_completed_at_ms;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
};

enum iterate_kit_pcm_downlink_slot_kind {
  ITERATE_KIT_PCM_DOWNLINK_FRAME = 0,
  ITERATE_KIT_PCM_DOWNLINK_END_OF_STREAM,
};

/**
 * Caller-owned storage envelope for one ordered speaker-lane item.
 *
 * received_at_ms is the local monotonic time at which the first byte of the
 * complete WebSocket message reached the device. It is not a server timestamp
 * and therefore proves receive-to-playback age only. Keeping the timestamp
 * beside the fixed frame lets freshness policy reject old FIFO history without
 * allocating a second metadata queue whose indices could drift from PCM.
 *
 * END_OF_STREAM reserves no second queue: its frame bytes are ignored and the
 * acquire API exposes it as frame=NULL, frame_bytes=0. Spending one fixed ring
 * slot on the rare marker is preferable to an atomic side flag, which could
 * overtake queued PCM and truncate a response.
 */
struct iterate_kit_pcm_downlink_slot {
  enum iterate_kit_pcm_downlink_slot_kind kind;
  uint64_t received_at_ms;
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
};

/**
 * Allocation-free protocol lane joining an audio producer to a network
 * consumer and a network producer to a playback consumer. Each uplink ring
 * slot must be one iterate_kit_pcm_uplink_slot; each downlink slot must be one
 * iterate_kit_pcm_downlink_slot. Queue ownership and storage stay with the
 * caller.
 */
struct iterate_kit_pcm_lane {
  struct iterate_kit_spsc_ring *uplink;
  struct iterate_kit_spsc_ring *downlink;
  uint32_t uplink_frames_accepted;
  uint32_t uplink_invalid_frames;
  uint32_t uplink_epoch_reset_requests;
  uint32_t uplink_epoch_reset_requested;
  uint32_t downlink_frames_accepted;
  uint32_t downlink_end_markers_accepted;
  uint32_t downlink_end_markers_discarded;
  uint32_t downlink_nonbinary_messages;
  uint32_t downlink_fragmented_messages;
  uint32_t downlink_malformed_frames;
  uint32_t downlink_frames_discarded;
  uint32_t downlink_generation_fragment_resets;
  uint8_t *downlink_fragment_destination;
  size_t downlink_fragment_received;
  bool downlink_fragment_active;
  bool initialized;
};

enum iterate_kit_status iterate_kit_pcm_lane_init(
    struct iterate_kit_pcm_lane *lane,
    struct iterate_kit_spsc_ring *uplink,
    struct iterate_kit_spsc_ring *downlink);

/**
 * Copies one exact v1 frame and its capture-completion timestamp into the
 * bounded uplink queue. A full queue drops the new frame with BACKPRESSURE;
 * it never evicts an older frame silently.
 */
enum iterate_kit_status iterate_kit_pcm_lane_submit_uplink_at(
    struct iterate_kit_pcm_lane *lane,
    const void *frame,
    size_t frame_bytes,
    uint64_t capture_completed_at_ms);

enum iterate_kit_status iterate_kit_pcm_lane_uplink_acquire(
    struct iterate_kit_pcm_lane *lane,
    const void **frame,
    size_t *frame_bytes,
    uint64_t *capture_completed_at_ms);

enum iterate_kit_status iterate_kit_pcm_lane_uplink_release(
    struct iterate_kit_pcm_lane *lane);

/**
 * Atomically consumes the producer's request to abandon the current
 * microphone epoch. A full realtime uplink requests a reset instead of
 * allowing the oldest queued audio to become delayed conversation.
 *
 * This is a single-consumer operation. The producer never mutates consumer
 * state and may continue capturing while the consumer performs the purge.
 */
enum iterate_kit_status
iterate_kit_pcm_lane_take_uplink_epoch_reset_request(
    struct iterate_kit_pcm_lane *lane,
    bool *requested);

/**
 * Reassembles one exact binary v1 WebSocket message directly into an acquired
 * downlink ring slot. A zero-length final binary message is the ordered
 * server-to-device end marker; every nonzero message must be one exact frame.
 * message_bytes is the logical message size;
 * fragment_offset and fragment_bytes describe this callback's chunk. Returns
 * UNAVAILABLE after a valid partial chunk, OK only after publishing the exact
 * complete frame, and an error for malformed or RFC-fragmented messages.
 */
enum iterate_kit_status iterate_kit_pcm_lane_receive_downlink(
    struct iterate_kit_pcm_lane *lane,
    enum iterate_kit_pcm_message_type message_type,
    bool final_fragment,
    size_t message_bytes,
    size_t fragment_offset,
    const void *fragment,
    size_t fragment_bytes);

/**
 * Timestamped form used by a real network owner. The timestamp belongs to the
 * first fragment; later chunks cannot make an old frame appear fresh.
 */
enum iterate_kit_status iterate_kit_pcm_lane_receive_downlink_at(
    struct iterate_kit_pcm_lane *lane,
    enum iterate_kit_pcm_message_type message_type,
    bool final_fragment,
    size_t message_bytes,
    size_t fragment_offset,
    const void *fragment,
    size_t fragment_bytes,
    uint64_t received_at_ms);

enum iterate_kit_status iterate_kit_pcm_lane_downlink_acquire(
    struct iterate_kit_pcm_lane *lane,
    const void **frame,
    size_t *frame_bytes);

enum iterate_kit_status iterate_kit_pcm_lane_downlink_acquire_at(
    struct iterate_kit_pcm_lane *lane,
    const void **frame,
    size_t *frame_bytes,
    uint64_t *received_at_ms);

/**
 * Acquires either one PCM frame or the ordered end marker.
 *
 * ITERATE_KIT_OK with frame=NULL and frame_bytes=0 is END_OF_STREAM. The caller
 * must still release the item. No other successful shape is valid.
 */

enum iterate_kit_status iterate_kit_pcm_lane_downlink_release(
    struct iterate_kit_pcm_lane *lane);

/**
 * Producer-side generation fence.
 *
 * Only the network producer may call this. A WebSocket can disconnect after
 * reserving a ring slot but before its final TLS fragment arrives. Consumer
 * purging cannot cancel that producer-owned reservation, so the next socket
 * generation would otherwise reject its first offset-zero frame. This reset
 * abandons only the unpublished partial message and never mutates consumer
 * sequence state.
 */
enum iterate_kit_status
iterate_kit_pcm_lane_reset_downlink_producer(
    struct iterate_kit_pcm_lane *lane);

/**
 * Consumer-side interruption primitive. It releases every queued downlink
 * frame and reports the exact number discarded.
 */
enum iterate_kit_status iterate_kit_pcm_lane_discard_downlink(
    struct iterate_kit_pcm_lane *lane,
    uint32_t *discarded_frames);

void iterate_kit_pcm_lane_metrics(
    const struct iterate_kit_pcm_lane *lane,
    struct iterate_kit_pcm_lane_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
