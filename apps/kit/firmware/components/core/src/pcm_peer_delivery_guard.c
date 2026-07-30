#include "iterate/kit/pcm_peer_delivery_guard.h"

#include <limits.h>
#include <string.h>

/*
 * This module closes a visibility gap between the application queue and the
 * network. ESP-IDF can report when a write enters its local WebSocket/TLS
 * machinery, but not the live occupancy of every mbedTLS, lwIP, and Wi-Fi
 * buffer beneath it. Those layers may accept several audio frames and release
 * them much later, turning an apparently healthy empty application ring into
 * audibly stale speech.
 *
 * RFC 6455 gives us a cheap ordered barrier already understood by every
 * standards-compliant peer: a pong echoing our ping cannot be parsed before
 * preceding PCM bytes on the same connection. We keep a bounded sliding count
 * of frames before and after that barrier. If proof does not arrive before the
 * audio freshness deadline, the caller replaces the connection; reconnecting
 * deliberately destroys the opaque old buffers.
 *
 * This is not an end-to-end provider acknowledgement. The server-side proxy
 * must separately timestamp ingress if we need device-to-proxy latency, and a
 * provider-specific acknowledgement would be needed to claim provider receipt.
 */
/*
 * On-wire payload: "itxp" | connection generation (BE) | barrier id (BE).
 * Both identities are necessary. The id distinguishes successive prefixes on
 * one socket; the generation makes a delayed pong from a replaced socket
 * harmless. A fixed 12-byte payload avoids allocation and keeps control-frame
 * overhead insignificant beside a 640-byte PCM frame. Network byte order makes
 * captured barriers readable and stable across little-endian ESP32 and any
 * future host peer; the server need only echo the opaque bytes.
 */
static const uint8_t barrier_magic[4] = {
  0x69U, 0x74U, 0x78U, 0x70U,
};

_Static_assert(
    ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES ==
        sizeof(barrier_magic) + sizeof(uint32_t) +
            sizeof(uint32_t),
    "peer delivery barrier layout and storage must agree");

/*
 * The connection-owner task is the sole state-machine writer. A lower-priority
 * diagnostics task may snapshot counters concurrently, so metrics use relaxed
 * atomics. They publish observations, not synchronization: no control-flow
 * decision in either task depends on seeing several metric fields as one
 * coherent transaction. Relaxed operations therefore avoid unnecessary
 * cross-core fences while still preventing C data races.
 *
 * Saturation is intentional. Wrapping an incident counter to zero during a
 * long unattended test would falsely suggest recovery; UINT32_MAX means "at
 * least this many".
 */
