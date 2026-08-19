#ifndef ITERATE_KIT_VOICE_LOOP_H
#define ITERATE_KIT_VOICE_LOOP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/audio_codec.h"
#include "iterate/kit/audio_processor.h"
#include "iterate/kit/capabilities/speaker.h"
#include "iterate/kit/peer.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * THE ONE PROGRAM EVERY ITERATE VOICE BOARD RUNS.
 *
 * Four boards shipped four copies of it. They were not merely similar: with
 * board prefixes normalised, the Waveshare and M5Stick capture tasks were
 * IDENTICAL — 46 lines, nothing differing — `on_speaker_pcm` differed by two or
 * three lines across all four, and `now_ms`, `initialise_rings`,
 * `playback_apply_reprime`, `on_session_ended`, `clock_slug`, `start_clock_once`
 * and `append_stats` were byte-equivalent once renamed. Of ~1,700 lines per
 * device file, ~110 touched a board-specific symbol.
 *
 * The cost was not the duplication. It was that every bug had to be found four
 * times, and several times was not: the missing disarm in the flush funnel, the
 * playout reset a new call needs, the liveness clock a never-ready transport
 * could hold open forever, the launch diagnostics that answer "why did that
 * press not become a call" — each was fixed on one board and left standing on
 * the rest for weeks. Two boards still carried a `park_with_fault` that
 * `return`ed instead, which with the watchdog already subscribed is a reboot
 * loop the file's own comment warns about.
 *
 * WHAT THE LOOP KEEPS, because it is policy rather than hardware: turn taking
 * (push-to-talk against server VAD), the half-duplex fence and its ordering, the
 * playout timeline, every watchdog and every retry ladder.
 *
 * WHAT THE BOARD OWNS: pixels, buttons, amplifiers, servos, cameras, and the
 * audio codec itself.
 */

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
 * This replaces eight `ui_set_*` functions that appeared 48 times in one device
 * file. They were not eight facts; they were one fact written eight ways, and
 * writing it in pieces is how a board came to read "ready" while the server was
 * refusing it every three seconds — nine sites set the UI state and any of them
 * would erase what another had just published.
 *
 * Pushed once per app-loop pass, always, whether or not anything moved: a board
 * that wants a dirty check does it under its own lock in one comparison, which
 * is cheaper than the nine lock round trips the setters used to cost. It is also
 * the board's per-pass tick — the M5Stick, HAVPE and StackChan panels are pumped
 * by their caller rather than by a timer, and this is that pump.
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
   * pass. A board with no panel had nowhere to put it, which is why the fourth
   * kept a `remote_talk` bool of its own beside it.
   */
  bool wants_call;
  bool talk_held;
  /** A turn is open: the face attends and shuts its mouth. */
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

/** What the board's physical controls are asking for. */
struct iterate_kit_voice_intent {
  /** An edge, consumed by the board on read. Two-button boards. */
  bool start_call;
  /** An edge, consumed by the board on read. Two-button boards. */
  bool end_call;
  /**
   * An edge that flips whatever the intent currently is.
   *
   * Three of the four boards have ONE control — a side button, a tap, a touch —
   * and a board with one button cannot express start and end separately. It
   * also cannot read the current intent any more, now that the loop owns it, so
   * the toggle has to be the loop's to resolve.
   */
  bool toggle_call;
  /** A level: the talk control is down right now. Push-to-talk boards. */
  bool talk_held;
};

/**
 * What the speaker path is doing, so a board can follow it in hardware.
 *
 * This replaces `dma_watch(bool)`, `dma_draining()`, `note_flush()` and
 * `amplifier(bool)` — eleven calls whose only job was to tell the driver which
 * of six situations the playback task was in. Named after the situations, the
 * six are exhaustive, and a board that ignores one is ignoring a fact rather
 * than missing a call.
 *
 * Called from BOTH the app task and the playback task, so a board's handler
 * must be safe under that — which the four drivers already were.
 */
