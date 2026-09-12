#ifndef ITERATE_KIT_VOICELAB_STREAM_H
#define ITERATE_KIT_VOICELAB_STREAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"
#include "iterate/kit/voice_device_profile.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /** One 20 ms, 16 kHz mono PCM16 microphone frame. */
  ITERATE_KIT_VOICELAB_FRAME_BYTES = 640,
  /*
   * A flush encodes one contiguous PCM body. This limit must fit its base64
   * payload and envelope in one control outbox slot.
   */
  ITERATE_KIT_VOICELAB_MAX_FRAMES_PER_APPEND =
      ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND,
  /** JSON argument buffer for one maximum microphone flush. */
  ITERATE_KIT_VOICELAB_ARGS_CAPACITY = 7600,
  /** Largest accepted decoded speaker chunk. */
  ITERATE_KIT_VOICELAB_CHUNK_BYTES = 4800,
  ITERATE_KIT_VOICELAB_B64_CAPACITY = 6912,
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
  /**
   * Barge-in: flush local playback immediately.
   *
   * Raised from `drop` on the first frame of a replacing answer, so it arrives
   * IN ORDER with the audio it invalidates. It used to be a `speech_started`
   * on a second event type, where nothing decided which lane won.
   */
  ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED = 0,
  /**
   * The sender has no more audio for this answer.
   *
   * Raised from `last` on the final frame, AFTER that frame is delivered. It
   * used to be a `response.done` that routinely overtook the audio it was
   * about; the note in handle_spk_frame records what treating that as "the
   * answer is over" cost.
   */
  ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE,
  /** The bridge hung up (locally, after its idle timeout, or remotely). */
  ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED,
  /** The bridge's GPT-Live session is live; the call is usable. */
  ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED,
};

/**
 * One decoded speaker PCM frame (16 kHz mono S16LE) with the identity it
 * carried on the wire.
 *
 * `identity` is the frame's OWN account of which call, which answer and which
 * position within that answer — never the receiver's belief about those. That
 * distinction is the entire point and it has already been got wrong: both
 * targets filled `answer` in from their own state before classifying, which
 * makes "is this a newer answer?" ask whether a number equals itself. The
 * REPLACE path became unreachable, so a barge-in never flushed the queue and
 * the assistant talked over the person for the rest of the answer.
 *
 * It is passed by pointer and borrowed for the duration of the call.
 */
typedef void (*iterate_kit_voicelab_speaker_fn)(
    void *context, const uint8_t *pcm, size_t pcm_length);

typedef void (*iterate_kit_voicelab_control_fn)(
    void *context, enum iterate_kit_voicelab_control control);

/**
 * Every downlink event, by type, as it arrives — the observability seam.
 *
 * The typed callbacks above say what the device should DO. This says what
 * actually came down the wire, which is a different question and the one you
 * need when the answer is "nothing happened". `type` is borrowed and not
 * NUL-terminated; `length` bounds it.
 */
typedef void (*iterate_kit_voicelab_seen_fn)(
    void *context, const char *type, size_t length);

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

/**
 * The mouth, as the processor's own reduced state describes it.
 *
 * `offset_samples` positions the shape inside `answer`, in 16 kHz samples from
 * that answer's first — the same coordinates the deleted `viseme` EVENT used,
 * so the avatar's queue takes it unchanged. `viseme` is the 0-14 firmware id
 * and 14 is silence.
 */
typedef void (*iterate_kit_voicelab_face_fn)(
    void *context,
    uint32_t answer,
    uint32_t offset_samples,
    uint8_t viseme,
    uint8_t confidence);

struct iterate_kit_voicelab_options {
  struct capnweb_session *session;
  const char *project_id;
  const char *project_api_key;
  /** Stream path for the call, e.g. "/agents/voice/v23/waveshare". */
  const char *stream_path;
  /** Device client path, e.g. "/clients/stackchan"; NULL disables presence. */
  /** Client-owned, RAM-only activation for the local microphone edge. */
  const char *activation;
  /** Monotonic clock in milliseconds; stamps every frame and every deadline. */
  uint64_t (*now_ms)(void *clock_context);
  void *clock_context;
  /**
   * Downlink: when set, the mount also opens a live connection on the
   * stream (spk-frame, capped to what one inbox slot holds) and delivers
   * decoded speaker PCM here. NULL = uplink-only probe.
   */
  iterate_kit_voicelab_speaker_fn on_speaker;
  iterate_kit_voicelab_control_fn on_control;
  /** Optional: every event type seen on the downlink, for logging. */
  iterate_kit_voicelab_seen_fn on_event_seen;
  /** Optional: the mouth, when the poll below finds it has moved. */
  iterate_kit_voicelab_face_fn on_face;
  void *downlink_context;
};

