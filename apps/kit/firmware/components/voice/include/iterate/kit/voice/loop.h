#ifndef ITERATE_KIT_VOICE_LOOP_H
#define ITERATE_KIT_VOICE_LOOP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/audio_codec.h"
#include "iterate/kit/audio_processor.h"
#include "iterate/kit/capabilities/speaker.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/voice_playout.h"
#include "iterate/kit/conversation_lights.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Shared voice control, capture, playout, and health policy. Boards own
 * physical controls, codecs, speakers, and presentation. */

/** What the person should be told is happening. */
enum iterate_kit_voice_screen {
  ITERATE_KIT_VOICE_SCREEN_CONNECTING = 0,
  ITERATE_KIT_VOICE_SCREEN_IDLE,
  ITERATE_KIT_VOICE_SCREEN_LISTENING,
  ITERATE_KIT_VOICE_SCREEN_SPEAKING,
};

/**
 * Everything the board is allowed to show, as one value.
 *
 * Pushed once per app-loop pass; boards may use it as their presentation tick.
 */
struct iterate_kit_voice_view {
  enum iterate_kit_voice_screen screen;
  /**
   * The transient line: "reconnecting", "call ended", "sending". Always a
   * string literal or a `*_name()` return, never a buffer the loop owns, so a
   * board may keep the pointer. Empty is the honest steady state.
   */
  const char *status;
  /** The first rung: the Cap'n Web session to /api is up and this device is on it. */
  bool api_ready;
  /** The middle rung: a conversation stream exists and this device is on it. */
  bool stream_ready;
  /** The whole chain, which is the gate every producer in the loop sits behind. */
  bool link_ready;
  bool call_active;
  /**
   * INTENT, which the loop now owns and the board only renders.
   *
   * It used to live in the display module on three of the four boards, so the
   * one fact that decides whether this device is trying to be in a call was
   * stored behind a panel driver and read back through a mutex three times a
   * pass.
   */
  bool wants_call;
  /** The local microphone gate is open. */
  bool listening;
  /**
   * Loudest sample in the last captured frame.
   *
   * Without it a board with no screen looks identical whether it is listening
   * or deaf — which is exactly how one was reported. One pass over a 20 ms
   * frame on the task that already owns the samples, so it costs nothing and
   * every board gets the meter.
   */
  uint32_t microphone_peak;
  /** Unrecoverable start-up fault. Nothing clears it; the only exit is a reboot. */
  bool fault;
};

/**
 * Map one voice view to the conversation lights; both pointers must be valid.
 * A wanted but inactive call reads as not-ready so the press is acknowledged
 * immediately by the amber comet. Speaking is the loop's screen cue (4096),
 * one frame early without a physical playout tap; only brightness depends on it.
 * Listening follows the screen, and the microphone peak comes from the view.
 */
void iterate_kit_voice_view_lights(
    const struct iterate_kit_voice_view *view,
    struct iterate_kit_conversation_visual_state *out);

/**
 * What the board's physical controls are asking for: the explicit edges the
 * shared session grammar (iterate/kit/session_grammar.h) resolved this poll's
 * gestures into. Every board drives that one machine, so what arrives here is
 * already a MEANING — a raw press never reaches the loop, and a board cannot
 * answer the same gesture differently from its siblings by construction.
 */
struct iterate_kit_voice_intent {
  /** An edge: open a session. */
  bool start_call;
  /** An edge: end the session. */
  bool end_call;
  /** A level: hardware mute is engaged; capture continues for AEC only. */
  bool microphone_muted;
};

/** Which fact about the current answer this note carries. */
enum iterate_kit_voice_answer_note_kind {
  /** Samples the playout accepted into the speaker queue. */
  ITERATE_KIT_VOICE_ANSWER_ADMITTED,
  /** Everything queued is gone; forget what nobody will hear. */
  ITERATE_KIT_VOICE_ANSWER_ABANDONED,
  /**
   * A mouth shape, scheduled against a position in this answer.
   *
   * This kind was deleted with the `viseme` EVENT and is back because the fact
   * came back by another route: the face is reduced state in the processor's
   * runtime bag now, and the loop polls it while audio is playing. What it
   * carries is unchanged — the same 0-14 id at the same sample offset — which
   * is why the avatar's queue took it without modification.
   *
   * It rides `observe_answer` rather than an op of its own for the reason the
   * struct exists at all: admitted, abandoned and scheduled must reach the
   * board on the SAME task in the SAME order, or the face animates audio
   * nobody will hear.
   */
  ITERATE_KIT_VOICE_ANSWER_VISEME,
};

