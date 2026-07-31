#include "iterate/kit/platforms/core_s3_bsp_audio.h"

#include "esp_log.h"

/*
 * This intentionally small first target stage proves that the exact-source
 * BSP override is selected and linked before the realtime owner is allowed to
 * depend on it. A generic CoreS3 BSP build would compile while silently using
 * standard mono RX, hiding both the microphone/reference slot loss and the
 * stock 90 ms DMA retention until a physical AEC test. Calling the Iterate-only
 * symbol turns that configuration mistake into a link failure instead.
 */
void app_main(void) {
  iterate_kit_core_s3_i2s_stats_t stats = {0};
  iterate_kit_core_s3_i2s_stats_snapshot(&stats);
  ESP_LOGI(
      "iterate-stackchan",
      "CoreS3 BSP audio seam linked: tx=%lu rx=%lu",
      (unsigned long)stats.tx_dma_events,
      (unsigned long)stats.rx_dma_events);
}
