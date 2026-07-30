#ifndef ITERATE_KIT_TESTS_FAKE_ESP_IDF_PCM_WEBSOCKET_H
#define ITERATE_KIT_TESTS_FAKE_ESP_IDF_PCM_WEBSOCKET_H

#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Installs one complete server-to-device binary message for a later receive.
 *
 * Exactly five messages may be installed before the first is consumed. Four
 * fill the test lane and the fifth exposes ordered-item loss, while remaining
 * below one production receive burst. `bytes=NULL, byte_count=0` is EOS; the
 * only other accepted shape is one exact v1 PCM frame.
 */
enum iterate_kit_status iterate_kit_fake_pcm_websocket_queue_binary(
    const void *bytes, size_t byte_count);

uint32_t iterate_kit_fake_pcm_websocket_receive_calls(void);
uint32_t iterate_kit_fake_pcm_websocket_deliveries(void);
void iterate_kit_fake_pcm_websocket_reset(void);

#ifdef __cplusplus
}
#endif

#endif