/**
 * The answer's timeline, for a board with a face.
 *
 * One op rather than several because the notes must arrive on the SAME task in
 * the SAME order the audio did: a face that is told what was admitted and what
 * was abandoned out of order animates audio nobody will hear.
 *
 * There was a third kind, VISEME, carrying scheduled mouth shapes off their own
 * event type. The face is reduced state published through `liveState` now, so
 * the event and this kind went together.
 */
struct iterate_kit_voice_answer_note {
  enum iterate_kit_voice_answer_note_kind kind;
  /** Which answer, so a note that outlived its audio can be refused. */
  uint32_t answer;
  /** ADMITTED only. */
  size_t sample_count;
  /** VISEME only: position within `answer`, in 16 kHz samples from its first. */
  uint32_t offset_samples;
  /** VISEME only: the 0-14 firmware id; 14 is silence. */
  uint8_t viseme;
  /** VISEME only. */
  uint8_t confidence;
};

/**
 * What the codec knows about the chunk it just handed over.
 *
 * Only one board's driver can answer any of this, and the capture bridge needs
 * all of it: a sequence that gaps when the DMA does, a capture-completion
 * timestamp that lets each egress frame be back-dated, and whether the far end
 * was audible while this chunk was recorded. A board that cannot say fills
 * nothing and the loop synthesises a monotonic timeline instead, which is what
 * the other three did implicitly by having no bridge at all.
 */
struct iterate_kit_voice_capture_meta {
  /** The capture timeline broke; the filter must restart on current audio. */
  bool epoch_reset;
  uint32_t sequence;
  uint64_t captured_through_at_us;
  bool playback_content_active;
};

/** The two audio seams a board hands the loop once it has powered them. */
struct iterate_kit_board_audio {
  struct iterate_kit_audio_codec codec;
  struct iterate_kit_audio_processor processor;
};

/**
 * The board, as the loop needs to call it.
 *
 * Everything except `start` and `present` is optional; a NULL op is a board
 * saying it has no such hardware, and the loop skips it. That is why there is no
 * separate "has a face" or "is half duplex" flag: providing the op IS the claim,
 * and a flag that could disagree with the pointer beside it is a bug waiting to
 * be written.
 */
struct iterate_kit_board_ops {
  /**
   * Power the board and hand back its audio seams.
   *
   * Ordering inside is the board's business — the Waveshare must bring the
   * panel up before the codec because both resets hang off one TCA9554.
   */
  bool (*start)(void *context, struct iterate_kit_board_audio *out);
  /** Show this, and pump whatever needs pumping. Once per app-loop pass. */
  void (*present)(void *context, const struct iterate_kit_voice_view *view);
  /** Read the physical controls. Once per app-loop pass, on the app task. */
  void (*poll)(void *context, struct iterate_kit_voice_intent *out);
  /** Follow the speaker path in hardware. Called from the app AND playback tasks. */
  void (*phase)(void *context, enum iterate_kit_voice_phase phase);
  /** What the codec knows about the chunk just read. Called from the capture task. */
  void (*capture_meta)(
      void *context, struct iterate_kit_voice_capture_meta *out);
  /**
   * The samples the DAC just accepted. Called from the PLAYBACK task.
   *
   * Separate from `observe_answer` precisely because of that: this is the only
   * place on a device where "audio that arrived" and "audio that will be heard"
   * are the same thing, and it is the only board callback on that task.
   */
  void (*observe_playout)(void *context, const int16_t *pcm, size_t samples);
  /** The answer's timeline. Called from the APP task. */
  void (*observe_answer)(
      void *context, const struct iterate_kit_voice_answer_note *note);
  /**
   * The capabilities only this board has: an AEC stage, servos, a camera, a
   * screen to fill. The loop registers its shared capabilities separately.
   */
  size_t (*modules)(
      void *context, struct iterate_kit_module *out, size_t capacity);
  /**
   * Append this board's own health fields as `,"name":value` pairs.
   *
   * Returns bytes written, or 0 if they did not fit — which the loop treats the
   * same way it treats its own overflow, because a truncated stats line is not
   * sent at all and the instrument goes dark exactly when someone added the
   * counter that explains a bug.
   */
  size_t (*health)(void *context, char *out, size_t capacity);
};

