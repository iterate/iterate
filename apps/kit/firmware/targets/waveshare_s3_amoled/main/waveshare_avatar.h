#ifndef ITERATE_KIT_WAVESHARE_AVATAR_H
#define ITERATE_KIT_WAVESHARE_AVATAR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_render.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The face, on this board.
 *
 * The engine is the shared `avatar` component — the same analyzer, atlases and
 * renderer StackChan uses. This file is only the part that cannot be shared:
 * which task does what, and where the mouth's audio comes from.
 *
 * ================== THREE TASKS, AND ONLY ONE MAY ANALYSE ==================
 *
 * The shared analyzer is a single-writer seqlock, and "single writer" is not a
 * preference: `face_animator_push_pcm` accumulates a 160-sample window in plain
 * non-atomic fields and completes it on `window_fill == window_samples`, an
 * EXACT equality. Two tasks incrementing that counter lose an update sooner or
 * later, the count steps straight past the boundary, and no analysis window
 * ever completes again. The pose then never changes for the life of the boot.
 *
 * That is exactly the fault this file was rebuilt to remove. It was reported as
 * two unrelated complaints — "the mouth stops moving after a few words" and
 * "the speaker dots stay lit when nothing is speaking" — which are one frozen
 * pose seen twice: the renderer draws its mouth and the status bar draws its
 * meter from the same struct. The previous revision pushed PCM from the
 * playback task (`observe_playout`) AND from the app task (`tick`), while its
 * own comment claimed the app task "already owns speaker PCM". It does not;
 * playback_task does.
 *
 * So the tasks are now named, and the split is mechanical rather than trusted:
 *
 *   playback_task  PRODUCER  observe_playout()   writes the ring, nothing else
 *   app_main       CONSUMER  tick(), listening   the ONLY caller of the analyzer
 *   LVGL           READER    render(), level     snapshots, never writes
 *
 * There is no lock. A single-producer/single-consumer ring is what carries
 * audio across the task boundary, and the analyzer sits entirely on one side
 * of it. A future call to the analyzer from the wrong task is a bug this
 * comment can at least name, where the previous design made it look ordinary.
 */

/** Bring up the analyzer and pick the compiled face. Call once, before use. */
bool waveshare_avatar_init(void);

/**
 * PCM that has been handed to the DAC. PLAYBACK TASK ONLY.
 *
 * NOT PCM THAT ARRIVED. Speaker writes go into an I2S ring up to 90ms deep, so
 * a sample accepted here is heard some time later; animating on arrival makes
 * the mouth lead the voice by however much audio happens to be queued, which is
 * the one failure the shared engine's contract calls out by name.
 *
 * This copies into the ring and returns. It does no analysis, touches no pose
 * and takes no lock — see the header comment for why that is the whole point.
 */
void waveshare_avatar_observe_playout(const int16_t *pcm, size_t samples);

/**
 * Move the face on by however much the speaker has actually played. APP TASK
 * ONLY, on every pass.
 *
 * This is where the ring is drained and the analyzer is fed, holding back the
 * audio the hardware still owes so the mouth tracks the voice rather than
 * leading it. It also closes the mouth: once the ring is empty and the speaker
 * has been quiet it pushes silence, because the envelope only moves when it is
 * given samples and the last shape of the last word would otherwise stay on
 * the face.
 */
void waveshare_avatar_tick(void);

/**
 * The queued speaker audio was thrown away, so the face must forget it too.
 * Callable from ANY task.
 *
 * A barge-in, hang-up or turn start discards audio the DAC accepted but never
 * played. Held samples belonging to that audio must be dropped rather than
 * flushed to the analyzer: nobody heard them, so they must not move a mouth.
 *
 * Only the consumer may move the ring's read cursor, so this does not empty the
 * ring itself — it raises a flag the next `tick` acts on. Anything the producer
 * writes in that window is dropped along with it, which is correct: an abandon
 * is followed by a re-prime, so those samples are the discarded tail anyway.
 *
 * Called from the one funnel every abandon site goes through, so a new site
 * cannot forget it.
 */
void waveshare_avatar_note_abandoned(void);

/** The person is holding the talk button: attend, and keep the mouth shut. */
void waveshare_avatar_set_listening(bool listening);

