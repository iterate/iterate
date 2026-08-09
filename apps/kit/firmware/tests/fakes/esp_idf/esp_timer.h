#ifndef ITERATE_KIT_FAKE_ESP_TIMER_H
#define ITERATE_KIT_FAKE_ESP_TIMER_H

/*
 * Host stand-in. See README.md in this directory.
 *
 * The clock does not run on its own. A test advances it with
 * iterate_kit_fake_esp_idf_set_now_us(), because a deadline measured against a
 * clock nobody controls cannot be tested — which is the same reason
 * iterate_kit_voice_loop_step() takes `now_ms` as a parameter.
 */

#include <stdint.h>

int64_t esp_timer_get_time(void);

#endif
