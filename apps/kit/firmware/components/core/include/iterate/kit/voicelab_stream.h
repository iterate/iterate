#ifndef ITERATE_KIT_VOICELAB_STREAM_H
#define ITERATE_KIT_VOICELAB_STREAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"
#include "iterate/kit/audio_playout.h"
#include "iterate/kit/voice_device_profile.h"

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
  /*
   * The taskless control socket sustains ~25-50 TLS messages/s on-device and
   * every one-way append costs TWO of them (push + release), so at 4 frames
   * per append the uplink sat right on the ceiling: a measured 3s turn put
   * 43520 bytes on the wire where realtime is 96000, because a batch is
   * skipped whenever the outbox is short. 8 frames (160 ms) per append is
   * 6.25 appends/s = 12.5 messages/s, half the ceiling. The args buffer
   * holds that eight-event array; with the push envelope it must stay inside
   * one 8 KiB transport message.
   */
  /*
   * 12, at mu-law. Twice the audio per append and half the bytes per sample,
   * so the message rate falls fourfold against PCM16 at 6 — which is what the
   * uplink could not sustain: it stalled the TCP flow outright.
   */
  ITERATE_KIT_VOICELAB_MAX_FRAMES_PER_APPEND =
      ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND,
  /*
   * Each frame costs at most ~980 characters here: ~125 of JSON envelope
   * (type, conversationId, a 10-digit sequence, a 20-digit timestamp) plus 854 of
   * base64. Eight frames needed ~7.8 KiB against a 7600-byte buffer, so
   * base64_encode ran out of room and the whole append was abandoned — with
   * the microphone silently disconnected, because that path returns before
   * the failure counter. Six frames (120 ms) is 5.9 KiB, with real margin.
   */
  ITERATE_KIT_VOICELAB_ARGS_CAPACITY = 7600,
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
  /** The bridge hung up (our own hangup, its idle timeout, or Grok's close). */
  ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED,
  /** The bridge's provider session is live; the call is usable. */
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
    void *context,
    const uint8_t *pcm,
    size_t pcm_length,
    const struct iterate_kit_playout_frame *identity);

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

struct iterate_kit_voicelab_options {
  struct capnweb_session *session;
  const char *project_id;
  const char *project_api_key;
  /** Stream path for the call, e.g. "/voice-agent/dev-waveshare". */
  const char *stream_path;
  /**
   * THE OTHER PATH: this device's client scope, e.g. "/clients/stackchan".
   *
   * A board holds two paths that are deliberately not the same. The client
   * path is the DEVICE — one per board, permanent, and where `projects.connect`
   * mounts its capabilities and journals whether it is on the network. The
   * stream path is one CONVERSATION, minted per call and disposable.
   *
   * It rides the call request because the conversation cannot otherwise learn
   * which board is on it, and therefore cannot subscribe to the one fact that
   * says the board went away. Optional: a caller with no client scope simply
   * gets no presence copies.
   */
  const char *client_path;
  /** Short call identity stamped into every frame payload. */
  const char *conversation_id;
  /**
   * Who segments turns, as the worker's voice-agent understands it:
   * "manual" (NULL defaults here) for push-to-talk boards that commit
   * turns themselves, "vad" for open-microphone boards whose provider
   * server VAD does the segmenting. A board with no turn machine that
   * requests manual turns gets a provider that never listens.
   */
  const char *turns;
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
  void *downlink_context;
};

