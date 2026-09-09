#ifndef ITERATE_KIT_PLATFORMS_WAKE_WORD_H
#define ITERATE_KIT_PLATFORMS_WAKE_WORD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef ESP_PLATFORM
#include "sdkconfig.h"
#endif

#ifdef __cplusplus
extern "C" {
#endif

/** One WakeNet chunk, in caller-owned storage. Initialize samples and capacity
 * to get_samp_chunksize(), used to zero. Only its producer may access it.
 * Set used to zero whenever capture is discontinuous or detection pauses.
 */
struct iterate_kit_wake_word_buffer {
  int16_t *samples;
  size_t capacity;
  size_t used;
};

/** Assemble arbitrary 16 kHz mono slices into exact model chunks, preserving
 * sample order and the unfinished suffix. Invalid storage/input returns false
 * without changing state. consume receives mutable scratch, never the uplink;
 * false discards the remainder of this feed and clears the partial chunk.
 */
bool iterate_kit_wake_word_buffer_feed(
    struct iterate_kit_wake_word_buffer *buffer,
    const int16_t *samples, size_t count,
    bool (*consume)(void *context, int16_t *samples), void *context);

#ifdef CONFIG_ITERATE_KIT_WAKE_WORD
/** Load Jarvis from the model partition and start the priority-5/core-1 task.
 * Start once, during board finish. Starts paused; errors return false to the
 * board's startup fault path. No runtime fallback for missing/corrupt flash.
 */
bool iterate_kit_wake_word_start(const char *wake_word);
/** Publish the loop's idle state. Disabling invalidates queued PCM, model
 * history and pending detection. Called only from the board's app task.
 */
void iterate_kit_wake_word_set_enabled(bool enabled);
/** Cheap atomic capture guard; false until initialization and idle publication. */
bool iterate_kit_wake_word_enabled(void);
/** Nonblocking capture tap after gain, before the uplink mailbox. Accepts up
 * to 320 samples. Three queued frames bound latency; overflow invalidates
 * history and counts wakeWordOverruns. Speaker activity also invalidates it.
 */
void iterate_kit_wake_word_feed(const int16_t *samples, size_t count);
/** Consume one still-current detection on the app task. Rechecks speaker
 * activity; the caller must also check the loop's call_active/wants_call.
 */
bool iterate_kit_wake_word_take_detection(void);
/** Append detections, inferred model frames, model id (1 = Jarvis), maximum
 * inference wall time in microseconds, chunk samples, and queue overruns.
 * Compare wakeWordMaxUs with wakeWordChunkSamples * 1000000 / 16000.
 * Zero means no room.
 */
size_t iterate_kit_wake_word_health(char *out, size_t capacity);
#endif

#ifdef __cplusplus
}
#endif
#endif
