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
  /** The middle rung: the active call's direct conversation stream is ready. */
  bool stream_ready;
  /** The mounted project connection, plus the direct stream while a call is live. */
  bool link_ready;
  bool call_active;
  /**
   * INTENT, which the loop owns and the board only renders — not stored
   * behind a panel driver and read back through a mutex.
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
  /** Loudest sample admitted to the codec most recently, or zero when stale. */
  uint32_t speaker_peak;
  /** Unrecoverable start-up fault. Nothing clears it; the only exit is a reboot. */
  bool fault;
  /**
   * A session the wake word starts gets a spoken answer from the loop ("Hello!",
   * or why it cannot talk), so the board plays no wake chime for it.
   */
  bool voice_answers_wake_word;
  /** The same for a button press: true while the board is not connected. */
  bool voice_answers_press;
};

/**
 * Map one voice view to the conversation lights; both pointers must be valid.
 * A wanted but inactive call reads as not-ready so the press is acknowledged
 * immediately as connecting. Peaks come from the capture and accepted
 * playout frames; listening is independent of the screen so capture remains
 * visible while the device speaks.
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
  /** With `start_call`: the wake word, not a hand, started it. */
  bool wake_word;
};

/** Which fact about the current answer this note carries. */
enum iterate_kit_voice_answer_note_kind {
  /** Samples the playout accepted into the speaker queue. */
  ITERATE_KIT_VOICE_ANSWER_ADMITTED,
  /** Everything queued is gone; forget what nobody will hear. */
  ITERATE_KIT_VOICE_ANSWER_ABANDONED,
};

/**
 * The answer's timeline, as the playout saw it, in the order it happened.
 *
 * A face uses ABANDONED to drop the audio its mouth delay line still holds
 * (waveshare_device.c). No board reads ADMITTED today; it is the hook
 * tests/voice_loop_answer_clock_test.c asserts the answer timeline through:
 * a new answer that fails to start shows as frames admitted under the previous
 * answer's number.
 */
struct iterate_kit_voice_answer_note {
  enum iterate_kit_voice_answer_note_kind kind;
  /** Which answer, so a note that outlived its audio can be refused. */
  uint32_t answer;
  /** ADMITTED only. */
  size_t sample_count;
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

/** The two audio interfaces a board hands the loop once it has powered them. */
struct iterate_kit_board_audio {
  struct iterate_kit_audio_codec codec;
  struct iterate_kit_audio_processor processor;
};

/**
 * The board, as the loop needs to call it.
 *
 * Everything except `start` and `present` is optional; a NULL op is a board
 * saying it has no such hardware, and the loop skips it. That is why there is no
 * separate "has a face" flag: providing the op IS the claim,
 * and a flag that could disagree with the pointer beside it is a bug waiting to
 * be written.
 */
struct iterate_kit_board_ops {
  /**
   * Power the board and hand back its audio interfaces.
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
  /**
   * Play 16 kHz mono PCM16 now, replacing any clip already playing. The loop
   * keeps the samples allocated and unchanged until well after they have
   * played. NULL: the board has no clip player, and never speaks its status.
   */
  void (*play_clip)(void *context, const int16_t *pcm, size_t samples);
};

/**
 * Constants, not code: a board that needs a different NUMBER does not need a
 * different program.
 */
struct iterate_kit_board_facts {
  /** Stable board identity; the loop derives its stream and client paths. */
  const char *device_name;
  /**
   * The board's speaker, as the portable capability already describes one.
   *
   * A whole driver rather than two ops plus a ceiling, because that struct is
   * the existing interface and re-wrapping it in the loop would have been a third
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
   * because the codec interface describes rates and channels, not scheduling: two
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
  /**
   * The loudest sample of this board's own "call ended" clip, which carries its
   * speaker's gain. The board's spoken status is scaled to match; 0 uses the
   * clip's unscaled peak.
   */
  uint16_t clip_peak;
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
void iterate_kit_voice_loop_step(void);
void iterate_kit_voice_loop_capture_step(void);
void iterate_kit_voice_loop_playback_step(void);

#ifdef __cplusplus
}
#endif

#endif