/**
 * Constants, not code.
 *
 * Everything here was a `#define` or an enum member duplicated four times. A
 * board that needs a different NUMBER does not need a different program, and the
 * four copies proved it: across the whole ~180-line constant block, exactly two
 * literals ever differed, and one of those (`DMA_RING_CREDIT_MS`) was read by
 * nobody on any board. It is deleted rather than promoted.
 */
struct iterate_kit_board_facts {
  /** Stable board identity; the loop derives its stream and client paths. */
  const char *device_name;
  /**
   * The board's speaker, as the portable capability already describes one.
   *
   * A whole driver rather than two ops plus a ceiling, because that struct is
   * the existing seam and re-wrapping it in the loop would have been a third
   * spelling of the same three facts. The ceilings really do differ: 92 on the
   * board with a measured reason, 100 on the three whose drivers clamp inside.
   */
  struct iterate_kit_speaker_driver speaker;
  /**
   * How long the playback task waits for a frame before treating the source as
   * dry. Two thirds of the board's I2S DMA ring, so a late frame is absorbed by
   * the hardware cushion rather than concealed — silence written into the ring
   * occupies playout time and can never be taken back. 60 ms against a 90 ms
   * ring, 80 against 120, 40 against 60, 25 against 40.
   */
  uint16_t speaker_dry_wait_ms;
  /**
   * Samples per pass through the audio processor. 320 everywhere except the
   * board running esp-sr's VOIP engine, which processes 16 ms frames and fails
   * closed if told otherwise. The capture bridge regroups 128 -> 256 -> 320.
   */
  uint16_t processing_frame_samples;
  /**
   * Samples the CODEC hands over per read — its DMA grain, not the wire's.
   *
   * 320 (one whole 20 ms frame) on three boards; 128 (8 ms) on the one whose
   * I2S completion is that size. It is a fact rather than a codec property
   * because the codec seam describes rates and channels, not scheduling: two
   * boards could share a driver and be reserved differently.
   *
   * The bridge reconciles this with `processing_frame_samples` and the wire's
   * 320. All three being equal is the degenerate pass-through case, which is
   * what the other three boards get.
   */
  uint16_t capture_chunk_samples;
  /**
   * The capture task's stack. 4 KiB is enough for a passthrough; the board with
   * a real AEC needs 8, because `aec_process` on a 4 KiB stack trips the canary
   * on the first frame.
   */
  uint16_t capture_stack_bytes;
};

/**
 * Bring the whole device up and run it forever.
 *
 * Does not return. On ESP-IDF this spawns the capture and playback tasks and
 * then drives `iterate_kit_voice_loop_step` from the app task.
 */
void iterate_kit_voice_loop_run(
    const struct iterate_kit_board_ops *ops,
    const struct iterate_kit_board_facts *facts,
    void *context);

/**
 * The three steps `run` is made of, exposed because a step is testable and a
 * `for(;;)` is not — and because a host with one thread instead of three can
 * call all three from one poll loop.
 */
bool iterate_kit_voice_loop_init(
    const struct iterate_kit_board_ops *ops,
    const struct iterate_kit_board_facts *facts,
    void *context);
void iterate_kit_voice_loop_step(uint64_t now_ms);
void iterate_kit_voice_loop_capture_step(void);
void iterate_kit_voice_loop_playback_step(void);

#ifdef __cplusplus
}
#endif

#endif
