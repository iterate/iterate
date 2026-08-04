#ifndef ITERATE_KIT_WAVESHARE_RECORDER_H
#define ITERATE_KIT_WAVESHARE_RECORDER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Per-call flight recorder on the SD card.
 *
 * Each call wipes the recording directory and starts fresh: both PCM lanes as
 * raw 16 kHz mono S16LE (playable with `ffplay -f s16le -ar 16000 -ch_layout
 * mono`), and a line log of every turn edge, transcript line and error. The
 * point is to be able to listen to exactly what the microphone sent and what
 * the speaker played for the same call, which is the only honest way to
 * argue about echo, clipping or dropouts.
 *
 * Every entry point is a no-op when there is no card, so a device without one
 * behaves exactly as before.
 */
bool waveshare_recorder_init(void);

/**
 * Drain whatever the audio lanes handed over, writing it to the card. Runs on
 * the recorder's own low-priority task: a FatFs write can block for hundreds
 * of milliseconds while the card erases a block, and doing that on the
 * playback task starves the I2S feed — which is heard as static, not as a
 * slow recording.
 */
void waveshare_recorder_drain(void);

/** True when a card is mounted and calls are being recorded. */
bool waveshare_recorder_available(void);

/**
 * How many recordings have been opened and closed since boot. One begin per
 * call is healthy; a count that climbs while nothing happens is the card
 * being wiped and reopened in a loop, which has happened twice and is
 * invisible without a number to look at.
 */
uint32_t waveshare_recorder_begins(void);
uint32_t waveshare_recorder_ends(void);

/** True while a recording is open. */
bool waveshare_recorder_recording(void);

/** Bytes written to each lane since the recording opened. */
void waveshare_recorder_counters(
    size_t *mic_bytes, size_t *speaker_bytes, size_t *log_bytes);

/**
 * Request a fresh recording. The directory wipe and the file opens happen on
 * the recorder's own task — on the caller's task they were seconds of FatFs
 * work landing exactly when a call goes live, i.e. as the greeting arrives.
 */
void waveshare_recorder_begin_call(const char *call_id);

/** Request the current recording be closed. */
void waveshare_recorder_end_call(const char *reason);

/** Uplink PCM, exactly as sent. */
void waveshare_recorder_write_mic(const void *pcm, size_t bytes);

/** Downlink PCM, exactly as played. */
void waveshare_recorder_write_speaker(const void *pcm, size_t bytes);

/**
 * Read `length` bytes at `offset` from a recorded file (`mic.pcm`,
 * `speaker.pcm`, `call.log`). Returns the number of bytes read, so a caller
 * can pull a recording off the device over ordinary RPC. Rejects any name
 * with a path separator.
 */
size_t waveshare_recorder_read(
    const char *name, size_t offset, void *out, size_t capacity);

/**
 * Byte length of a recorded file. Answered from counters the recorder task
 * maintains, NOT from the filesystem: stat() on FatFs can block the caller
 * for up to FF_FS_TIMEOUT (10s), and the caller here is the task that
 * answers every RPC and produces every speaker frame. A capability call must
 * never be able to wedge the device.
 */
size_t waveshare_recorder_size(const char *name);

/** Whether `name` is one of the three files this device records. */
bool waveshare_recorder_known_name(const char *name);

/** Whole-file size measured by the recorder task; 0 when absent. */
size_t waveshare_recorder_measure(const char *name);

/** One line in the call log; `printf` formatting. */
void waveshare_recorder_log(const char *format, ...)
    __attribute__((format(printf, 1, 2)));

#ifdef __cplusplus
}
#endif

#endif
