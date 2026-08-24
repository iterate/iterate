#ifndef ITERATE_KIT_PLATFORMS_CORE_S3_BSP_AUDIO_H
#define ITERATE_KIT_PLATFORMS_CORE_S3_BSP_AUDIO_H

#include "driver/i2s_std.h"
#include "driver/i2s_tdm.h"
#include "esp_err.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t tx_dma_events;
  uint32_t tx_queue_overflows;
  uint32_t rx_dma_events;
  uint32_t rx_queue_overflows;
} iterate_kit_core_s3_i2s_stats_t;

/**
 * Observes one physically completed 128-sample I2S DMA descriptor.
 *
 * `completed_at_us` is the device monotonic timestamp captured in interrupt
 * context. RX PCM is the four-slot ES7210 TDM buffer; TX PCM is mono speaker
 * data. The callback must be IRAM-safe and return true only when it woke a
 * higher-priority task. It must not allocate, block, log, or call ordinary
 * FreeRTOS APIs.
 */
typedef bool (*iterate_kit_core_s3_i2s_tap_callback_t)(
    bool transmit,
    uint32_t sequence,
    uint64_t completed_at_us,
    const void *pcm,
    size_t bytes,
    void *user_data);

/**
 * Initializes the shared CoreS3 clock as standard speaker TX plus TDM mic RX.
 * This is the only Iterate divergence from the BSP's audio initialization.
 */
esp_err_t iterate_kit_core_s3_audio_init_tdm_rx(
    const i2s_std_config_t *tx_config,
    const i2s_tdm_config_t *rx_config);

void iterate_kit_core_s3_i2s_stats_snapshot(
    iterate_kit_core_s3_i2s_stats_t *snapshot);
void iterate_kit_core_s3_i2s_set_tap(
    iterate_kit_core_s3_i2s_tap_callback_t callback,
    void *user_data);

#ifdef __cplusplus
}
#endif

#endif
