#ifndef ITERATE_KIT_STACKCHAN_AUDIO_H
#define ITERATE_KIT_STACKCHAN_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/audio_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  STACKCHAN_AUDIO_SAMPLE_RATE_HZ = 16000,
  /** One I2S DMA descriptor: 8 ms. The capture grain of this board. */
  STACKCHAN_AUDIO_CHUNK_SAMPLES = 128,
};

/**
 * Bring up the M5Stack CoreS3 audio path through the audited BSP override:
 * shared-clock I2S (standard stereo TX for the AW88298, four-slot TDM RX for
 * the ES7210), the read-back-verified AW88298 64fs BCK fix the shared TDM
 * clock requires, the donor's tuned volume curve and channel gains
 * (volume 80; +18 dB on the two acoustic capsules; the divider reference at
 * unity — its scaling is digital, in the processor), the ISR capture
 * reserve, and the priority-23 blocking I/O task whose 8 ms codec write/read
 * pair IS this board's audio clock.
 */
bool stackchan_audio_init(void);

/**
 * The nonblocking shared codec seam for this board.
 *
 * read() delivers one raw 8 ms chunk per call: the near plane is measured
 * TDM slot 2 (slot 0's capsule has a 4.5-5.7 kHz interference shelf that
 * turned "Hey pal" into "PayPal" at the STT oracle) and the reference plane
 * is measured slot 1 — the analogue divider across the actual amplifier
 * output, carrying limiter and harmonic behaviour pristine TX PCM cannot
 * model. Both planes are unconditioned; the processor owns the high-pass
 * and reference scaling. write() admits complete 20 ms frames; the I/O task
 * slices them into 8 ms edges and clocks silence when the staging runs dry,
 * because a full-duplex AEC reference must never stop.
 */
struct iterate_kit_audio_codec stackchan_audio_codec(void);

/**
 * Metadata for the chunk the last successful codec read returned: the DMA
 * sequence, the completion timestamp of its final sample, and whether the
 * speaker edge written immediately before it contained response audio.
 * Same-task with read(), by the reserve's single-consumer contract.
 */
void stackchan_audio_last_chunk_meta(
    uint32_t *sequence,
    uint64_t *captured_through_at_us,
    bool *playback_content_active);

/**
 * True (consumed) when the capture timeline broke: reserve overflow, DMA
 * sequence gap, malformed descriptor, or an IDF RX overflow. The caller must
 * reset the capture bridge and the processor before the next read — losing
 * samples explicitly beats an AEC filter whose alignment is a lie.
 */
bool stackchan_audio_take_epoch_reset(void);

/** Sticky fatal flags after three consecutive codec I/O failures. */
bool stackchan_audio_capture_failed(void);
bool stackchan_audio_playback_failed(void);

/**
 * Observer for physically completed 128-sample speaker DMA frames, called in
 * ISR context (IRAM-safe, no allocation, no logging). The avatar's mouth
 * taps here so it animates audio the hardware actually played.
 */
typedef bool (*stackchan_audio_playout_observer_fn)(
    uint32_t sequence,
    uint64_t completed_at_us,
    const int16_t *pcm,
    size_t sample_count,
    void *context);
void stackchan_audio_set_playout_observer(
    stackchan_audio_playout_observer_fn observer, void *context);

/** Telemetry counters for the health surface. */
uint32_t stackchan_audio_capture_overruns(void);
uint32_t stackchan_audio_capture_driver_failures(void);
uint32_t stackchan_audio_playback_driver_failures(void);
uint32_t stackchan_audio_epoch_resets(void);

/* The absolute-deadline starvation ledger; semantics identical to the other
 * boards (see m5sticks3_audio.h). "Starved" here means the staging ran dry
 * while an answer was being fed — the DAC itself never stops clocking. */
void stackchan_audio_watch(bool active);
void stackchan_audio_draining(void);
void stackchan_audio_note_flush(void);
void stackchan_audio_reserve_write(uint32_t ms);
void stackchan_audio_rollback_write(uint32_t ms);
uint32_t stackchan_audio_starved_ms(void);
uint32_t stackchan_audio_starve_events(void);
uint32_t stackchan_audio_written_ms(void);
void stackchan_audio_inject_starvation(uint32_t ms);
bool stackchan_audio_starvation_pending(void);
uint32_t stackchan_audio_take_injected_starvation(void);

#ifdef __cplusplus
}
#endif

#endif
