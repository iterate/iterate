#ifndef ITERATE_KIT_FACE_WAKE_H
#define ITERATE_KIT_FACE_WAKE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * How long a face stays awake after its conversation ends, in milliseconds.
 *
 * THE END OF A CALL IS THE MOMENT THE FACE GOES BACK TO SLEEP. Two boards
 * previously waited three minutes, on the reasoning that a resting robot
 * reads better than a crashed one — but a face that stays wide awake for
 * three minutes after you hang up does not read as resting, it reads as a
 * device that did not notice you left. Closed eyes are this product's word
 * for idle, so idle should show them, promptly.
 *
 * The tail exists only so the last syllable of an answer is not cut off by
 * eyelids, and so a call that drops and immediately recovers does not blink
 * the whole face off and on.
 */
enum { ITERATE_KIT_FACE_AWAKE_TAIL_MS = 3000 };

/**
 * The caller's wake clock.
 *
 * State is passed in rather than kept in a file-static so two surfaces on one
 * board cannot silently share one timer, and so a host test can run the whole
 * lifecycle without a clock. Zero-initialise it: a board that has never held
 * a conversation is asleep, which is what a freshly powered device should
 * look like.
 */
struct iterate_kit_face_wake {
  uint64_t last_active_ms;
  bool ever_active;
};

/**
 * Reports whether the face should be awake, and remembers the last call.
 *
 * Call this once per rendered frame with the current conversation state.
 */
bool iterate_kit_face_awake(
    struct iterate_kit_face_wake *wake,
    bool conversation_active,
    uint64_t now_ms);

#ifdef __cplusplus
}
#endif

#endif
