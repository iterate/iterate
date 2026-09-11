#ifndef ITERATE_KIT_M5STICKS3_AUDIO_H
#define ITERATE_KIT_M5STICKS3_AUDIO_H

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/platforms/board.h"

#ifdef __cplusplus
extern "C" {
#endif

enum { M5STICKS3_AUDIO_SAMPLE_RATE_HZ = 16000 };

/* Bind M5Unified's I2C writer and force the M5PM1 PA latch low. M5Unified
 * itself is not allowed to create either I2S audio owner. */
bool m5sticks3_audio_prepare(void);

/* Board-local PA latch around the shared codec's local-sound mailbox. */
void m5sticks3_audio_play_sound(const uint8_t *pcm, uint32_t bytes);
void m5sticks3_audio_amplifier(bool on);

#ifdef __cplusplus
}
#endif
#endif
