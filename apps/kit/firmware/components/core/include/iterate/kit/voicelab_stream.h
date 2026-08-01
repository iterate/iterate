#ifndef ITERATE_KIT_VOICELAB_STREAM_H
#define ITERATE_KIT_VOICELAB_STREAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * One 20 ms 16 kHz mono PCM16 frame (640 bytes) base64-encodes to 854
   * characters unpadded; the whole single-event append argument array stays
   * under ~1.1 KiB, inside one 2 KiB control outbox slot.
   */
  ITERATE_KIT_VOICELAB_FRAME_BYTES = 640,
  ITERATE_KIT_VOICELAB_ARGS_CAPACITY = 1536,
  /* Base64 scratch for one inbound speaker frame (854 chars + padding slack). */
  ITERATE_KIT_VOICELAB_B64_CAPACITY = 1200,
  /*
   * Recycle the live connection before the platform's ~1000-push
   * per-connection delivery budget goes silent (measured; see
   * apps/os/docs/stream-event-connections-and-subscriptions.md).
   */
  ITERATE_KIT_VOICELAB_RECYCLE_AFTER_BATCHES = 600,
};

enum iterate_kit_voicelab_state {
  ITERATE_KIT_VOICELAB_IDLE = 0,
  ITERATE_KIT_VOICELAB_AUTHENTICATING,
  ITERATE_KIT_VOICELAB_GETTING_PROJECT,
  ITERATE_KIT_VOICELAB_GETTING_STREAM,
  ITERATE_KIT_VOICELAB_OPENING_CONNECTION,
  ITERATE_KIT_VOICELAB_READY,
  ITERATE_KIT_VOICELAB_FAILED,
  ITERATE_KIT_VOICELAB_CLOSED,
};

/** Downlink control moments the device reacts to. */
enum iterate_kit_voicelab_control {
  /** Barge-in: the user is speaking — flush local playback immediately. */
  ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED = 0,
  ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE,
};

/** One decoded speaker PCM frame (16 kHz mono S16LE) from the stream. */
typedef void (*iterate_kit_voicelab_speaker_fn)(
    void *context,
    const uint8_t *pcm,
    size_t pcm_length,
    int64_t sequence);

typedef void (*iterate_kit_voicelab_control_fn)(
    void *context, enum iterate_kit_voicelab_control control);

enum iterate_kit_voicelab_failure {
  ITERATE_KIT_VOICELAB_FAILURE_NONE = 0,
  ITERATE_KIT_VOICELAB_FAILURE_INVALID_OPTIONS,
  ITERATE_KIT_VOICELAB_FAILURE_AUTH_CALL,
  ITERATE_KIT_VOICELAB_FAILURE_AUTH_REJECTED,
  ITERATE_KIT_VOICELAB_FAILURE_AUTH_RESULT,
  ITERATE_KIT_VOICELAB_FAILURE_PROJECT_CALL,
  ITERATE_KIT_VOICELAB_FAILURE_PROJECT_REJECTED,
  ITERATE_KIT_VOICELAB_FAILURE_PROJECT_RESULT,
  ITERATE_KIT_VOICELAB_FAILURE_STREAM_CALL,
  ITERATE_KIT_VOICELAB_FAILURE_STREAM_REJECTED,
  ITERATE_KIT_VOICELAB_FAILURE_STREAM_RESULT,
  ITERATE_KIT_VOICELAB_FAILURE_OPEN_CALL,
  ITERATE_KIT_VOICELAB_FAILURE_OPEN_REJECTED,
  ITERATE_KIT_VOICELAB_FAILURE_OPEN_RESULT,
  ITERATE_KIT_VOICELAB_FAILURE_EXPORT,
  ITERATE_KIT_VOICELAB_FAILURE_RELEASE,
  ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED,
};

struct iterate_kit_voicelab_options {
  struct capnweb_session *session;
  const char *project_id;
  const char *project_api_key;
  /** Stream path for the call, e.g. "/voicelab/dev-waveshare". */
  const char *stream_path;
  /** Short call identity stamped into every frame payload. */
  const char *call_id;
  /** Monotonic clock in milliseconds; drives ping RTT measurement. */
  uint64_t (*now_ms)(void *clock_context);
  void *clock_context;
  /**
   * Downlink: when set, the mount also opens a live connection on the
   * stream (spk-frame + grok-event, capped to what one inbox slot holds)
   * and delivers decoded speaker PCM here. NULL = uplink-only probe.
   */
  iterate_kit_voicelab_speaker_fn on_speaker;
  iterate_kit_voicelab_control_fn on_control;
  void *downlink_context;
};