static uint32_t atomic_load_u32(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static void atomic_store_u32(
    uint32_t *destination, uint32_t value) {
  __atomic_store_n(destination, value, __ATOMIC_RELAXED);
}

static void atomic_saturating_increment(uint32_t *value) {
  uint32_t current = atomic_load_u32(value);
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
  uint32_t current = atomic_load_u32(value);
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

static void atomic_update_max(
    uint32_t *value, uint32_t candidate) {
  uint32_t current = atomic_load_u32(value);
  while (candidate > current &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             candidate,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static uint32_t saturating_age_ms(
    uint64_t now_ms, uint64_t then_ms) {
  /*
   * Producer and owner timestamps come from one monotonic clock but can be
   * sampled concurrently on different cores. A newly published capture stamp
   * may therefore lead the owner's already-taken pass sample. That observation
   * means "zero known age", not clock corruption; subtraction without the clamp
   * would wrap to almost UINT64_MAX and immediately discard fresh speech.
   *
   * Genuine capture-clock regression is still rejected by record_accept(),
   * where consecutive producer stamps are comparable. Control decisions retain
   * the full 64-bit age. Only exported diagnostics narrow to 32 bits, where
   * saturation preserves ordering across very long runs instead of making an
   * old frame look young after truncation.
   */
  const uint64_t age_ms =
      now_ms > then_ms ? now_ms - then_ms : 0U;
  return age_ms > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)age_ms;
}

static void encode_u32_be(
    uint8_t *destination, uint32_t value) {
  destination[0] = (uint8_t)(value >> 24U);
  destination[1] = (uint8_t)(value >> 16U);
  destination[2] = (uint8_t)(value >> 8U);
  destination[3] = (uint8_t)value;
}

static void build_barrier_payload(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    uint32_t barrier_id) {
  memcpy(
      guard->expected_pong,
      barrier_magic,
      sizeof(barrier_magic));
  encode_u32_be(
      guard->expected_pong + 4U,
      guard->connection_generation);
  encode_u32_be(guard->expected_pong + 8U, barrier_id);
}

static void clear_connection_state(
    struct iterate_kit_pcm_peer_delivery_guard *guard) {
  /*
   * Connection replacement is the only operation that can make hidden
   * transport bytes disappear with certainty. Clear proof state as one owner
   * operation, but deliberately preserve lifetime counters for postmortem
   * diagnosis.
   */
  guard->oldest_unconfirmed_capture_ms = 0U;
  guard->first_after_barrier_capture_ms = 0U;
  guard->latest_unconfirmed_capture_ms = 0U;
  /*
   * reset() has no clock parameter by design: replacing a connection should
   * not require the platform to take a second time sample that can disagree
   * with the conductor's policy clock. The first poll establishes the new
   * generation's silence baseline. UINT64_MAX is outside any usable elapsed
   * time and saves a permanent boolean in this RAM-sensitive object.
   */
  guard->last_peer_evidence_ms = UINT64_MAX;
  memset(guard->expected_pong, 0, sizeof(guard->expected_pong));
  guard->next_barrier_id = 0U;
  guard->frames_at_barrier = 0U;
  atomic_store_u32(&guard->unconfirmed_frames, 0U);
  guard->barrier_outstanding = false;
  guard->restart_latched = false;
}

enum iterate_kit_status
iterate_kit_pcm_peer_delivery_guard_init(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    const struct
        iterate_kit_pcm_peer_delivery_guard_options *options) {
  /*
   * The delay must be strictly inside the confirmation deadline; otherwise a
   * short utterance could time out before its first barrier is even eligible.
   * The interval must fit in the hard window so ordinary operation always has
   * room to queue the proof it depends on.
   */
  if (guard == NULL ||
      options == NULL ||
      options->tx == NULL ||
      !options->tx->initialized ||
      options->barrier_interval_frames == 0U ||
      options->maximum_unconfirmed_frames == 0U ||
      options->barrier_interval_frames >
          options->maximum_unconfirmed_frames ||
      options->maximum_barrier_delay_ms == 0U ||
      options->maximum_barrier_delay_ms >=
          options->maximum_confirmation_age_ms ||
      options->idle_peer_probe_interval_ms == 0U ||
      options->idle_peer_probe_timeout_ms == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(guard, 0, sizeof(*guard));
  guard->options = *options;
  guard->initialized = true;
  return ITERATE_KIT_OK;
}

void iterate_kit_pcm_peer_delivery_guard_reset(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    uint32_t connection_generation) {
  uint32_t abandoned_frames;
  if (guard == NULL || !guard->initialized) {
    return;
  }
  /*
   * Abandonment is expected recovery, not silent loss. Snapshot the count once
   * before clearing it so both "last incident" and lifetime totals describe
   * the same connection generation even if diagnostics reads concurrently.
   */
  abandoned_frames =
      atomic_load_u32(&guard->unconfirmed_frames);
  /*
   * A stop/start transition may reset the guard twice. Zero is housekeeping,
   * not a newer loss incident, so it must not erase the last non-empty
   * abandonment that operators need for the reconnect postmortem.
   */
  if (abandoned_frames > 0U) {
    atomic_store_u32(
        &guard->last_reset_frames_abandoned,
        abandoned_frames);
  }
  atomic_saturating_add(
      &guard->frames_abandoned,
      abandoned_frames);
  clear_connection_state(guard);
  guard->connection_generation = connection_generation;
}

enum iterate_kit_status
iterate_kit_pcm_peer_delivery_guard_record_accept(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    uint64_t capture_completed_at_ms) {
  uint32_t unconfirmed_frames;
  if (guard == NULL || !guard->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (guard->restart_latched) {
    return ITERATE_KIT_STATE_ERROR;
  }
  unconfirmed_frames =
      atomic_load_u32(&guard->unconfirmed_frames);
  if (unconfirmed_frames >=
      guard->options.maximum_unconfirmed_frames) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  if (unconfirmed_frames > 0U &&
      capture_completed_at_ms <
          guard->latest_unconfirmed_capture_ms) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (unconfirmed_frames == 0U) {
    /*
     * Freshness is measured from microphone completion, not from the local
     * socket write. A frame that waited in the application ring has already
     * spent part of its conversational latency budget.
     */
    guard->oldest_unconfirmed_capture_ms =
        capture_completed_at_ms;
  }
  if (guard->barrier_outstanding &&
      unconfirmed_frames ==
          guard->frames_at_barrier) {
    /*
     * This is the first frame ordered after the outstanding ping. When its pong
     * arrives, only the prefix before the ping becomes proven; this timestamp
     * becomes the oldest member of the remaining window without retaining a
     * timestamp for every frame.
     */
    guard->first_after_barrier_capture_ms =
        capture_completed_at_ms;
  }
  guard->latest_unconfirmed_capture_ms =
      capture_completed_at_ms;
  unconfirmed_frames++;
  atomic_store_u32(
      &guard->unconfirmed_frames, unconfirmed_frames);
  atomic_update_max(
      &guard->maximum_unconfirmed_frames,
      unconfirmed_frames);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_pcm_peer_delivery_poll_result
queue_barrier(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    bool idle_peer_probe) {
  enum iterate_kit_status status;
  const uint32_t barrier_id = guard->next_barrier_id + 1U;
  if (guard->next_barrier_id == UINT32_MAX) {
    /*
     * Reusing an id in one generation could let a years-old delayed pong prove
     * the wrong prefix. Surface the exhausted namespace as a local lifecycle
     * failure; a future API may classify this as a planned reconnect, but it
     * must never silently wrap.
     */
    return ITERATE_KIT_PCM_PEER_DELIVERY_FAILED;
  }
  build_barrier_payload(guard, barrier_id);
  /*
   * Queue directly into the single-owner transmitter so "barrier outstanding"
   * and the actual ordered control frame become true in one call. Returning a
   * request for another layer to enqueue later would leave a race in which
   * further PCM could be admitted before the supposed prefix boundary exists.
   * queue_control copies the payload; expected_pong remains our independent
   * fixed-size comparison key until receipt or reset.
   */
  status = iterate_kit_websocket_tx_queue_control(
      guard->options.tx,
      ITERATE_KIT_WEBSOCKET_PING,
      guard->expected_pong,
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES);
  if (status == ITERATE_KIT_BACKPRESSURE) {
    /*
     * Another WebSocket control frame may already own the fixed transmitter
     * slot. Sending more PCM would let the unproven window outrun its barrier,
     * so pause audio admission and retry promptly rather than allocating a
     * second control queue or silently skipping confirmation.
     */
    atomic_saturating_increment(&guard->barrier_deferrals);
    return ITERATE_KIT_PCM_PEER_DELIVERY_PAUSED;
  }
  if (status != ITERATE_KIT_OK) {
    return ITERATE_KIT_PCM_PEER_DELIVERY_FAILED;
  }
  guard->next_barrier_id = barrier_id;
  /*
   * Capture the proven prefix at queue time. Ordinarily the transmitter is
   * between PCM frames, so later accepted frames are wire-ordered after the
   * PING. If policy fires while a data frame is already partially written,
   * that frame is physically before the PING but completes afterward. We
   * deliberately leave it in the unconfirmed suffix when the PONG arrives.
   * This can overstate hidden backlog by at most that one bounded active frame;
   * it can never release bytes without proof. Avoiding the conservative frame
   * would require cross-layer partial-frame bookkeeping for no safety gain.
   */
  guard->frames_at_barrier =
      atomic_load_u32(&guard->unconfirmed_frames);
  guard->barrier_outstanding = true;
  atomic_saturating_increment(&guard->barriers_queued);
  if (idle_peer_probe) {
    /*
     * A zero-frame barrier is not an audio acknowledgement; it proves only
     * that the peer application is still parsing WebSocket control traffic.
     * Reusing the same payload/slot avoids a second liveness state machine,
     * while the dedicated counter keeps the operational meaning visible.
     */
    atomic_saturating_increment(
        &guard->idle_peer_probes_queued);
  }
  return ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED;
}

enum iterate_kit_pcm_peer_delivery_poll_result
iterate_kit_pcm_peer_delivery_guard_poll(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    uint64_t now_ms) {
  uint32_t unconfirmed_frames;
  uint64_t idle_peer_silence_ms;
  uint64_t oldest_age_ms;
  if (guard == NULL || !guard->initialized) {
    return ITERATE_KIT_PCM_PEER_DELIVERY_FAILED;
  }
  if (guard->restart_latched) {
    return ITERATE_KIT_PCM_PEER_DELIVERY_RESTART;
  }

  /*
   * The first owner poll starts the silence clock for a fresh socket. PONG is
   * the only later refresh because local writes and TCP acknowledgements do
   * not prove that the remote WebSocket application is making progress.
   */
  if (guard->last_peer_evidence_ms == UINT64_MAX) {
    guard->last_peer_evidence_ms = now_ms;
  }
  idle_peer_silence_ms =
      now_ms > guard->last_peer_evidence_ms
      ? now_ms - guard->last_peer_evidence_ms
      : 0U;
  unconfirmed_frames =
      atomic_load_u32(&guard->unconfirmed_frames);
  oldest_age_ms = unconfirmed_frames > 0U &&
          now_ms > guard->oldest_unconfirmed_capture_ms
      ? now_ms - guard->oldest_unconfirmed_capture_ms
      : 0U;
  /*
   * Freshness expiry has precedence over every progress mechanism. Queuing a
   * new barrier after the audio is already stale would preserve a connection
   * whose hidden buffers we explicitly no longer trust.
   */
  if (unconfirmed_frames > 0U &&
      oldest_age_ms >=
      guard->options.maximum_confirmation_age_ms) {
    /*
     * Once the oldest frame is stale, retaining the socket is actively
     * dangerous: bytes already accepted below us may flush after recovery.
     * Latch restart until reset so the caller cannot accidentally resume this
     * generation after one poll observes a transiently different state.
     */
    guard->restart_latched = true;
    atomic_store_u32(
        &guard->last_timeout_oldest_age_ms,
        saturating_age_ms(
            now_ms, guard->oldest_unconfirmed_capture_ms));
    atomic_saturating_increment(
        &guard->confirmation_timeouts);
    return ITERATE_KIT_PCM_PEER_DELIVERY_RESTART;
  }

  /*
   * An idle probe becomes due after the interval and gets one independently
   * configured response allowance. Compare by subtraction only after the
   * interval is reached so adding the two uint32_t knobs can never overflow.
   * The deadline also covers a probe stuck behind local control backpressure:
   * inability to put a tiny PING on the wire is itself enough reason to
   * distrust this generation before the next utterance.
   */
  if (idle_peer_silence_ms >=
          guard->options.idle_peer_probe_interval_ms &&
      idle_peer_silence_ms -
              guard->options.idle_peer_probe_interval_ms >=
          guard->options.idle_peer_probe_timeout_ms) {
    guard->restart_latched = true;
    atomic_saturating_increment(
        &guard->idle_peer_probe_timeouts);
    return ITERATE_KIT_PCM_PEER_DELIVERY_RESTART;
  }

  if (unconfirmed_frames == 0U) {
    if (!guard->barrier_outstanding &&
        idle_peer_silence_ms >=
            guard->options.idle_peer_probe_interval_ms) {
      return queue_barrier(guard, true);
    }
    return ITERATE_KIT_PCM_PEER_DELIVERY_READY;
  }
  if (!guard->barrier_outstanding &&
      (unconfirmed_frames >=
           guard->options.barrier_interval_frames ||
       oldest_age_ms >=
           guard->options.maximum_barrier_delay_ms)) {
    /*
     * Frame count handles continuous PTT efficiently; age handles the final
     * short prefix after the button is released. Both are required because
     * poll continues while capture is idle.
     */
    return queue_barrier(guard, false);
  }
  /*
   * Barrier eligibility intentionally precedes the hard-window pause. At the
   * exact window limit we still need to enqueue the proof that can reopen
   * admission; pausing first would deadlock a healthy connection.
   */
  if (unconfirmed_frames >=
      guard->options.maximum_unconfirmed_frames) {
    /*
     * This is a hard memory/latency policy, not an error. Stop admitting PCM
     * while still servicing the outstanding ping. Timeout above remains the
     * bounded escape if the peer never responds.
     */
    return ITERATE_KIT_PCM_PEER_DELIVERY_PAUSED;
  }
  return ITERATE_KIT_PCM_PEER_DELIVERY_READY;
}

enum iterate_kit_status
iterate_kit_pcm_peer_delivery_guard_receive_pong(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    const void *payload,
    size_t payload_size,
    uint64_t now_ms) {
  uint32_t confirmed_frames;
  uint32_t confirmation_age_ms;
  uint32_t unconfirmed_frames;
  bool idle_peer_probe;
  if (guard == NULL ||
      !guard->initialized ||
      (payload == NULL && payload_size > 0U)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * RESTART is a one-way verdict about this connection generation. A matching
   * pong arriving after the deadline cannot make the already-stale prefix
   * conversationally fresh again. Treat it like other expected late protocol
   * traffic and retain the window so reset can account for its abandonment.
   */
  if (guard->restart_latched) {
    atomic_saturating_increment(&guard->unmatched_pongs);
    return ITERATE_KIT_UNAVAILABLE;
  }
  if (!guard->barrier_outstanding ||
      payload_size !=
          ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES ||
      memcmp(
          payload,
          guard->expected_pong,
          ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES) !=
          0) {
    atomic_saturating_increment(&guard->unmatched_pongs);
    return ITERATE_KIT_UNAVAILABLE;
  }
  unconfirmed_frames =
      atomic_load_u32(&guard->unconfirmed_frames);
  if (guard->frames_at_barrier > unconfirmed_frames) {
    /*
     * A matching payload makes these prefix states impossible under the single
     * owner: an outstanding barrier cannot cover more frames than the current
     * window. A zero prefix is valid only for the allocation-free idle peer
     * probe. UNAVAILABLE is wrong here because it would normalize local state
     * corruption as peer noise. The owner timestamp is deliberately absent
     * from this invariant: it may lag a producer stamp sampled concurrently,
     * in which case confirmation age is simply zero.
     */
    return ITERATE_KIT_STATE_ERROR;
  }
  confirmed_frames = guard->frames_at_barrier;
  idle_peer_probe = confirmed_frames == 0U;
  /*
   * Ordered WebSocket parsing proves exactly the prefix captured when the ping
   * was queued—never frames accepted after it. Advancing by the whole current
   * count here would hide delayed audio in lower buffers and is the subtle bug
   * this two-prefix representation exists to prevent.
   */
  confirmation_age_ms = idle_peer_probe
      ? 0U
      : saturating_age_ms(
            now_ms, guard->oldest_unconfirmed_capture_ms);
  atomic_saturating_add(
      &guard->frames_confirmed, confirmed_frames);
  atomic_saturating_increment(&guard->barriers_confirmed);
  if (idle_peer_probe) {
    atomic_saturating_increment(
        &guard->idle_peer_probes_confirmed);
  }
  guard->last_peer_evidence_ms = now_ms;
  atomic_store_u32(
      &guard->last_confirmation_oldest_age_ms,
      confirmation_age_ms);
  atomic_update_max(
      &guard->maximum_confirmation_oldest_age_ms,
      confirmation_age_ms);
  unconfirmed_frames -= confirmed_frames;
  atomic_store_u32(
      &guard->unconfirmed_frames, unconfirmed_frames);
  guard->frames_at_barrier = 0U;
  guard->barrier_outstanding = false;
  memset(guard->expected_pong, 0, sizeof(guard->expected_pong));
  if (unconfirmed_frames == 0U) {
    guard->oldest_unconfirmed_capture_ms = 0U;
    guard->first_after_barrier_capture_ms = 0U;
    guard->latest_unconfirmed_capture_ms = 0U;
  } else {
    /*
     * first_after_barrier_capture_ms was recorded precisely when this suffix
     * began. Promote it to the next window's oldest timestamp; no scan or
     * per-frame timestamp array is needed on the realtime path.
     */
    guard->oldest_unconfirmed_capture_ms =
        guard->first_after_barrier_capture_ms;
    guard->first_after_barrier_capture_ms = 0U;
  }
  return ITERATE_KIT_OK;
}

void iterate_kit_pcm_peer_delivery_guard_metrics(
    const struct iterate_kit_pcm_peer_delivery_guard *guard,
    struct iterate_kit_pcm_peer_delivery_guard_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (guard == NULL || !guard->initialized) {
    return;
  }
  /*
   * Independent relaxed loads can straddle one state transition. That is
   * acceptable for periodic diagnostics: each scalar remains truthful and all
   * lifetime counters are monotonic. The control algorithm never consumes this
   * snapshot, so making it transactional would add synchronization cost without
   * improving correctness.
   */
  metrics->unconfirmed_frames =
      atomic_load_u32(&guard->unconfirmed_frames);
  metrics->maximum_unconfirmed_frames =
      atomic_load_u32(&guard->maximum_unconfirmed_frames);
  metrics->frames_confirmed =
      atomic_load_u32(&guard->frames_confirmed);
  metrics->frames_abandoned =
      atomic_load_u32(&guard->frames_abandoned);
  metrics->barriers_queued =
      atomic_load_u32(&guard->barriers_queued);
  metrics->barriers_confirmed =
      atomic_load_u32(&guard->barriers_confirmed);
  metrics->barrier_deferrals =
      atomic_load_u32(&guard->barrier_deferrals);
  metrics->unmatched_pongs =
      atomic_load_u32(&guard->unmatched_pongs);
  metrics->confirmation_timeouts =
      atomic_load_u32(&guard->confirmation_timeouts);
  metrics->idle_peer_probes_queued =
      atomic_load_u32(&guard->idle_peer_probes_queued);
  metrics->idle_peer_probes_confirmed =
      atomic_load_u32(
          &guard->idle_peer_probes_confirmed);
  metrics->idle_peer_probe_timeouts =
      atomic_load_u32(&guard->idle_peer_probe_timeouts);
  metrics->last_timeout_oldest_age_ms =
      atomic_load_u32(&guard->last_timeout_oldest_age_ms);
  metrics->last_reset_frames_abandoned =
      atomic_load_u32(&guard->last_reset_frames_abandoned);
  metrics->last_confirmation_oldest_age_ms =
      atomic_load_u32(
          &guard->last_confirmation_oldest_age_ms);
  metrics->maximum_confirmation_oldest_age_ms =
      atomic_load_u32(
          &guard->maximum_confirmation_oldest_age_ms);
}
