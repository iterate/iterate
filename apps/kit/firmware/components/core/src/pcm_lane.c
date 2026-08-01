#include "iterate/kit/pcm_lane.h"

#include <limits.h>
#include <string.h>

#define ITERATE_KIT_PCM_UPLINK_END_MARKER_TAG \
  (UINT64_C(1) << 63U)

/*
 * The lane is the only application-level PCM buffering boundary. Microphone
 * capture produces timestamped, fixed-duration frames into one SPSC ring; the
 * network task consumes them. The network task produces speaker frames into a
 * second ring; playback consumes them. Neither direction allocates or waits.
 *
 * We deliberately do not introduce a generic packet queue or variable-format
 * envelope. Protocol v1 is one 20 ms PCM message per WebSocket message, so a
 * fixed slot makes memory cost, queue age, and malformed-input handling
 * mechanically bounded. The capture timestamp is local metadata beside the
 * bytes, never an on-wire header; this keeps the PCM lane directly usable by a
 * voice-provider proxy without parsing or resampling on the device.
 *
 * A full uplink has stronger meaning than one lost frame. FIFO history is now
 * old enough that continuing the same microphone epoch can produce delayed
 * speech after recovery. The producer therefore drops the newest frame and
 * publishes an epoch-reset request; the single consumer performs the purge
 * because only it may advance the read sequence. This avoids unsafe
 * producer-side eviction while making the loss and recovery explicit.
 *
 * Downlink short reads are copied directly into one write-acquired playback
 * slot beside its local receive timestamp. A second reassembly buffer was
 * rejected because it adds a permanent 640-byte copy and another ownership
 * transition. Any malformed offset, message type, finality, or socket
 * generation cancels that producer-owned reservation so a bad/abandoned server
 * frame cannot wedge the bounded ring or poison the next connection.
 *
 * Zero-length boundary markers occupy their respective media rings. An
 * out-of-band boolean was rejected because it can become visible before older
 * queued PCM: on downlink that stops the speaker early; on uplink it lets an
 * independent control socket commit the microphone turn before its tail.
 * Keeping markers in FIFO order also lets generation discard remove stale
 * completion state with the stale frames it describes.
 */

/*
 * Metrics are observations only and may be sampled by diagnostics on another
 * core. Relaxed atomics prevent C data races without putting fences on every
 * audio frame. The reset request is different: its release/exchange pairing
 * publishes a producer decision to the consumer that owns the actual purge.
 */
