#ifndef ITERATE_KIT_BARGE_IN_H
#define ITERATE_KIT_BARGE_IN_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Whether the provider saying "somebody started speaking" should stop the
 * speaker.
 *
 * ON AN OPEN-MIC BOARD, THE PROVIDER IS NOT A RELIABLE WITNESS TO THIS. Its
 * VAD listens to what the device sends, which during an answer contains
 * whatever the echo canceller did not remove plus the room. It fires on that,
 * the device flushes the speaker, and the answer stops mid-word. Measured on
 * the HA Voice PE: six barge-ins across four short answers with nobody in the
 * room speaking, and 236 frames of a 140-frame answer thrown away.
 *
 * The device, unlike the provider, can see its OWN microphone. A barge-in
 * that arrives while that microphone has been quiet is not a barge-in, and
 * this is the one fact needed to tell the two cases apart. It is deliberately
 * not a VAD: no spectrum, no adaptation, no state beyond the last time the
 * input was loud.
 */

enum {
  /**
   * How loud the microphone must have been, in PCM16 magnitude, before a
   * barge-in is believed.
   *
   * MEASURED, on the HA Voice PE with its AEC tap selected: the echo residual
   * during playback peaks around 58, the worst residual seen through any tap
   * was about 250, and ordinary speech at conversational distance reads 800
   * and up. 300 sits above every residual measured and well under any real
   * voice. It is a floor on ENERGY only — a quiet talker still crosses it,
   * because 300 of 32767 is a whisper.
   */
  ITERATE_KIT_BARGE_IN_FLOOR = 300,
  /**
   * How recently, in milliseconds.
   *
   * A person interrupting is already speaking when the provider notices, and
   * the notice travels over a network. Half a second is generous against that
   * round trip and short enough that a barge-in cannot be authorised by
   * something said before the answer began.
   */
  ITERATE_KIT_BARGE_IN_WINDOW_MS = 600,
};

/** Caller-owned; zero-initialise. One per microphone. */
struct iterate_kit_barge_in {
  uint64_t loud_at_ms;
  bool ever_loud;
  uint32_t admitted;
  uint32_t rejected;
};

/**
 * Records how loud the microphone is. Call once per captured frame, with the
 * peak AFTER echo cancellation and BEFORE any make-up gain — amplifying the
 * residual first is exactly how it gets mistaken for a voice.
 */
void iterate_kit_barge_in_observe(
    struct iterate_kit_barge_in *gate, uint32_t peak, uint64_t now_ms);

/**
 * Forgets that anybody has spoken, so only NEW speech counts.
 *
 * Called when the speaker STARTS. The person who just finished talking is the
 * reason an answer is being played at all, and their voice must not become
 * standing permission to transmit through it: measured with a 600 ms window
 * and no reset, the tail of the prompt kept the uplink open into the first
 * moments of the reply, the provider heard the reply's own onset, and it
 * cancelled itself two words in. A real interruption re-opens the gate on its
 * own within one frame, which is the only thing that should.
 */
void iterate_kit_barge_in_forget(struct iterate_kit_barge_in *gate);

/**
 * Whether somebody is speaking into this microphone right now.
 *
 * Pure, so it can be asked once per captured frame. TWO CALLERS NEED THE SAME
 * ANSWER and it would be a bug for them to disagree: the barge-in gate below,
 * and the uplink itself — a device must not SEND its own echo to a provider
 * whose VAD will read it as an interruption and cancel the answer it is in
 * the middle of generating. Measured before this existed: every answer came
 * back two words long, marked complete by a provider that had talked itself
 * into stopping.
 */
bool iterate_kit_barge_in_person_present(
    const struct iterate_kit_barge_in *gate, uint64_t now_ms);

/**
 * Answers whether a speech_started should flush the speaker, and counts both
 * outcomes so a device that is still being interrupted can prove which kind.
 */
bool iterate_kit_barge_in_admit(
    struct iterate_kit_barge_in *gate, uint64_t now_ms);

#ifdef __cplusplus
}
#endif

#endif
