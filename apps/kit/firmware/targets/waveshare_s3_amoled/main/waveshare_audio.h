#ifndef ITERATE_KIT_WAVESHARE_AUDIO_H
#define ITERATE_KIT_WAVESHARE_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "driver/i2c_master.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  WAVESHARE_AUDIO_SAMPLE_RATE_HZ = 16000,
  WAVESHARE_AUDIO_FRAME_SAMPLES = 320, /* 20 ms mono */
};

/**
 * Bring up the Waveshare ESP32-S3 Touch AMOLED 1.8 audio path: I2C bus,
 * AXP2101 rails (DC1 3.3V main, ALDO1 3.3V mic), one duplex I2S pair
 * (MCLK 16 / BCLK 9 / WS 45 / DIN 10 / DOUT 8, mclk x256), ES8311 via
 * esp_codec_dev (PA on GPIO46), 16 kHz mono PCM16 both directions.
 */
bool waveshare_audio_init(void);

/** Blocking capture of exactly `samples` mono PCM16 samples. */
bool waveshare_audio_read(int16_t *destination, size_t samples);

/**
 * Power the class-D amplifier. It is deliberately NOT held on for the life of
 * the board: the amp sits centimetres from the microphone with no AEC
 * reference, and its idle noise floor is audible. The playback path raises it
 * before the first frame and drops it when the speaker runs dry.
 */
void waveshare_audio_amplifier(bool on);

/** Blocking playout of exactly `samples` mono PCM16 samples. */
bool waveshare_audio_write(const int16_t *pcm, size_t samples);

/** The shared I2C0 bus (codec, PMIC, touch). NULL before init. */
i2c_master_bus_handle_t waveshare_audio_i2c_bus(void);

/** Log the ES8311's ADC-path registers (bring-up diagnostics). */
void waveshare_audio_dump_registers(void);

/** Log whether anything drives the I2S DIN pad (bring-up diagnostics). */
void waveshare_audio_probe_din(void);

#ifdef __cplusplus
}
#endif

#endif