static uint32_t atomic_load_relaxed(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static void atomic_store_release(
    uint32_t *destination, uint32_t value) {
  __atomic_store_n(destination, value, __ATOMIC_RELEASE);
}

static uint32_t atomic_exchange_acquire(
    uint32_t *destination, uint32_t value) {
  return __atomic_exchange_n(
      destination, value, __ATOMIC_ACQUIRE);
}

static void atomic_saturating_increment(uint32_t *value) {
  uint32_t current = atomic_load_relaxed(value);
  while (current != UINT32_MAX &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             current + 1U,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static void atomic_saturating_add(
    uint32_t *value, uint32_t amount) {
  uint32_t current = atomic_load_relaxed(value);
  uint32_t next;
  do {
    next = amount > UINT32_MAX - current
        ? UINT32_MAX
        : current + amount;
  } while (!__atomic_compare_exchange_n(
      value,
      &current,
      next,
      false,
      __ATOMIC_RELAXED,
      __ATOMIC_RELAXED));
}

static void atomic_record_maximum(
    uint32_t *value, uint32_t observation) {
  uint32_t current = atomic_load_relaxed(value);
  while (observation > current &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             observation,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static bool valid_lane(const struct iterate_kit_pcm_lane *lane) {
  return lane != NULL &&
      lane->initialized &&
      lane->uplink != NULL &&
      lane->downlink != NULL;
}

static bool valid_ring(
    const struct iterate_kit_spsc_ring *ring,
    size_t slot_size) {
  return ring != NULL &&
      ring->initialized &&
      ring->slot_size == slot_size;
}

static enum iterate_kit_status publish_uplink_copy(
    struct iterate_kit_spsc_ring *ring,
    const void *frame,
    size_t frame_bytes,
    uint64_t capture_completed_at_ms) {
  void *destination = NULL;
  size_t capacity = 0U;
  struct iterate_kit_pcm_uplink_slot *slot;
  enum iterate_kit_status status =
      iterate_kit_spsc_ring_write_acquire_reserving(
          ring,
          1U,
          &destination,
          &capacity);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (capacity != sizeof(*slot)) {
    /*
     * Ring shape is validated at init, so disagreement here is memory-layout
     * corruption or an ownership bug—not normal backpressure. Cancel before
     * returning so even the defect path does not leave the producer acquired.
     */
    (void)iterate_kit_spsc_ring_write_cancel(ring);
    return ITERATE_KIT_STATE_ERROR;
  }
  slot = destination;
  slot->capture_completed_at_ms = capture_completed_at_ms;
  memcpy(slot->frame, frame, frame_bytes);
  status = iterate_kit_spsc_ring_write_publish(
      ring, sizeof(*slot));
  if (status != ITERATE_KIT_OK) {
    (void)iterate_kit_spsc_ring_write_cancel(ring);
  }
  return status;
}

static enum iterate_kit_status publish_uplink_end_marker(
    struct iterate_kit_spsc_ring *ring,
    uint64_t capture_completed_at_ms) {
  void *destination = NULL;
  size_t capacity = 0U;
  struct iterate_kit_pcm_uplink_slot *slot;
  enum iterate_kit_status status =
      iterate_kit_spsc_ring_write_acquire(
          ring, &destination, &capacity);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (capacity != sizeof(*slot)) {
    (void)iterate_kit_spsc_ring_write_cancel(ring);
    return ITERATE_KIT_STATE_ERROR;
  }
  slot = destination;
  slot->capture_completed_at_ms =
      capture_completed_at_ms |
      ITERATE_KIT_PCM_UPLINK_END_MARKER_TAG;
  status = iterate_kit_spsc_ring_write_publish(
      ring, sizeof(*slot));
  if (status != ITERATE_KIT_OK) {
    (void)iterate_kit_spsc_ring_write_cancel(ring);
  }
  return status;
}

static void cancel_downlink_fragment(
    struct iterate_kit_pcm_lane *lane) {
  if (!lane->downlink_fragment_active) {
    return;
  }
  (void)iterate_kit_spsc_ring_write_cancel(lane->downlink);
  lane->downlink_fragment_destination = NULL;
  lane->downlink_fragment_received = 0U;
  lane->downlink_fragment_received_at_ms = 0U;
  lane->downlink_fragment_active = false;
}

static void reset_downlink_interarrival_baseline(
    struct iterate_kit_pcm_lane *lane) {
  lane->downlink_previous_frame_received_at_ms = 0U;
  lane->downlink_previous_frame_received_at_valid = false;
}

static void note_downlink_frame_received(
    struct iterate_kit_pcm_lane *lane,
    uint64_t received_at_ms) {
  uint64_t interval_ms;
  uint32_t bounded_interval_ms;

  /*
   * The untimestamped compatibility entry point supplies zero. Mixing that
   * synthetic value with real device timestamps would create either a giant
   * first interval or a clock regression, so it explicitly breaks the local
   * baseline and contributes no sample.
   */
  if (received_at_ms == 0U) {
    reset_downlink_interarrival_baseline(lane);
    return;
  }
  if (lane->downlink_previous_frame_received_at_valid) {
    if (received_at_ms <
        lane->downlink_previous_frame_received_at_ms) {
      /*
       * ESP's monotonic timer should not regress. Still bound and classify the
       * impossible observation rather than underflowing into an enormous gap
       * that would misdiagnose Wi-Fi jitter.
       */
      atomic_saturating_increment(
          &lane->downlink_interarrival_clock_regressions);
    } else {
      interval_ms =
          received_at_ms -
          lane->downlink_previous_frame_received_at_ms;
      bounded_interval_ms =
          interval_ms > UINT32_MAX
          ? UINT32_MAX
          : (uint32_t)interval_ms;
      atomic_saturating_increment(
          &lane->downlink_interarrival_samples);
      atomic_record_maximum(
          &lane->downlink_maximum_interarrival_ms,
          bounded_interval_ms);
    }
  }
  lane->downlink_previous_frame_received_at_ms = received_at_ms;
  lane->downlink_previous_frame_received_at_valid = true;
}

enum iterate_kit_status iterate_kit_pcm_lane_init(
    struct iterate_kit_pcm_lane *lane,
    struct iterate_kit_spsc_ring *uplink,
    struct iterate_kit_spsc_ring *downlink) {
  if (lane == NULL ||
      !valid_ring(
          uplink, sizeof(struct iterate_kit_pcm_uplink_slot)) ||
      !valid_ring(
          downlink, sizeof(struct iterate_kit_pcm_downlink_slot)) ||
      uplink == downlink) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(lane, 0, sizeof(*lane));
  lane->uplink = uplink;
  lane->downlink = downlink;
  lane->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_lane_submit_uplink_at(
    struct iterate_kit_pcm_lane *lane,
    const void *frame,
    size_t frame_bytes,
    uint64_t capture_completed_at_ms) {
  enum iterate_kit_status status;
  if (!valid_lane(lane)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (frame == NULL ||
      frame_bytes != ITERATE_KIT_PCM_V1_FRAME_BYTES ||
      (capture_completed_at_ms &
       ITERATE_KIT_PCM_UPLINK_END_MARKER_TAG) != 0U) {
    atomic_saturating_increment(&lane->uplink_invalid_frames);
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  status = publish_uplink_copy(
      lane->uplink,
      frame,
      frame_bytes,
      capture_completed_at_ms);
  if (status == ITERATE_KIT_OK) {
    atomic_saturating_increment(&lane->uplink_frames_accepted);
  } else if (status == ITERATE_KIT_BACKPRESSURE) {
    atomic_saturating_increment(
        &lane->uplink_epoch_reset_requests);
    atomic_store_release(
        &lane->uplink_epoch_reset_requested, 1U);
  }
  return status;
}

enum iterate_kit_status
iterate_kit_pcm_lane_submit_uplink_end_marker_at(
    struct iterate_kit_pcm_lane *lane,
    uint64_t capture_completed_at_ms) {
  enum iterate_kit_status status;
  if (!valid_lane(lane)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if ((capture_completed_at_ms &
       ITERATE_KIT_PCM_UPLINK_END_MARKER_TAG) != 0U) {
    atomic_saturating_increment(&lane->uplink_invalid_frames);
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  status = publish_uplink_end_marker(
      lane->uplink, capture_completed_at_ms);
  if (status == ITERATE_KIT_OK) {
    atomic_saturating_increment(
        &lane->uplink_end_markers_accepted);
  } else if (status == ITERATE_KIT_BACKPRESSURE) {
    /*
     * A marker that cannot follow the audio it fences is not optional
     * telemetry. Request the same destructive generation reset as a full PCM
     * ring; userspace will time out the missing marker instead of committing
     * an ambiguous turn.
     */
    atomic_saturating_increment(
        &lane->uplink_epoch_reset_requests);
    atomic_store_release(
        &lane->uplink_epoch_reset_requested, 1U);
  }
  return status;
}

enum iterate_kit_status iterate_kit_pcm_lane_uplink_acquire(
    struct iterate_kit_pcm_lane *lane,
    const void **frame,
    size_t *frame_bytes,
    uint64_t *capture_completed_at_ms) {
  const void *storage = NULL;
  size_t storage_bytes = 0U;
  const struct iterate_kit_pcm_uplink_slot *slot;
  enum iterate_kit_status status;
  if (frame != NULL) {
    *frame = NULL;
  }
  if (frame_bytes != NULL) {
    *frame_bytes = 0U;
  }
  if (capture_completed_at_ms != NULL) {
    *capture_completed_at_ms = 0U;
  }
  if (!valid_lane(lane)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (frame == NULL ||
      frame_bytes == NULL ||
      capture_completed_at_ms == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  status = iterate_kit_spsc_ring_read_acquire(
      lane->uplink, &storage, &storage_bytes);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (storage_bytes != sizeof(*slot)) {
    (void)iterate_kit_spsc_ring_read_release(lane->uplink);
    return ITERATE_KIT_STATE_ERROR;
  }
  slot = storage;
  if ((slot->capture_completed_at_ms &
       ITERATE_KIT_PCM_UPLINK_END_MARKER_TAG) != 0U) {
    *frame = NULL;
    *frame_bytes = 0U;
  } else {
    *frame = slot->frame;
    *frame_bytes = sizeof(slot->frame);
  }
  *capture_completed_at_ms =
      slot->capture_completed_at_ms &
      ~ITERATE_KIT_PCM_UPLINK_END_MARKER_TAG;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_lane_uplink_release(
    struct iterate_kit_pcm_lane *lane) {
  if (!valid_lane(lane)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return iterate_kit_spsc_ring_read_release(lane->uplink);
}

enum iterate_kit_status
iterate_kit_pcm_lane_take_uplink_epoch_reset_request(
    struct iterate_kit_pcm_lane *lane,
    bool *requested) {
  if (requested != NULL) {
    *requested = false;
  }
  if (!valid_lane(lane) || requested == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *requested = atomic_exchange_acquire(
      &lane->uplink_epoch_reset_requested, 0U) != 0U;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_lane_receive_downlink(
    struct iterate_kit_pcm_lane *lane,
    enum iterate_kit_pcm_message_type message_type,
    bool final_fragment,
    size_t message_bytes,
    size_t fragment_offset,
    const void *fragment,
    size_t fragment_bytes) {
  return iterate_kit_pcm_lane_receive_downlink_at(
      lane,
      message_type,
      final_fragment,
      message_bytes,
      fragment_offset,
      fragment,
      fragment_bytes,
      0U);
}

enum iterate_kit_status iterate_kit_pcm_lane_receive_downlink_at(
    struct iterate_kit_pcm_lane *lane,
    enum iterate_kit_pcm_message_type message_type,
    bool final_fragment,
    size_t message_bytes,
    size_t fragment_offset,
    const void *fragment,
    size_t fragment_bytes,
    uint64_t received_at_ms) {
  enum iterate_kit_status status;
  void *destination = NULL;
  size_t capacity = 0U;
  struct iterate_kit_pcm_downlink_slot *slot;
  if (!valid_lane(lane)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (message_type != ITERATE_KIT_PCM_MESSAGE_BINARY) {
    cancel_downlink_fragment(lane);
    atomic_saturating_increment(
        &lane->downlink_nonbinary_messages);
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!final_fragment) {
    cancel_downlink_fragment(lane);
    atomic_saturating_increment(
        &lane->downlink_fragmented_messages);
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (message_bytes == 0U) {
    if (lane->downlink_fragment_active) {
      cancel_downlink_fragment(lane);
      atomic_saturating_increment(
          &lane->downlink_fragmented_messages);
      return ITERATE_KIT_INVALID_ARGUMENT;
    }
    if (fragment_offset != 0U || fragment_bytes != 0U) {
      atomic_saturating_increment(
          &lane->downlink_malformed_frames);
      return ITERATE_KIT_INVALID_ARGUMENT;
    }
    status = iterate_kit_spsc_ring_write_acquire(
        lane->downlink,
        &destination,
        &capacity);
    if (status != ITERATE_KIT_OK) {
      return status;
    }
    if (capacity != sizeof(*slot)) {
      (void)iterate_kit_spsc_ring_write_cancel(lane->downlink);
      return ITERATE_KIT_STATE_ERROR;
    }
    slot = destination;
    slot->kind = ITERATE_KIT_PCM_DOWNLINK_END_OF_STREAM;
    slot->received_at_ms = received_at_ms;
    status = iterate_kit_spsc_ring_write_publish(
        lane->downlink, sizeof(*slot));
    if (status != ITERATE_KIT_OK) {
      (void)iterate_kit_spsc_ring_write_cancel(lane->downlink);
      return status;
    }
    atomic_saturating_increment(
        &lane->downlink_end_markers_accepted);
    reset_downlink_interarrival_baseline(lane);
    return ITERATE_KIT_OK;
  }
  if (message_bytes != ITERATE_KIT_PCM_V1_FRAME_BYTES ||
      fragment == NULL ||
      fragment_bytes == 0U ||
      fragment_offset > message_bytes ||
      fragment_bytes > message_bytes - fragment_offset) {
    cancel_downlink_fragment(lane);
    atomic_saturating_increment(
        &lane->downlink_malformed_frames);
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  if (fragment_offset == 0U) {
    if (lane->downlink_fragment_active) {
      cancel_downlink_fragment(lane);
      atomic_saturating_increment(
          &lane->downlink_fragmented_messages);
      return ITERATE_KIT_INVALID_ARGUMENT;
    }
    status = iterate_kit_spsc_ring_write_acquire(
        lane->downlink,
        &destination,
        &capacity);
    if (status != ITERATE_KIT_OK) {
      return status;
    }
    if (capacity != sizeof(*slot)) {
      (void)iterate_kit_spsc_ring_write_cancel(lane->downlink);
      lane->downlink_fragment_destination = NULL;
      return ITERATE_KIT_STATE_ERROR;
    }
    slot = destination;
    slot->kind = ITERATE_KIT_PCM_DOWNLINK_FRAME;
    slot->received_at_ms = received_at_ms;
    lane->downlink_fragment_destination = slot->frame;
    lane->downlink_fragment_received = 0U;
    lane->downlink_fragment_received_at_ms = received_at_ms;
    lane->downlink_fragment_active = true;
  } else if (!lane->downlink_fragment_active ||
             fragment_offset !=
                 lane->downlink_fragment_received) {
    cancel_downlink_fragment(lane);
    atomic_saturating_increment(
        &lane->downlink_fragmented_messages);
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  memcpy(
      lane->downlink_fragment_destination + fragment_offset,
      fragment,
      fragment_bytes);
  lane->downlink_fragment_received += fragment_bytes;
  if (lane->downlink_fragment_received < message_bytes) {
    return ITERATE_KIT_UNAVAILABLE;
  }

  const uint64_t completed_received_at_ms =
      lane->downlink_fragment_received_at_ms;
  status = iterate_kit_spsc_ring_write_publish(
      lane->downlink,
      sizeof(struct iterate_kit_pcm_downlink_slot));
  lane->downlink_fragment_destination = NULL;
  lane->downlink_fragment_received = 0U;
  lane->downlink_fragment_received_at_ms = 0U;
  lane->downlink_fragment_active = false;
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  note_downlink_frame_received(
      lane, completed_received_at_ms);
  atomic_saturating_increment(
      &lane->downlink_frames_accepted);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_lane_downlink_acquire(
    struct iterate_kit_pcm_lane *lane,
    const void **frame,
    size_t *frame_bytes) {
  uint64_t ignored_received_at_ms;
  return iterate_kit_pcm_lane_downlink_acquire_at(
      lane, frame, frame_bytes, &ignored_received_at_ms);
}

enum iterate_kit_status iterate_kit_pcm_lane_downlink_acquire_at(
    struct iterate_kit_pcm_lane *lane,
    const void **frame,
    size_t *frame_bytes,
    uint64_t *received_at_ms) {
  const void *storage = NULL;
  size_t storage_bytes = 0U;
  const struct iterate_kit_pcm_downlink_slot *slot;
  enum iterate_kit_status status;
  if (frame != NULL) {
    *frame = NULL;
  }
  if (frame_bytes != NULL) {
    *frame_bytes = 0U;
  }
  if (received_at_ms != NULL) {
    *received_at_ms = 0U;
  }
  if (!valid_lane(lane)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (frame == NULL ||
      frame_bytes == NULL ||
      received_at_ms == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  status = iterate_kit_spsc_ring_read_acquire(
      lane->downlink, &storage, &storage_bytes);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (storage_bytes != sizeof(*slot)) {
    (void)iterate_kit_spsc_ring_read_release(lane->downlink);
    return ITERATE_KIT_STATE_ERROR;
  }
  slot = storage;
  if (slot->kind == ITERATE_KIT_PCM_DOWNLINK_FRAME) {
    *frame = slot->frame;
    *frame_bytes = sizeof(slot->frame);
  } else if (
      slot->kind == ITERATE_KIT_PCM_DOWNLINK_END_OF_STREAM) {
    *frame = NULL;
    *frame_bytes = 0U;
  } else {
    (void)iterate_kit_spsc_ring_read_release(lane->downlink);
    return ITERATE_KIT_STATE_ERROR;
  }
  *received_at_ms = slot->received_at_ms;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_lane_downlink_release(
    struct iterate_kit_pcm_lane *lane) {
  if (!valid_lane(lane)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return iterate_kit_spsc_ring_read_release(lane->downlink);
}

enum iterate_kit_status
iterate_kit_pcm_lane_reset_downlink_producer(
    struct iterate_kit_pcm_lane *lane) {
  if (!valid_lane(lane)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (lane->downlink_fragment_active) {
    cancel_downlink_fragment(lane);
    atomic_saturating_increment(
        &lane->downlink_generation_fragment_resets);
  }
  /*
   * Even a generation change with no partial frame separates response clocks.
   * Retaining the old baseline would report reconnect time as media jitter.
   */
  reset_downlink_interarrival_baseline(lane);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_lane_discard_downlink(
    struct iterate_kit_pcm_lane *lane,
    uint32_t *discarded_frames) {
  uint32_t discarded = 0U;
  uint32_t end_markers_discarded = 0U;
  uint32_t items_discarded = 0U;
  uint32_t discard_limit;
  struct iterate_kit_spsc_ring_metrics ring_metrics;
  if (discarded_frames != NULL) {
    *discarded_frames = 0U;
  }
  if (!valid_lane(lane) || discarded_frames == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Snapshot the consumer-visible epoch. The network producer may publish
   * fresh frames concurrently while an interruption is being reconciled.
   * Draining "until empty" could chase that producer indefinitely on a fast
   * socket and delete the new epoch; the fixed initial depth makes work
   * bounded and leaves later publications for the next playback generation.
   */
  iterate_kit_spsc_ring_metrics(lane->downlink, &ring_metrics);
  discard_limit = ring_metrics.current_slots;
  while (items_discarded < discard_limit) {
    const void *frame = NULL;
    size_t frame_bytes = 0U;
    const enum iterate_kit_status acquire_status =
        iterate_kit_spsc_ring_read_acquire(
            lane->downlink, &frame, &frame_bytes);
    enum iterate_kit_status release_status;
    const struct iterate_kit_pcm_downlink_slot *slot;
    if (acquire_status == ITERATE_KIT_UNAVAILABLE) {
      break;
    }
    if (acquire_status != ITERATE_KIT_OK) {
      return acquire_status;
    }
    if (frame_bytes != sizeof(*slot)) {
      (void)iterate_kit_spsc_ring_read_release(lane->downlink);
      return ITERATE_KIT_STATE_ERROR;
    }
    slot = frame;
    if (slot->kind == ITERATE_KIT_PCM_DOWNLINK_FRAME) {
      if (discarded != UINT32_MAX) {
        discarded++;
      }
    } else if (
        slot->kind == ITERATE_KIT_PCM_DOWNLINK_END_OF_STREAM) {
      if (end_markers_discarded != UINT32_MAX) {
        end_markers_discarded++;
      }
    } else {
      (void)iterate_kit_spsc_ring_read_release(lane->downlink);
      return ITERATE_KIT_STATE_ERROR;
    }
    release_status =
        iterate_kit_spsc_ring_read_release(lane->downlink);
    if (release_status != ITERATE_KIT_OK) {
      return release_status;
    }
    if (items_discarded != UINT32_MAX) {
      items_discarded++;
    }
  }
  atomic_saturating_add(
      &lane->downlink_frames_discarded, discarded);
  atomic_saturating_add(
      &lane->downlink_end_markers_discarded,
      end_markers_discarded);
  *discarded_frames = discarded;
  return ITERATE_KIT_OK;
}

void iterate_kit_pcm_lane_metrics(
    const struct iterate_kit_pcm_lane *lane,
    struct iterate_kit_pcm_lane_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (!valid_lane(lane)) {
    return;
  }
  iterate_kit_spsc_ring_metrics(lane->uplink, &metrics->uplink);
  iterate_kit_spsc_ring_metrics(
      lane->downlink, &metrics->downlink);
  metrics->uplink_frames_accepted =
      atomic_load_relaxed(&lane->uplink_frames_accepted);
  metrics->uplink_end_markers_accepted =
      atomic_load_relaxed(
          &lane->uplink_end_markers_accepted);
  metrics->uplink_invalid_frames =
      atomic_load_relaxed(&lane->uplink_invalid_frames);
  metrics->uplink_epoch_reset_requests =
      atomic_load_relaxed(
          &lane->uplink_epoch_reset_requests);
  metrics->downlink_frames_accepted =
      atomic_load_relaxed(&lane->downlink_frames_accepted);
  metrics->downlink_end_markers_accepted =
      atomic_load_relaxed(
          &lane->downlink_end_markers_accepted);
  metrics->downlink_end_markers_discarded =
      atomic_load_relaxed(
          &lane->downlink_end_markers_discarded);
  metrics->downlink_nonbinary_messages =
      atomic_load_relaxed(&lane->downlink_nonbinary_messages);
  metrics->downlink_fragmented_messages =
      atomic_load_relaxed(&lane->downlink_fragmented_messages);
  metrics->downlink_malformed_frames =
      atomic_load_relaxed(&lane->downlink_malformed_frames);
  metrics->downlink_frames_discarded =
      atomic_load_relaxed(&lane->downlink_frames_discarded);
  metrics->downlink_generation_fragment_resets =
      atomic_load_relaxed(
          &lane->downlink_generation_fragment_resets);
  metrics->downlink_interarrival_samples =
      atomic_load_relaxed(
          &lane->downlink_interarrival_samples);
  metrics->downlink_maximum_interarrival_ms =
      atomic_load_relaxed(
          &lane->downlink_maximum_interarrival_ms);
  metrics->downlink_interarrival_clock_regressions =
      atomic_load_relaxed(
          &lane->downlink_interarrival_clock_regressions);
}