/*
 * ============================ THE VISEME LANE ==============================
 *
 * During a call the mouth is driven by the worker's viseme track — explicit
 * mouth shapes computed server-side from the same PCM, scheduled against
 * positions in each answer — and the envelope analyzer's guesses are gated
 * off. There is deliberately NO local fallback: an answer with no viseme
 * events plays with a resting mouth rather than an amplitude-flapping one.
 *
 * Everything below runs on the APP TASK (the voicelab callbacks and the tick
 * both live there), so the bookkeeping needs no atomics; the only values that
 * cross tasks are the ones already inside the shared animator's seqlock.
 */

/**
 * A viseme change from the stream: `offset_samples` positions it within
 * `answer`, in 16 kHz samples from that answer's first sample. APP TASK ONLY.
 */
void waveshare_avatar_note_viseme(
    uint32_t answer, uint32_t offset_samples,
    uint8_t viseme, uint8_t confidence);

/**
 * Speaker PCM was ACCEPTED into the playout path for `answer`. APP TASK ONLY,
 * from the speaker callback, after classification — never for ignored frames.
 *
 * This is what lets the release side know, later, which answer's samples it
 * is feeding the analyzer: acceptance and release cross two buffers (the
 * StreamBuffer and the avatar ring) in strict FIFO order, so counting
 * accepted samples per answer here and released samples in the tick is
 * enough to line the two up without tagging every sample.
 */
void waveshare_avatar_note_accepted(uint32_t answer, size_t samples);

/**
 * Throw away the mouth track. APP TASK ONLY, from the abandon funnel: the
 * audio those shapes belonged to is being discarded, so the shapes must go
 * with it — a mouth saying words nobody will hear is the exact lie this
 * whole lane exists to avoid. Also resets the accepted/released ledgers, so
 * the next answer's offsets start clean.
 */
void waveshare_avatar_viseme_reset(void);

/**
 * A call became live / ended. APP TASK ONLY. Gates the envelope's mouth off
 * for the duration (the viseme lane owns it) and back on after; call end
 * also drops any pending mouth track.
 */
void waveshare_avatar_set_call_active(bool active);

/**
 * Render one 160x120 RGB565 frame. LVGL TASK ONLY.
 *
 * The renderer carries mouth-debounce history across calls, so it has exactly
 * one caller by design. Returns false when the frame could not be produced, in
 * which case the caller should keep showing the last one.
 *
 * `awake` IS PASSED IN RATHER THAN STORED, and that is the point: the caller
 * already knows whether a call is up, and a second copy of that fact kept here
 * would be one more thing that can disagree with the bar underneath the face.
 * False draws the shared doze face — the character's own authored `sleepy` eyes
 * plus the Z mark — which is the same visual language StackChan and the Stick
 * use, and which the device shows from boot because a device nobody has called
 * is asleep rather than merely expressionless.
 */
bool waveshare_avatar_render(
    uint16_t *rgb565, size_t pixel_capacity, bool awake);

/** 0-255 speaker loudness of the audio the DAC is playing now. */
uint16_t waveshare_avatar_speaker_level(void);

/**
 * Ask for a different face, from any task.
 *
 * A LATEST-ONLY REQUEST, not a selection. The renderer carries mouth-debounce
 * history and is owned by the LVGL task; changing the atlas underneath it from
 * the control-plane task would be a second writer on a structure built for one.
 * So this records what was asked for and the next render applies it — within one
 * visual tick, with several requests in that tick collapsing to the newest.
 *
 * Returns false for a slug no compiled face answers to, which is the only
 * failure: the caller learns immediately that the name was wrong rather than
 * being told "accepted" and seeing nothing change.
 */
bool waveshare_avatar_request_slug(const char *slug);

/** Move to the next compiled face, wrapping. Same latest-only handoff. */
void waveshare_avatar_request_next(void);

/** How many faces are compiled in, and the name of each, for listing them. */
size_t waveshare_avatar_count(void);
const char *waveshare_avatar_slug_at(size_t index);

/** Which face is showing, for the menu and for `health()`. */
const char *waveshare_avatar_slug(void);

/*
 * What went wrong, for health(). All three were dark while the face was frozen
 * and there was nothing to look at but the screen.
 *
 * `frames_analysed` is the one that answers the original question directly: it
 * counts completed analysis windows, so a face that has stopped moving while
 * audio plays shows a number that has stopped climbing.
 */
uint32_t waveshare_avatar_render_failures(void);
/** Samples the producer could not fit, i.e. the app task stalled. */
uint32_t waveshare_avatar_dropped_samples(void);
/** Analysis windows the engine has completed since boot. */
uint32_t waveshare_avatar_frames_analysed(void);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_WAVESHARE_AVATAR_H */
