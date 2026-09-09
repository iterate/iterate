#ifndef ITERATE_KIT_PLATFORMS_I2S_CODEC_H
#define ITERATE_KIT_PLATFORMS_I2S_CODEC_H

#include "iterate/kit/audio_codec.h"
#include "iterate/kit/voice_playout.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Start the singleton 16 kHz mono codec over board-owned BLOCKING operations.
 * read fills exactly 320 samples; write consumes 1..320. UNAVAILABLE is a
 * fence/no frame, not a driver failure; failed writes receive no ledger credit.
 * Only the two hardware tasks call these operations (capture: priority 19,
 * playback: 20; core 1, 4 KiB). Depth-one mailboxes bound latency and expose
 * nonblocking read/write to the loop. Startup capture is not counted as loss.
 * out receives reference-free, unity-gain properties; boards with a volume
 * control retain their own properties on the returned codec. Start once per
 * boot, after clocks, codec and amplifier are ready. Failure leaves no tasks.
 */
bool iterate_kit_i2s_codec_start_over(
    enum iterate_kit_status (*read)(void *, int16_t *, size_t),
    enum iterate_kit_status (*write)(void *, const int16_t *, size_t),
    void *context, uint16_t ring_ms, struct iterate_kit_audio_codec *out);
/** Install a board wait before reserving write credit, before start_over.
 * Waveshare's analogue amplifier settles BEFORE the deadline advances; HAVPE
 * needs no wait. Called only on the playback hardware task, outside the lock.
 * context is the start_over context. NULL leaves the blocking writer ready.
 */
void iterate_kit_i2s_codec_set_before_write(void (*wait)(void *));
/** Apply the shared starvation phase under one lock; boards own amp actions. */
void iterate_kit_i2s_codec_phase(enum iterate_kit_voice_phase phase);
/** Preempt stream PCM with flash-resident PCM16LE, without mixing or allocation.
 * PCM must remain valid through playback. A replacement takes effect next
 * slice; the stream waits behind its mailbox. NULL/short clips are ignored.
 */
void iterate_kit_i2s_codec_play_sound(const uint8_t *pcm, uint32_t bytes);
/** Whether unsliced local PCM remains; board-specific amp holds are separate. */
bool iterate_kit_i2s_codec_sound_active(void);
/** Armed ring activity including 1500 ms pauses within an answer (HAVPE's
 * echo oracle window); this does not include a local sound's amp hold.
 */
bool iterate_kit_i2s_codec_speaker_is_playing(void);
/** Append the six task/ledger health fields, returning 0 on insufficient space.
 * Counters are copied under the codec lock; uses health_append_fields' contract.
 */
size_t iterate_kit_i2s_codec_health(char *out, size_t capacity);

#ifdef __cplusplus
}
#endif
#endif