/**
 * The device end of the voicelab stream protocol over ONE Cap'n Web session:
 * authenticate(project-secret) -> projects.get -> streams.get(path), then
 * one-way `append` calls carrying ephemeral
 * `events.iterate.com/voice-agent/mic-frame` events (base64 PCM16, one event
 * per wall-clock flush, any even byte length).
 *
 * Send microphone frames while a call is open; the first frame opens it and
 * GPT-Live detects turns. Send a quiet-call keepalive, play speaker frames in
 * order, and clear playout when directed. A local end appends
 * `conversation-ended` for that activation.
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
  /* Last successful microphone or presence append on this device clock. */
  uint64_t last_presence_at_ms;
  bool call_active;
  /** One face poll in flight at a time; see iterate_kit_voicelab_poll_face. */
  bool face_poll_pending;
  uint32_t face_polls;
  uint32_t face_updates;
  /** Last forwarded face timestamp; unchanged poll results are ignored. */
  uint64_t last_face_at_ms;
  /** Last bridge event time for health telemetry; it is not a call deadline. */
  uint64_t last_bridge_ms;
  /** Last delivery batch time; the voice loop uses it for downlink recovery. */
  uint64_t last_batch_ms;
  /* Downlink accounting (single-owner: dispatch runs on the session task). */
  uint32_t connection_generation;
  /** A failure-driven connection recycle is already in flight. */
  bool recycle_pending;
  /** A speaker answer has started and has not yet delivered its last frame. */
  bool answer_open;
  /** Bridge that accepted the live call; filters stale terminal events. */
  char live_bridge_id[24];
  /** Accepted conversation ID; filters terminals from a previous call. */
  char live_conversation_id[64];
  uint32_t batches_on_connection;
  uint32_t spk_frames_received;
  uint32_t spk_decode_failures;
  int64_t last_event_offset;
  char args_buffer[ITERATE_KIT_VOICELAB_ARGS_CAPACITY];
  char b64_buffer[ITERATE_KIT_VOICELAB_B64_CAPACITY];
  /*
   * One inbound chunk of mu-law, decoded once and then handed out a frame at
   * a time. Bounded and static: the decode never allocates, and a chunk larger
   * than this is refused at the door rather than overrunning anything.
   */
  uint8_t chunk_buffer[ITERATE_KIT_VOICELAB_CHUNK_BYTES];
};

enum capnweb_status iterate_kit_voicelab_start(
    struct iterate_kit_voicelab *voicelab,
    const struct iterate_kit_voicelab_options *options);

/**
 * One-way append of up to MAX_FRAMES_PER_APPEND consecutive mic frames as
 * one atomic multi-event append — divides the outbound message rate (each
 * push costs an outbox slot and a TLS write, and outbox exhaustion is
 * session-fatal in this peer). Sequences run from `sequence` upward.
 *
 * `pcm` is ONE contiguous run of `frame_count * frame_length` bytes: the
 * frames of a flush are one continuous stretch of capture, so the body is one
 * base64 encode with no seams for a group to straddle. A caller whose queue
 * wraps stages the run itself.
 */
enum capnweb_status iterate_kit_voicelab_append_frames(
    struct iterate_kit_voicelab *voicelab,
    const uint8_t *pcm,
    size_t frame_count,
    size_t frame_length,
    const char *activation);

/**
 * One-way append of a caller-built JSON array of stream event inputs
 * (diagnostics/stats events). The caller owns JSON validity.
 */
enum capnweb_status iterate_kit_voicelab_append_raw(
    struct iterate_kit_voicelab *voicelab,
    const char *events_json_array,
    size_t length);

/**
 * Hang up: a durable events.iterate.com/voice-agent/conversation-ended event
 * carrying this call's id, which is what the bridge watches for. One-way —
 * the bridge's conversation-ended echo confirms it. `reason` must be a safe
 * JSON string; NULL becomes `hangup`.
 */
enum capnweb_status iterate_kit_voicelab_end_call(
    struct iterate_kit_voicelab *voicelab, const char *reason);

/**
 * Append an authoritative terminal event for `activation`.
 *
 * This is used when a local activation ends before the stream has accepted it;
 * it does not alter a later activation's local call state.
 */
enum capnweb_status iterate_kit_voicelab_end_activation(
    struct iterate_kit_voicelab *voicelab,
    const char *activation,
    const char *reason);


/**
 * Send one keepalive only for a quiet accepted call. Successful microphone
 * appends share the same presence stamp, so callers may poll this every pass
 * without adding traffic while speech is flowing.
 */
enum capnweb_status iterate_kit_voicelab_keepalive_if_due(
    struct iterate_kit_voicelab *voicelab);

/**
 * Whether downlink silence means anything right now. GPT-Live's facet drops
 * idle silence, so an accepted call with nothing owed is QUIET BY DESIGN —
 * a person thinking, the model listening — and a deadline that fired on it
 * recycled the connection every ten seconds of ordinary conversation (a TLS
 * round trip on the task that decodes speaker PCM, measured 2026-09-11 as
 * 18 recycles in a six-minute call). Traffic is expected only while a wanted
 * call has not been accepted yet, or an answer has begun and not ended.
 */
bool iterate_kit_voicelab_downlink_expected(
    const struct iterate_kit_voicelab *voicelab);

/** Open the successor connection; the old one is released on success. */
/**
 * Ask the voice-agent processor what its face is doing, once.
 * The caller polls only while queued speaker audio can animate an avatar.
 * At most one poll is in flight; a second returns CAPNWEB_E_STATE.
 */
enum capnweb_status iterate_kit_voicelab_poll_face(
    struct iterate_kit_voicelab *voicelab);

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