enum iterate_kit_voice_phase {
  /**
   * Audio has ARRIVED and been admitted — not written yet.
   *
   * A class-D amplifier needs tens of milliseconds to settle, and raising it
   * two milliseconds before the first write meant the opening of every answer
   * played into an amp that was not up: heard as the first half-word clipped.
   * Raising it here spends the playout prefill as settle time, which is free.
   * Boards whose speaker rail stays up for the life of the boot ignore this.
   */
  ITERATE_KIT_VOICE_PHASE_ARRIVED,
  /** Handing the DAC a frame right now. This is the only armed state. */
  ITERATE_KIT_VOICE_PHASE_FEEDING,
  /** Deliberately not feeding: priming, dry, fenced out, or holding a stale frame. */
  ITERATE_KIT_VOICE_PHASE_WAITING,
  /** The sender declared the answer over, so a dry ring is the end, not a hole. */
  ITERATE_KIT_VOICE_PHASE_DRAINING,
  /**
   * We are about to throw queued audio away on purpose.
   *
   * MUST be announced BEFORE the audio goes, never after. Invalidating first
   * leaves a window in which the device's own intentional cut is recorded as
   * listener-visible starvation — measured on 2026-08-04, when a hang-up
   * arriving with 13,020 ms of audio still queued moved `spkStarveEvents` by one.
   */
  ITERATE_KIT_VOICE_PHASE_FLUSHED,
  /** Dry long enough that the amplifier can go down without power-cycling it. */
  ITERATE_KIT_VOICE_PHASE_QUIET,
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

/** How this board takes turns. */
enum iterate_kit_voice_turns {
  /**
   * A control is held while speaking; nothing is sent unless it is down.
   *
   * On a board with no echo cancellation this IS the echo story: the speaker is
   * never live into an open microphone, and pressing to talk cancels an answer
   * in flight instead of talking over it.
   */
  ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK,
  /**
   * The far end segments turns and the microphone rides the open call.
   *
   * Only safe behind real echo cancellation. Requesting the manual default with
   * no turn machine produces an accepted call and a deaf assistant — a provider
   * waiting forever for a commit no code sends.
   */
  ITERATE_KIT_VOICE_TURNS_SERVER_VAD,
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
   * panel up before the codec because both resets hang off one TCA9554 — but
   * whether the radio starts before or after this runs is the loop's, because
   * that is a bring-up POLICY question. See `radio_before_codec`.
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
   * Move the half-duplex fence: the microphone is asking for, or giving back,
   * pins the speaker also uses. Asynchronous — see `playout_fenced_out`.
   *
   * Providing this pair is how a board declares itself half duplex. On the one
   * board that is, the ES8311's ADC and DAC share MCLK/BCLK/WS, so capture
   * requires DELETING the playback channel; the microphone physically cannot
   * run while the speaker does.
   */
  void (*capture_fence)(void *context, bool microphone_owns_pins);
  /** True while the microphone owns the pins, or the fence is moving either way. */
  bool (*playout_fenced_out)(void *context);
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
   * screen to fill. The loop registers conversation control, push-to-talk (when
   * the board takes turns that way), the speaker and health itself, because
   * those are the same four on every board.
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
  /**
   * ONE CONVERSATION STREAM PER BOARD, not one shared by all of them.
   *
   * Every device once defaulted to "/agents/voice/device". Now that a stream
   * carries many conversations, sharing one means every board presses into the
   * same conversation and each press supersedes the last: three boards on one
   * stream produced two call-started for a single press and an answer that
   * reached nobody.
   */
  const char *stream_path;
  /**
   * THE OTHER PATH. The stream path above is one CONVERSATION and is minted
   * fresh per call; this is the DEVICE, and it never changes.
   */
  const char *client_path;
  const char *conversation_id;
  const char *greeting;
  /**
   * THE ONLY DESCRIPTION A MODEL EVER SEES.
   *
   * Not `peer_description` — the capability host flattens this mount and reports
   * `children: {}`, because sub-paths are routes the device interprets rather
   * than members the host can list. So this is what an agent discovers in
   * `itx.__describe().capabilities`. It was one 46-character line on one board,
   * which is why an agent asked for that device's metrics went hunting through
   * telemetry streams instead of calling `health()`.
   */
  const char *instructions;
  /** What this device is, for whoever holds the capability. */
  const char *peer_description;
  /**
   * How to ask for a turn, in this board's own words: "hold the upper button to
   * talk", "hold the front button to talk", "speak whenever you like". The
   * sentence is not decoration — it is the turn policy said out loud, and it was
   * wrong on a board whose header still documented a push-to-talk grammar the
   * device had stopped implementing.
   */
  const char *talk_hint;
  /** How to ask for a call: "press upper to call", "press side to call". */
  const char *call_hint;
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
  enum iterate_kit_voice_turns turns;
  /**
   * Start the radio BEFORE powering the codec.
   *
   * One board's XMOS + AIC3204 bring-up takes 6.2 s measured, and it used to run
   * to completion before Wi-Fi was even started — so two waits ran back to back
   * for no reason and that board reached a ready mount at ~14 s where the others
   * managed ~8. Nothing in the transport needs the codec; only the capture and
   * playback tasks do, and they are created after both. Everywhere else the
   * codec comes first, because the panel and the codec share reset lines.
   */
  bool radio_before_codec;
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

/**
 * Re-point the device at a different conversation stream.
 *
 * The other half of the getter above: the path IS the conversation's
 * identity, so writing it is how a board changes conversations. A mounted
 * stream is closed and remounted at the new path on the same connection;
 * before the first mount this only replaces the seed. Boards call it from
 * the app task with NO CALL WANTED — re-pointing underneath a call being
 * placed would strand the call — and health() reports the adopted path as
 * `conversation`, which is how a change is verified on a board whose console
 * port reboots it.
 */
void iterate_kit_voice_loop_set_stream_path(const char *path);

/**
 * Re-select the turn policy at runtime, overriding `facts->turns`.
 *
 * For the board whose dial chooses among streams whose far ends take turns
 * differently: posture must follow the path or the two halves of the call
 * disagree about who closes a turn. Takes effect on the next pass. It moves
 * only the per-pass policy — the microphone gate and the turn markers — not
 * the capability surface: whether pushToTalk is MOUNTED stays a compile-time
 * fact, because the peer was described once at mount.
 */
void iterate_kit_voice_loop_set_turns(enum iterate_kit_voice_turns turns);

#ifdef __cplusplus
}
#endif

#endif
