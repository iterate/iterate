#ifndef ITERATE_KIT_PCM_PEER_DELIVERY_GUARD_H
#define ITERATE_KIT_PCM_PEER_DELIVERY_GUARD_H

#include "iterate/kit/status.h"
#include "iterate/kit/websocket_tx.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * "itxp" + one 32-bit connection generation + one 32-bit barrier id.
   * Keeping the size public prevents the state struct, encoder, and tests from
   * acquiring three subtly different copies of an on-wire invariant.
   */
  ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES = 12,
};

/**
 * The guard is deliberately a policy state machine rather than another audio
 * queue. PCM stays in the existing lane and WebSocket transmitter; this layer
 * decides only whether sending more of it is still consistent with realtime
 * conversation.
 *
 * READY permits another PCM frame. BARRIER_QUEUED tells the connection owner
 * to flush control traffic before returning to PCM. PAUSED is healthy bounded
 * backpressure: accepting another frame would exceed what we can prove fresh.
 * RESTART means the connection must be replaced and its old bytes abandoned.
 * FAILED is reserved for a local invariant or programming failure, so expected
 * network recovery never pollutes the generic error signal.
 */
enum iterate_kit_pcm_peer_delivery_poll_result {
  ITERATE_KIT_PCM_PEER_DELIVERY_READY = 0,
  ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_QUEUED,
  ITERATE_KIT_PCM_PEER_DELIVERY_PAUSED,
  ITERATE_KIT_PCM_PEER_DELIVERY_RESTART,
  ITERATE_KIT_PCM_PEER_DELIVERY_FAILED,
};

struct iterate_kit_pcm_peer_delivery_guard_options {
  /*
   * The guard borrows the connection owner's transmitter. It queues only
   * control frames and never writes the socket itself, preserving one writer
   * and the WebSocket transmitter's partial-write ordering.
   */
  struct iterate_kit_websocket_tx *tx;

  /*
   * The interval limits normal-case confirmation latency and ping overhead.
   * The hard window is a separate larger bound so frames captured while a ping
   * is in flight can continue briefly without allowing opaque TLS/lwIP queues
   * to grow without evidence of peer progress.
   */
  uint32_t barrier_interval_frames;
  uint32_t maximum_unconfirmed_frames;

  /*
   * Push-to-talk may end before a full interval. The delay therefore forces a
   * barrier for a short final prefix even when no more microphone frames arrive.
   * Confirmation age is the freshness deadline: crossing it makes reconnect
   * cheaper and safer than risking delayed speech after network recovery.
   */
  uint32_t maximum_barrier_delay_ms;
  uint32_t maximum_confirmation_age_ms;

  /*
   * Audio barriers prove progress only while microphone frames exist. These
   * two bounds close the silent half-open case: after `interval` without a
   * matching pong, queue the same ordered WebSocket probe with an empty audio
   * prefix; after a further `timeout`, replace the socket. TCP keepalive alone
   * was rejected because a live kernel can acknowledge TCP while a wedged
   * application never parses another WebSocket frame.
   *
   * Both values are non-zero. Keeping interval and response allowance
   * separate makes ping overhead independently tunable from failure-detection
   * latency.
   */
  uint32_t idle_peer_probe_interval_ms;
  uint32_t idle_peer_probe_timeout_ms;
};

/**
 * Observable evidence for the transport's otherwise opaque buffers.
 *
 * `unconfirmed_frames` is an exact count in this state machine and therefore a
 * conservative byte bound across TLS/lwIP/Wi-Fi, not a claim that each hidden
 * buffer exposes its occupancy. Confirmation means the remote WebSocket parser
 * returned our ping payload. It does not mean Grok—or another provider—has
 * consumed the PCM.
 *
 * Counters saturate rather than wrap because an unattended endurance run must
 * never make a worsening incident look as though it recovered. A diagnostics
 * task may snapshot these fields while the connection owner updates them.
 */
struct iterate_kit_pcm_peer_delivery_guard_metrics {
  uint32_t unconfirmed_frames;
  uint32_t maximum_unconfirmed_frames;
  uint32_t frames_confirmed;
  uint32_t frames_abandoned;
  uint32_t barriers_queued;
  uint32_t barriers_confirmed;
  uint32_t barrier_deferrals;
  uint32_t unmatched_pongs;
  uint32_t confirmation_timeouts;
  uint32_t idle_peer_probes_queued;
  uint32_t idle_peer_probes_confirmed;
  uint32_t idle_peer_probe_timeouts;
  uint32_t last_timeout_oldest_age_ms;
  uint32_t last_reset_frames_abandoned;
  uint32_t last_confirmation_oldest_age_ms;
  uint32_t maximum_confirmation_oldest_age_ms;
};

