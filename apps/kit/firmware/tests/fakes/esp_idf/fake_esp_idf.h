#ifndef ITERATE_KIT_FAKE_ESP_IDF_H
#define ITERATE_KIT_FAKE_ESP_IDF_H

/*
 * What a test can ask the pretend ESP-IDF, and the one thing it must tell it.
 *
 * See README.md in this directory for what these fakes are and are not.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * EVERY FIXTURE CALLS THIS FIRST.
 *
 * All of this is file-static, exactly like the firmware it stands in for, so
 * two tests in one process share a clock, a queue pool and a restart flag
 * unless one of them says otherwise.
 */
void iterate_kit_fake_esp_idf_reset(void);

/** Move the clock `esp_timer_get_time` answers from. Never moves on its own. */
void iterate_kit_fake_esp_idf_set_now_us(int64_t now_us);
void iterate_kit_fake_esp_idf_advance_ms(uint32_t milliseconds);

/**
 * Tasks the loop asked for and this fake did not run.
 *
 * `iterate_kit_voice_loop_init` creates capture and playback tasks; on a host
 * the test drives `iterate_kit_voice_loop_capture_step` and
 * `_playback_step` itself. Counting the requests is how a test proves boot
 * reached the end rather than parking somewhere earlier.
 */
size_t iterate_kit_fake_esp_idf_tasks_created(void);
const char *iterate_kit_fake_esp_idf_task_name(size_t index);

/**
 * True once the device has asked to restart.
 *
 * `esp_restart()` does not return on hardware and `park_with_fault()` never
 * returns either. Neither can be honoured here without ending the test process,
 * so both are recorded and control comes back — which means a test that expects
 * a healthy boot must ASSERT this is false rather than assume it.
 */
bool iterate_kit_fake_esp_idf_restart_requested(void);
const char *iterate_kit_fake_esp_idf_restart_note(void);

/** Make the next queue creation fail, to reach the loop's allocation guard. */
void iterate_kit_fake_esp_idf_fail_next_queue(void);

#ifdef __cplusplus
}
#endif

#endif
