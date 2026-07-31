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
};

enum iterate_kit_voicelab_state {
  ITERATE_KIT_VOICELAB_IDLE = 0,
  ITERATE_KIT_VOICELAB_AUTHENTICATING,
  ITERATE_KIT_VOICELAB_GETTING_PROJECT,
  ITERATE_KIT_VOICELAB_GETTING_STREAM,
  ITERATE_KIT_VOICELAB_READY,
  ITERATE_KIT_VOICELAB_FAILED,
  ITERATE_KIT_VOICELAB_CLOSED,
};

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
  bool has_session_capability;
  bool has_project_capability;
  bool has_stream_capability;
  uint32_t frames_sent;
  uint32_t frame_send_failures;
  bool ping_pending;
  uint64_t ping_started_ms;
  uint32_t ping_count;
  uint32_t ping_failures;
  uint32_t last_rtt_ms;
  char args_buffer[ITERATE_KIT_VOICELAB_ARGS_CAPACITY];
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
