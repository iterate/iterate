#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/platforms/core_s3_audio_owner.h"
#include "iterate/kit/spsc_ring.h"

#include "esp_err.h"
#include "esp_log.h"

#include <stddef.h>

#define STACKCHAN_PCM_RING_SLOTS 8U

static const char *const TAG = "iterate-stackchan";

/*
 * These rings are the complete application PCM backlog: eight 20 ms frames in
 * each direction. Capacity absorbs ordinary WebSocket scheduling jitter; it
 * does not authorize replay after an outage. The audio owner rejects speaker
 * frames older than 120 ms, while a full microphone ring asks the network
 * consumer to purge the old epoch before sending again.
 *
 * Keeping storage here—outside both transport and audio components—makes the
 * target's memory choice explicit and lets a later k.iterate.com firmware
 * profile tune it without changing either reusable library.
 */
static struct iterate_kit_pcm_uplink_slot
    uplink_storage[STACKCHAN_PCM_RING_SLOTS];
static size_t uplink_lengths[STACKCHAN_PCM_RING_SLOTS];
static struct iterate_kit_pcm_downlink_slot
    downlink_storage[STACKCHAN_PCM_RING_SLOTS];
static size_t downlink_lengths[STACKCHAN_PCM_RING_SLOTS];
static struct iterate_kit_spsc_ring uplink_ring;
static struct iterate_kit_spsc_ring downlink_ring;
static struct iterate_kit_pcm_lane pcm_lane;

static esp_err_t initialise_pcm_lane(void) {
  if (iterate_kit_spsc_ring_init(
          &uplink_ring,
          uplink_storage,
          sizeof(uplink_storage[0]),
          STACKCHAN_PCM_RING_SLOTS,
          uplink_lengths) != ITERATE_KIT_OK ||
      iterate_kit_spsc_ring_init(
          &downlink_ring,
          downlink_storage,
          sizeof(downlink_storage[0]),
          STACKCHAN_PCM_RING_SLOTS,
          downlink_lengths) != ITERATE_KIT_OK ||
      iterate_kit_pcm_lane_init(
          &pcm_lane,
          &uplink_ring,
          &downlink_ring) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  return ESP_OK;
}

void app_main(void) {
  ESP_ERROR_CHECK(initialise_pcm_lane());
  const struct iterate_kit_core_s3_audio_owner_options audio = {
      .lane = &pcm_lane,
      .maximum_downlink_frame_age_ms = 120U,
      .maximum_lane_items_per_dma_chunk = 4U,
      .speaker_volume_percent = 100,
      .microphone_gain_db = 24,
  };
  ESP_ERROR_CHECK(iterate_kit_core_s3_audio_owner_start(&audio));

  /*
   * This target stage intentionally starts at the stable shared PCM seam. A
   * WebSocket owner will consume `pcm_lane` uplink and produce downlink; the
   * codec/AEC path never learns about reconnects, TLS, or provider framing.
   * Startup success therefore proves the target is physically flashable with
   * bounded realtime storage, not yet that a remote provider is connected.
   */
  ESP_LOGI(
      TAG,
      "CoreS3 PCM owner started; application lane=%u frames each direction",
      (unsigned)STACKCHAN_PCM_RING_SLOTS);
}