/**
 * The device end of the voicelab stream protocol over ONE Cap'n Web session:
 * authenticate(project-secret) -> projects.get -> streams.get(path), then
 * high-frequency one-way `append` calls carrying ephemeral
 * `events.iterate.com/voice-agent/mic-frame` events (base64 PCM16).
 *
 * There WAS a low-rate pulled `voice-agent/ping` append here as an RTT and
 * health probe, answered by a `voice-agent/pong` the bridge appended back. It
 * is gone. A WebSocket already carries its own PING/PONG and the transport
 * already answers it (see websocket_tx.h), and the platform exposes a real
 * connection-layer probe that returns t0/t1/t2 — so this was a third liveness
 * mechanism, one level above the two that measure the thing honestly, and it
 * cost two event types on a lane we are reducing to almost nothing. Every
 * device woke a processor twelve times a minute to be told it was awake.
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
  /* Call control: startCall is in flight / the bridge answered / it hung up. */
  bool call_pending;
  bool call_active;
  uint32_t call_starts;
  uint32_t call_failures;
  /*
   * When the BRIDGE was last heard from, by its own events — not by ours
   * being accepted. A detached call lives in a Durable Object this device
   * cannot see: it can be evicted, redeployed, or simply stop, and none of
   * those append the conversation-ended this device waits for.
   *
   * TELEMETRY NOW, NOT A DEADLINE. It used to arm a 20-second watchdog that
   * dropped the call, and that was only sound while the pong existed: the pong
   * was the one bridge-sourced event that arrived during a SILENT call, and
   * silence is exactly when a dead bridge is indistinguishable from a patient
   * one. With the pong deleted the watchdog would have fired on any twenty
   * seconds of nobody speaking, so it went with it. What remains is the age
   * itself, reported as `bridgeAgeMs`, which is the evidence a person needs
   * without being a rule the device acts on alone.
   */
  uint64_t last_bridge_ms;
  /*
   * When a BATCH last arrived on this connection — any batch, empty or not,
   * stamped before anything in it is looked at.
   *
   * This is now the device's ONLY application-level proof that anything is
   * reaching it, and it is a separate lane from the socket: the platform holds
   * the callback capability in the stream's Durable Object, and that
   * registration can be lost — eviction, redeploy, a connection closed at the far end — without
   * the socket closing, without an error, and without this device being told
   * anything at all.
   *
   * Measured: 68 seconds in which the bridge appended eight conversation-accepted
   * events and eleven more besides, every one of them visible to another
   * subscriber, while this device's batch counter sat frozen at 77 and it
   * cheerfully started a ninth call. That is the "stuck on starting call"
   * and the answer that stops after half a sentence: not a stall, a lane
   * that has quietly stopped existing.
   *
   * So the downlink gets a deadline too, and its recovery is the recycle
   * that already exists.
   */
  uint64_t last_batch_ms;
  /* Downlink accounting (single-owner: dispatch runs on the session task). */
  uint32_t connection_generation;
  /*
   * A recycle is asynchronous: batches_on_connection only resets when the
   * successor resolves. Without this flag needs_recycle() stayed true for
   * the whole round trip and the caller's poll loop opened a new connection
   * every iteration — 22 of them in one call, against a budget of one per
   * 600 batches.
   */
  bool recycle_pending;
  /*
   * Which bridge owns the live call. Every bridge announces conversation-ended when
   * it dies, and they all share one conversationId — so a stale bridge shutting down
   * was ending the call that a NEWER bridge was actively serving. The device
   * honours conversation-ended only from the bridge whose conversation-accepted it last saw.
   */
  char live_bridge_id[24];
  uint32_t batches_on_connection;
  uint32_t spk_frames_received;
  uint32_t spk_decode_failures;
  uint32_t spk_seq_gaps;
  int64_t last_spk_sequence;
  int64_t last_event_offset;
  char args_buffer[ITERATE_KIT_VOICELAB_ARGS_CAPACITY];
  char b64_buffer[ITERATE_KIT_VOICELAB_B64_CAPACITY];
  uint8_t pcm_buffer[ITERATE_KIT_VOICELAB_FRAME_BYTES];
  /* One frame of mu-law, half the size of the PCM16 it came from. */
  uint8_t mulaw_buffer[ITERATE_KIT_VOICELAB_FRAME_BYTES / 2U];
};

enum capnweb_status iterate_kit_voicelab_start(
    struct iterate_kit_voicelab *voicelab,
    const struct iterate_kit_voicelab_options *options);

/**
 * One-way append of up to MAX_FRAMES_PER_APPEND consecutive mic frames as
 * one atomic multi-event append — divides the outbound message rate (each
 * push costs an outbox slot and a TLS write, and outbox exhaustion is
 * session-fatal in this peer). Sequences run from `sequence` upward.
 */
enum capnweb_status iterate_kit_voicelab_append_frames(
    struct iterate_kit_voicelab *voicelab,
    const uint8_t *const *frames,
    size_t frame_count,
    size_t frame_length,
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
 * Append a durable events.iterate.com/voice-agent/conversation-requested event
 * to this stream. The installed voice-agent guest processor opens the Grok
 * call; the project worker is not
 * involved. Nothing outside the platform holds the call open afterwards: no
 * laptop bridge, no second socket. One start in flight at a time;
 * `call_active` turns true when conversation-accepted arrives on the stream.
 * `greeting` may be NULL. Strings containing JSON control, quote, or backslash
 * characters are rejected rather than emitted as malformed events.
 */
enum capnweb_status iterate_kit_voicelab_start_call(
    struct iterate_kit_voicelab *voicelab, const char *greeting);

/**
 * Hang up: a durable events.iterate.com/voice-agent/conversation-ended event
 * carrying this call's id, which is what the bridge watches for. One-way —
 * the bridge's own conversation-ended echo
 * confirms it. `reason` follows the same restricted JSON-string contract as
 * `greeting`; NULL becomes `hangup`.
 */
enum capnweb_status iterate_kit_voicelab_end_call(
    struct iterate_kit_voicelab *voicelab, const char *reason);

/**
 * Forget a call this device can no longer prove exists, WITHOUT announcing
 * an end that would be a lie — a bridge that stopped answering may well be
 * gone already, and a conversation-ended carrying a stale bridge id is ignored by
 * design. This drops the local belief only, so the owner's "the user wants a
 * call" intent can reconcile by starting a fresh one.
 */
void iterate_kit_voicelab_forget_call(struct iterate_kit_voicelab *voicelab);

/** The two edges of one push-to-talk turn. */
enum iterate_kit_voicelab_turn {
  /** Button down: cancel any answer in flight and start listening. */
  ITERATE_KIT_VOICELAB_TURN_START = 0,
  /** Button up: commit what was said and ask for the answer. */
  ITERATE_KIT_VOICELAB_TURN_COMMIT,
};

/**
 * Mark a turn edge. With manual turn detection there is no VAD anywhere —
 * the device decides when speech starts and stops, and the bridge translates
 * these into the provider's commit/response controls. One-way: a lost edge is
 * recoverable by pressing again, and blocking the audio lane on an
 * acknowledgement would be worse.
 */
enum capnweb_status iterate_kit_voicelab_mark_turn(
    struct iterate_kit_voicelab *voicelab,
    enum iterate_kit_voicelab_turn turn);

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