/**
 * The device end of the voicelab stream protocol over ONE Cap'n Web session:
 * authenticate(project-secret) -> projects.get -> streams.get(path), then
 * high-frequency one-way `append` calls carrying ephemeral
 * `voicelab/mic-frame` events (base64 PCM16), with a low-rate pulled
 * `voicelab/ping` append as the RTT/health probe (one-way appends never
 * report peer-side errors by design).
 *
 * Single-owner, callback-driven, no internal retry — the enclosing
 * connection owns reconnect policy, mirroring iterate_kit_itx_mount.
 */
struct iterate_kit_voicelab {
  struct iterate_kit_voicelab_options options;
  enum iterate_kit_voicelab_state state;
  enum iterate_kit_voicelab_failure failure;
  enum capnweb_status capnweb_status;
  struct capnweb_remote_capability session_capability;
  struct capnweb_remote_capability project_capability;
  struct capnweb_remote_capability stream_capability;
  struct capnweb_remote_capability connection_capability;
  /* Make-before-break: the outgoing connection lives until its successor opens. */
  struct capnweb_remote_capability previous_connection_capability;
  struct capnweb_local_capability callback_capability;
  bool has_session_capability;
  bool has_project_capability;
  bool has_stream_capability;
  bool has_connection_capability;
  bool has_previous_connection_capability;
  bool has_callback_capability;
  uint32_t frames_sent;
  uint32_t frame_send_failures;
  bool ping_pending;
  uint64_t ping_started_ms;
  uint32_t ping_count;
  uint32_t ping_failures;
  uint32_t last_rtt_ms;
  /* Downlink accounting (single-owner: dispatch runs on the session task). */
  uint32_t connection_generation;
  uint32_t batches_on_connection;
  uint32_t spk_frames_received;
  uint32_t spk_decode_failures;
  uint32_t spk_seq_gaps;
  int64_t last_spk_sequence;
  int64_t last_event_offset;
  char args_buffer[ITERATE_KIT_VOICELAB_ARGS_CAPACITY];
  char b64_buffer[ITERATE_KIT_VOICELAB_B64_CAPACITY];
  uint8_t pcm_buffer[ITERATE_KIT_VOICELAB_FRAME_BYTES];
};

enum capnweb_status iterate_kit_voicelab_start(
    struct iterate_kit_voicelab *voicelab,
    const struct iterate_kit_voicelab_options *options);

/**
 * One-way append of one ephemeral voicelab/mic-frame event. `pcm` is raw
 * PCM16 bytes (at most ITERATE_KIT_VOICELAB_FRAME_BYTES). Returns
 * CAPNWEB_E_STATE while the module is not READY; transport-full statuses
 * are counted in frame_send_failures and returned for the caller's pacing.
 */
enum capnweb_status iterate_kit_voicelab_append_frame(
    struct iterate_kit_voicelab *voicelab,
    const uint8_t *pcm,
    size_t pcm_length,
    uint32_t sequence,
    uint64_t captured_at_ms);

/**
 * One-way append of a caller-built JSON array of stream event inputs
 * (diagnostics/stats events). The caller owns JSON validity.
 */
enum capnweb_status iterate_kit_voicelab_append_raw(
    struct iterate_kit_voicelab *voicelab,
    const char *events_json_array,
    size_t length);

/**
 * Pulled append of a tiny durable voicelab/ping event. The resolution echo
 * is small (no PCM), so it is safe inside the bounded inbox and token
 * budget; completion updates last_rtt_ms. One probe in flight at a time.
 */
enum capnweb_status iterate_kit_voicelab_ping(
    struct iterate_kit_voicelab *voicelab);

/**
 * True when the live connection has taken enough delivery batches that the
 * platform's per-connection push budget is near. The owner should call
 * iterate_kit_voicelab_recycle_connection() from its poll loop (never from
 * inside a callback it wants to keep re-entrancy-free).
 */
bool iterate_kit_voicelab_needs_recycle(
    const struct iterate_kit_voicelab *voicelab);

/** Open the successor connection; the old one is released on success. */
enum capnweb_status iterate_kit_voicelab_recycle_connection(
    struct iterate_kit_voicelab *voicelab);

enum capnweb_status iterate_kit_voicelab_close(
    struct iterate_kit_voicelab *voicelab);

const char *iterate_kit_voicelab_state_name(
    enum iterate_kit_voicelab_state state);
const char *iterate_kit_voicelab_failure_name(
    enum iterate_kit_voicelab_failure failure);

#ifdef __cplusplus
}
#endif

#endif
