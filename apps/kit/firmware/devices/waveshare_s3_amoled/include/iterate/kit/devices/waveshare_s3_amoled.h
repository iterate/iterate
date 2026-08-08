#ifndef ITERATE_KIT_DEVICES_WAVESHARE_S3_AMOLED_H
#define ITERATE_KIT_DEVICES_WAVESHARE_S3_AMOLED_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Bring up the complete Waveshare ESP32-S3 Touch AMOLED voice device.
 *
 * This is the board composition boundary. The function does not return after
 * successful initialization; failures are logged and leave the device in a
 * bounded restart loop owned by the ESP-IDF runtime.
 */
void iterate_kit_waveshare_s3_amoled_run(void);

#ifdef __cplusplus
}
#endif

#endif
