#ifndef ITERATE_KIT_HOST_ESP_TIMER_H
#define ITERATE_KIT_HOST_ESP_TIMER_H

/*
 * Host stand-in. See esp_idf.h.
 *
 * A test pins the clock with iterate_kit_host_esp_idf_set_now_us() and from
 * then on moves it itself, because a deadline measured against a clock nobody
 * controls cannot be tested. Every voice loop deadline reads this clock.
 */

#include <stdint.h>

int64_t esp_timer_get_time(void);

#endif