/**
 * Bounds PCM bytes accepted by local TLS/TCP but not yet parsed by the peer.
 *
 * A successful socket write is not peer delivery: mbedTLS, lwIP, and the
 * Wi-Fi driver may retain bytes after the application ring is empty. This
 * allocation-free state machine inserts an RFC 6455 ping after a bounded PCM
 * prefix. A matching pong proves that the peer WebSocket parser consumed all
 * preceding bytes on that ordered connection. PCM messages remain pure audio.
 * Sequence metadata was deliberately kept out of PCM v1 so the device/provider
 * lane remains exactly the provider's preferred audio format; RFC 6455 control
 * frames give the proof without changing those application messages.
 *
 * One connection-owner task calls every state-mutating function.
 * record_accept() is called only after one complete PCM WebSocket frame has
 * been accepted by the local transport. poll() is called before accepting
 * another frame and even while capture is idle, so unconfirmed audio cannot
 * outlive the age policy. metrics() alone may run on a diagnostics task; it
 * reads independently published scalar observations and never drives policy.
 *
 * State before an outstanding barrier is an ordered prefix. State after it is
 * a second prefix that remains unconfirmed when the pong arrives. The three
 * capture timestamps retain only the oldest boundary of those prefixes; the
 * guard intentionally does not allocate or retain one timestamp per frame.
 */
struct iterate_kit_pcm_peer_delivery_guard {
  struct iterate_kit_pcm_peer_delivery_guard_options options;
  uint64_t oldest_unconfirmed_capture_ms;
  uint64_t first_after_barrier_capture_ms;
  uint64_t latest_unconfirmed_capture_ms;
  /*
   * UINT64_MAX means the new generation has not yet taken its first policy
   * clock sample. A sentinel avoids another boolean and lets reset remain
   * independent of the platform clock. Every matching delivery or idle-probe
   * pong refreshes this timestamp.
   */
  uint64_t last_peer_evidence_ms;
  uint8_t expected_pong[
      ITERATE_KIT_PCM_PEER_DELIVERY_BARRIER_PAYLOAD_BYTES];
  uint32_t connection_generation;
  uint32_t next_barrier_id;
  uint32_t frames_at_barrier;
  uint32_t unconfirmed_frames;
  uint32_t maximum_unconfirmed_frames;
  uint32_t frames_confirmed;
  uint32_t frames_abandoned;
  uint32_t barriers_queued;
  uint32_t barriers_confirmed;
  uint32_t barrier_deferrals;
  uint32_t unmatched_pongs;
  uint32_t confirmation_timeouts;
  uint32_t idle_peer_probes_queued;
  uint32_t idle_peer_probes_confirmed;
  uint32_t idle_peer_probe_timeouts;
  uint32_t last_timeout_oldest_age_ms;
  uint32_t last_reset_frames_abandoned;
  uint32_t last_confirmation_oldest_age_ms;
  uint32_t maximum_confirmation_oldest_age_ms;
  bool barrier_outstanding;
  bool restart_latched;
  bool initialized;
};

enum iterate_kit_status
iterate_kit_pcm_peer_delivery_guard_init(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    const struct
        iterate_kit_pcm_peer_delivery_guard_options *options);

/**
 * Starts a new connection generation and observably abandons any unconfirmed
 * frames from the old generation. The connection owner separately resets the
 * WebSocket transmitter as part of replacing the socket.
 *
 * `connection_generation` is part of the replay defense and must never be
 * reused for another socket during one process lifetime. The ESP-IDF owner
 * increments it monotonically and refuses to connect at UINT32_MAX rather than
 * wrapping into an old pong namespace. Calling reset twice is allowed; an empty
 * housekeeping reset preserves the last non-empty abandonment incident.
 */
void iterate_kit_pcm_peer_delivery_guard_reset(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    uint32_t connection_generation);

/**
 * Records one complete PCM application frame accepted by the local transport.
 *
 * `capture_completed_at_ms` is the monotonic microphone-completion time, not
 * the later socket-write time, and must not move backwards within a generation.
 * The connection owner calls this only after its sender reports COMPLETE;
 * partial byte progress is not an ordered application frame at the peer.
 *
 * OK means the frame joined the bounded confirmation window. BACKPRESSURE means
 * the hard window was already full and the caller must not treat this frame as
 * admitted. STATE_ERROR means time moved backwards or RESTART had already
 * latched; it is a local ownership/invariant defect, not expected network
 * backpressure. The call neither allocates nor blocks.
 */
enum iterate_kit_status
iterate_kit_pcm_peer_delivery_guard_record_accept(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    uint64_t capture_completed_at_ms);

/**
 * Applies the freshness policy at `now_ms`.
 *
 * Call this before every attempted PCM send and while the uplink is idle. The
 * idle call is load-bearing: without it, releasing push-to-talk after a short
 * utterance could leave its final locally-buffered frames unconfirmed forever.
 */
enum iterate_kit_pcm_peer_delivery_poll_result
iterate_kit_pcm_peer_delivery_guard_poll(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    uint64_t now_ms);

/**
 * Confirms only a byte-identical pong for the outstanding generation/barrier.
 * The connection generation prevents a late pong from an old socket from
 * releasing the current window. Unsolicited or stale pongs are expected
 * protocol noise: they are counted and return UNAVAILABLE without becoming a
 * generic transport failure. The same applies to a matching pong received
 * after RESTART latched: elapsed freshness cannot be undone by late evidence.
 */
enum iterate_kit_status
iterate_kit_pcm_peer_delivery_guard_receive_pong(
    struct iterate_kit_pcm_peer_delivery_guard *guard,
    const void *payload,
    size_t payload_size,
    uint64_t now_ms);

void iterate_kit_pcm_peer_delivery_guard_metrics(
    const struct iterate_kit_pcm_peer_delivery_guard *guard,
    struct iterate_kit_pcm_peer_delivery_guard_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
