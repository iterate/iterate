#ifndef ITERATE_KIT_HOST_ESP_IDF_H
#define ITERATE_KIT_HOST_ESP_IDF_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * The host ESP-IDF: the primitives components/voice names, on a laptop.
 *
 * Real where a running program needs it — the clock, delays, randomness,
 * logging — and deliberately not scheduling: xTaskCreatePinnedToCore records
 * the task and returns without running it, so whoever owns the process pumps
 * iterate_kit_voice_loop_{step,capture_step,playback_step} itself, on one
 * thread. targets/mac does that to be a device; the voice loop tests do it to
 * be a test. The queues are real bounded rings because the audio paths would
 * be meaningless without one.
 *
 * A test pins the clock (iterate_kit_host_esp_idf_set_now_us) and from then
 * on time moves only when it says so — a delay is a clock move, a restart is
 * recorded rather than honoured. Until something pins it, time is the host's
 * monotonic clock, a delay sleeps, and esp_restart() ends the process.
 */

#ifdef __cplusplus
extern "C" {
#endif

/** Drop every task, queue and note; back to real time. Tests call it per fixture. */
void iterate_kit_host_esp_idf_reset(void);

/** Pin the clock: time moves only through set/advance and delays from here on. */
void iterate_kit_host_esp_idf_set_now_us(int64_t now_us);
void iterate_kit_host_esp_idf_advance_ms(uint32_t milliseconds);

size_t iterate_kit_host_esp_idf_tasks_created(void);

/** With a pinned clock esp_restart() only records; this reads what it recorded. */
bool iterate_kit_host_esp_idf_restart_requested(void);

/** The note esp_restart() will print (the platform's restart_with_note sets it). */
void iterate_kit_host_esp_idf_set_restart_note(const char *note);

#ifdef __cplusplus
}
#endif

#endif
