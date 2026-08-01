#include "iterate/kit/platforms/core_s3_audio_owner.h"

#include "bsp/m5stack_core_s3.h"
#include "driver/i2s_std.h"
#include "driver/i2s_tdm.h"
#include "esp_aec.h"
#include "esp_attr.h"
#include "esp_codec_dev.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"

#include <limits.h>
#include <string.h>

/*
 * This file owns timing, not transport. Network code owns the two opposite
 * sides of pcm_lane; this owner only consumes current speaker PCM and produces
 * current clean microphone PCM. Keeping that seam explicit lets the same
 * clock/DSP code run against a real WebSocket, a deterministic host feeder, or
 * a deliberately hostile network harness without changing hardware policy.
 */

#define CORE_S3_IO_STACK_BYTES 4096U
#define CORE_S3_AEC_STACK_BYTES 6144U
#define CORE_S3_IO_TASK_PRIORITY 23U
#define CORE_S3_AEC_TASK_PRIORITY 20U
#define CORE_S3_AUDIO_TASK_CORE 1
#define CORE_S3_DMA_DESCRIPTOR_COUNT 5U
#define CORE_S3_RX_STARTUP_DRAIN_CHUNKS CORE_S3_DMA_DESCRIPTOR_COUNT
#define CORE_S3_IO_FAILURE_LIMIT 3U
#define CORE_S3_AEC_FILTER_LENGTH 4
#define CORE_S3_AEC_REFERENCE_GAIN_DB 0.0F
#define CORE_S3_AEC_NLP_LEVEL 2
#define CORE_S3_TDM_NEAR_SLOT 0U
#define CORE_S3_TDM_REFERENCE_SLOT 1U
#define CORE_S3_AW88298_I2SCTRL_REG 0x06
#define CORE_S3_AW88298_I2SBCK_MASK 0x30
#define CORE_S3_AW88298_I2SBCK_64FS 0x20

static const char *const TAG = "iterate-core-s3-audio";

/*
 * CoreS3's BSP declares a fixed +15 dB external PA gain. The codec abstraction
 * subtracts that declaration, making its normal 100% setting 15 dB quieter
 * than M5Stack's own driver. This measured curve reaches the same codec 0 dB
 * setting at 100% while preserving hard mute at logical volume zero.
 */
static esp_codec_dev_vol_map_t speaker_volume_map[] = {
    {.vol = 1, .db_value = -34.5F},
    {.vol = 100, .db_value = 15.0F},
};

struct core_s3_atomic_metrics {
  volatile uint32_t io_cycles;
  volatile uint32_t codec_write_errors;
  volatile uint32_t codec_read_errors;
  volatile uint32_t playback_policy_errors;
  volatile uint32_t playback_content_samples;
  volatile uint32_t playback_silence_samples;
  volatile uint32_t playback_resets;
  volatile uint32_t downlink_frames_discarded_by_reset;
  volatile uint32_t last_codec_write_us;
  volatile uint32_t maximum_codec_write_us;
  volatile uint32_t last_codec_read_us;
  volatile uint32_t maximum_codec_read_us;
  volatile uint32_t last_receive_to_render_ms;
  volatile uint32_t maximum_receive_to_render_ms;

  volatile uint32_t capture_chunks_deinterleaved;
  volatile uint32_t tdm_slot_peak[ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT];
  volatile uint32_t capture_bridge_errors;
  volatile uint32_t aec_frames;
  volatile uint32_t aec_recreates;
  volatile uint32_t aec_recreate_failures;
  volatile uint32_t last_aec_linear_us;
  volatile uint32_t maximum_aec_linear_us;
  volatile uint32_t last_aec_nlp_us;
  volatile uint32_t maximum_aec_nlp_us;
  volatile uint32_t clean_uplink_frames;
  volatile uint32_t clean_uplink_drops;
  volatile uint32_t last_capture_to_uplink_us;
  volatile uint32_t maximum_capture_to_uplink_us;
  volatile uint32_t aec_input_partial_samples;
  volatile uint32_t clean_egress_partial_samples;
};

struct core_s3_audio_owner {
  struct iterate_kit_pcm_lane *lane;
  esp_codec_dev_handle_t speaker;
  esp_codec_dev_handle_t microphone;
  aec_handle_t *aec;

  struct iterate_kit_core_s3_capture_reserve capture_reserve;
  struct iterate_kit_core_s3_capture_chunk capture_chunk;
  struct iterate_kit_pcm_clock_playback playback;
  struct iterate_kit_aec_capture_bridge capture_bridge;

  int16_t retained_downlink[ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME]
      __attribute__((aligned(16)));
  int16_t playback_dma[ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t capture_drain[ITERATE_KIT_CORE_S3_DMA_INTERLEAVED_SAMPLES]
      __attribute__((aligned(16)));
  int16_t near_dma[ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t reference_dma[ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t aec_near[ITERATE_KIT_CORE_S3_AEC_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t aec_reference[ITERATE_KIT_CORE_S3_AEC_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t aec_clean[ITERATE_KIT_CORE_S3_AEC_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t clean_egress[ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME]
      __attribute__((aligned(16)));

  StaticTask_t io_task_control;
  StaticTask_t aec_task_control;
  StackType_t io_stack[CORE_S3_IO_STACK_BYTES]
      __attribute__((aligned(16)));
  StackType_t aec_stack[CORE_S3_AEC_STACK_BYTES]
      __attribute__((aligned(16)));
  TaskHandle_t io_task;
  TaskHandle_t aec_task;

  struct core_s3_atomic_metrics metrics;
  volatile uint32_t started;
  volatile uint32_t running;
  volatile uint32_t ready;
  volatile uint32_t playback_failed;
  volatile uint32_t capture_failed;
  volatile uint32_t capture_tap_enabled;
  volatile uint32_t playback_reset_requested;
  uint32_t last_rx_queue_overflows;
  int speaker_volume_percent;
  int microphone_gain_db;
};

/*
 * Every ISR-visible sample, both task stacks, and every intermediary frame are
 * one link-visible internal-DRAM object. That is less flexible than heap
 * allocation but makes the exact realtime reservation visible in the map file
 * and prevents PSRAM/cache stalls from entering the DMA callback path.
 */
static DRAM_ATTR struct core_s3_audio_owner owner
    __attribute__((aligned(16)));

static uint32_t monotonic_us_since(int64_t started_at_us) {
  const int64_t elapsed = esp_timer_get_time() - started_at_us;
  if (elapsed <= 0) {
    return 0U;
  }
  return (uint64_t)elapsed > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)elapsed;
}

static uint64_t monotonic_ms(void) {
  const int64_t now_us = esp_timer_get_time();
  return now_us <= 0
      ? 0U
      : (uint64_t)now_us / 1000U;
}

static void atomic_saturating_increment(volatile uint32_t *value) {
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             current + 1U,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static void atomic_saturating_add(
    volatile uint32_t *value,
    size_t amount) {
#if SIZE_MAX > UINT32_MAX
  const uint32_t bounded_amount = amount > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)amount;
#else
  const uint32_t bounded_amount = (uint32_t)amount;
#endif
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX) {
    const uint32_t next = bounded_amount > UINT32_MAX - current
        ? UINT32_MAX
        : current + bounded_amount;
    if (__atomic_compare_exchange_n(
            value,
            &current,
            next,
            false,
            __ATOMIC_RELAXED,
            __ATOMIC_RELAXED)) {
      return;
    }
  }
}

static void atomic_note_maximum(
    volatile uint32_t *maximum,
    uint32_t candidate) {
  uint32_t current = __atomic_load_n(maximum, __ATOMIC_RELAXED);
  while (candidate > current &&
         !__atomic_compare_exchange_n(
             maximum,
             &current,
             candidate,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static uint32_t atomic_load(const volatile uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static void mirror_capture_bridge_metrics(void) {
  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&owner.capture_bridge);
  if (metrics == NULL) {
    return;
  }
  const uint32_t input_partial =
      metrics->input_partial_samples > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)metrics->input_partial_samples;
  const uint32_t egress_partial =
      metrics->egress_partial_samples > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)metrics->egress_partial_samples;
  __atomic_store_n(
      &owner.metrics.aec_input_partial_samples,
      input_partial,
      __ATOMIC_RELAXED);
  __atomic_store_n(
      &owner.metrics.clean_egress_partial_samples,
      egress_partial,
      __ATOMIC_RELAXED);
}

static esp_err_t configure_speaker_for_shared_tdm_clock(void) {
  int value = 0;
  if (esp_codec_dev_read_reg(
          owner.speaker,
          CORE_S3_AW88298_I2SCTRL_REG,
          &value) != ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  value = (value & ~CORE_S3_AW88298_I2SBCK_MASK) |
      CORE_S3_AW88298_I2SBCK_64FS;
  if (esp_codec_dev_write_reg(
          owner.speaker,
          CORE_S3_AW88298_I2SCTRL_REG,
          value) != ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  int verified = 0;
  if (esp_codec_dev_read_reg(
          owner.speaker,
          CORE_S3_AW88298_I2SCTRL_REG,
          &verified) != ESP_CODEC_DEV_OK ||
      (verified & CORE_S3_AW88298_I2SBCK_MASK) !=
          CORE_S3_AW88298_I2SBCK_64FS) {
    return ESP_FAIL;
  }
  return ESP_OK;
}

static esp_err_t initialize_codecs(void) {
  /*
   * TX remains ordinary Philips stereo for AW88298. RX is four-slot TDM for
   * ES7210: measured slot 0 is MIC1 (near), measured slot 1 is MIC3 (the
   * analogue divider across actual speaker output). Using the latter—not a
   * software copy of intended playback—keeps the AEC reference aligned with
   * what the amplifier really emitted, including mute/gain/clock effects.
   */
  const i2s_std_config_t tx = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(
          ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ),
      .slot_cfg = {
          .data_bit_width = I2S_DATA_BIT_WIDTH_16BIT,
          .slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO,
          .slot_mode = I2S_SLOT_MODE_STEREO,
          .slot_mask = I2S_STD_SLOT_BOTH,
          .ws_width = I2S_DATA_BIT_WIDTH_16BIT,
          .ws_pol = false,
          .bit_shift = true,
          .left_align = true,
          .big_endian = false,
          .bit_order_lsb = false,
      },
      .gpio_cfg = {
          .mclk = BSP_I2S_MCLK,
          .bclk = BSP_I2S_SCLK,
          .ws = BSP_I2S_LCLK,
          .dout = BSP_I2S_DOUT,
          .din = I2S_GPIO_UNUSED,
          .invert_flags = {
              .mclk_inv = false,
              .bclk_inv = false,
              .ws_inv = false,
          },
      },
  };
  const i2s_tdm_config_t rx = {
      .clk_cfg = {
          .sample_rate_hz = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
          .clk_src = I2S_CLK_SRC_DEFAULT,
          .ext_clk_freq_hz = 0,
          .mclk_multiple = I2S_MCLK_MULTIPLE_256,
          .bclk_div = 8,
      },
      .slot_cfg = {
          .data_bit_width = I2S_DATA_BIT_WIDTH_16BIT,
          .slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO,
          .slot_mode = I2S_SLOT_MODE_STEREO,
          .slot_mask = I2S_TDM_SLOT0 | I2S_TDM_SLOT1 |
              I2S_TDM_SLOT2 | I2S_TDM_SLOT3,
          .ws_width = I2S_TDM_AUTO_WS_WIDTH,
          .ws_pol = false,
          .bit_shift = true,
          .left_align = false,
          .big_endian = false,
          .bit_order_lsb = false,
          .skip_mask = false,
          .total_slot = I2S_TDM_AUTO_SLOT_NUM,
      },
      .gpio_cfg = {
          .mclk = BSP_I2S_MCLK,
          .bclk = BSP_I2S_SCLK,
          .ws = BSP_I2S_LCLK,
          .dout = I2S_GPIO_UNUSED,
          .din = BSP_I2S_DSIN,
          .invert_flags = {
              .mclk_inv = false,
              .bclk_inv = false,
              .ws_inv = false,
          },
      },
  };

  esp_err_t status = bsp_i2c_init();
  if (status != ESP_OK) {
    return status;
  }
  status = iterate_kit_core_s3_audio_init_tdm_rx(&tx, &rx);
  if (status != ESP_OK) {
    return status;
  }
  owner.speaker = bsp_audio_codec_speaker_init();
  owner.microphone = bsp_audio_codec_microphone_init();
  if (owner.speaker == NULL || owner.microphone == NULL) {
    return ESP_ERR_NOT_FOUND;
  }

  esp_codec_dev_vol_curve_t curve = {
      .vol_map = speaker_volume_map,
      .count = sizeof(speaker_volume_map) /
          sizeof(speaker_volume_map[0]),
  };
  esp_codec_dev_sample_info_t speaker_format = {
      .bits_per_sample = 16,
      .channel = 1,
      .channel_mask = 0,
      .sample_rate = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
      .mclk_multiple = 0,
  };
  esp_codec_dev_sample_info_t microphone_format = {
      .bits_per_sample = 16,
      .channel = ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT,
      .channel_mask = ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0) |
          ESP_CODEC_DEV_MAKE_CHANNEL_MASK(1) |
          ESP_CODEC_DEV_MAKE_CHANNEL_MASK(2) |
          ESP_CODEC_DEV_MAKE_CHANNEL_MASK(3),
      .sample_rate = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
      .mclk_multiple = 0,
  };
  if (esp_codec_dev_set_vol_curve(owner.speaker, &curve) !=
          ESP_CODEC_DEV_OK ||
      esp_codec_dev_set_out_vol(
          owner.speaker,
          owner.speaker_volume_percent) != ESP_CODEC_DEV_OK ||
      esp_codec_dev_open(owner.speaker, &speaker_format) !=
          ESP_CODEC_DEV_OK ||
      esp_codec_dev_open(owner.microphone, &microphone_format) !=
          ESP_CODEC_DEV_OK ||
      configure_speaker_for_shared_tdm_clock() != ESP_OK ||
      esp_codec_dev_set_in_channel_gain(
          owner.microphone,
          ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0),
          (float)owner.microphone_gain_db) != ESP_CODEC_DEV_OK ||
      esp_codec_dev_set_in_channel_gain(
          owner.microphone,
          ESP_CODEC_DEV_MAKE_CHANNEL_MASK(2),
          CORE_S3_AEC_REFERENCE_GAIN_DB) != ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  return ESP_OK;
}

static aec_handle_t *create_aec(void) {
  aec_config_t config = {
      .mic_num = 1,
      .ref_num = 1,
      .out_num = 1,
      .filter_length = CORE_S3_AEC_FILTER_LENGTH,
      .sample_rate = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
      .caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT,
      .mode = AEC_MODE_FD_HIGH_PERF,
      .nlp_level = (aec_nlp_level_t)CORE_S3_AEC_NLP_LEVEL,
  };
  aec_handle_t *const aec = aec_create_from_config(&config);
  if (aec == NULL) {
    return NULL;
  }
  if (aec_get_chunksize(aec) !=
      (int)ITERATE_KIT_CORE_S3_AEC_FRAME_SAMPLES) {
    /*
     * The bridge's static envelope is an executable contract, not a hint.
     * Running a future ESP-SR frame shape against 512-sample arrays would be
     * memory corruption; fail startup instead of silently truncating it.
     */
    aec_destroy(aec);
    return NULL;
  }
  return aec;
}

static enum iterate_kit_status reset_aec(void *context) {
  struct core_s3_audio_owner *const state = context;
  if (state == NULL || state->aec == NULL) {
    return ITERATE_KIT_STATE_ERROR;
  }

  /*
   * ESP-SR standalone AEC exposes no adaptive-filter reset. Destroy/recreate
   * is therefore the only honest generation barrier after a capture gap. It
   * is deliberately confined to this exceptional lower-priority task path;
   * the speaker owner continues to meet DMA cadence while ESP-SR allocates in
   * PSRAM. There is no allocation in ordinary capture/playback steady state.
   */
  aec_destroy(state->aec);
  state->aec = NULL;
  atomic_saturating_increment(&state->metrics.aec_recreates);
  state->aec = create_aec();
  if (state->aec == NULL) {
    atomic_saturating_increment(
        &state->metrics.aec_recreate_failures);
    __atomic_store_n(&state->capture_failed, 1U, __ATOMIC_RELEASE);
    __atomic_store_n(
        &state->capture_tap_enabled, 0U, __ATOMIC_RELEASE);
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status process_aec(
    void *context,
    const int16_t *near_samples,
    const int16_t *reference_samples,
    int16_t *clean_samples,
    size_t sample_count) {
  struct core_s3_audio_owner *const state = context;
  if (state == NULL || state->aec == NULL ||
      sample_count != ITERATE_KIT_CORE_S3_AEC_FRAME_SAMPLES) {
    return ITERATE_KIT_STATE_ERROR;
  }

  const int64_t linear_started_at_us = esp_timer_get_time();
  aec_linear_process(
      state->aec,
      (int16_t *)near_samples,
      (int16_t *)reference_samples,
      clean_samples);
  const uint32_t linear_us =
      monotonic_us_since(linear_started_at_us);
  const int64_t nlp_started_at_us = esp_timer_get_time();
  (void)aec_nlp_process(state->aec, clean_samples);
  const uint32_t nlp_us = monotonic_us_since(nlp_started_at_us);

  atomic_saturating_increment(&state->metrics.aec_frames);
  __atomic_store_n(
      &state->metrics.last_aec_linear_us,
      linear_us,
      __ATOMIC_RELAXED);
  atomic_note_maximum(
      &state->metrics.maximum_aec_linear_us, linear_us);
  __atomic_store_n(
      &state->metrics.last_aec_nlp_us,
      nlp_us,
      __ATOMIC_RELAXED);
  atomic_note_maximum(
      &state->metrics.maximum_aec_nlp_us, nlp_us);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status copy_clean_uplink(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us) {
  struct core_s3_audio_owner *const state = context;
  if (state == NULL || sample_count !=
          ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME ||
      sample_rate_hz != ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  const enum iterate_kit_status status =
      iterate_kit_pcm_lane_submit_uplink_at(
          state->lane,
          samples,
          sample_count * sizeof(*samples),
          captured_through_at_us / 1000U);
  if (status == ITERATE_KIT_OK) {
    atomic_saturating_increment(
        &state->metrics.clean_uplink_frames);
    const int64_t now_us = esp_timer_get_time();
    if (now_us >= 0 &&
        (uint64_t)now_us >= captured_through_at_us) {
      const uint64_t elapsed =
          (uint64_t)now_us - captured_through_at_us;
      const uint32_t bounded = elapsed > UINT32_MAX
          ? UINT32_MAX
          : (uint32_t)elapsed;
      __atomic_store_n(
          &state->metrics.last_capture_to_uplink_us,
          bounded,
          __ATOMIC_RELAXED);
      atomic_note_maximum(
          &state->metrics.maximum_capture_to_uplink_us,
          bounded);
    }
  } else {
    /*
     * Never retry a rejected frame. The bridge also destroys the clean suffix
     * from the same DSP result, and pcm_lane asks its network consumer to
     * purge the old epoch. Recovered connectivity therefore resumes at "now"
     * instead of draining speech captured during the outage.
     */
    atomic_saturating_increment(
        &state->metrics.clean_uplink_drops);
  }
  return status;
}

static bool IRAM_ATTR i2s_tap(
    bool transmit,
    uint32_t sequence,
    uint64_t completed_at_us,
    const void *pcm,
    size_t bytes,
    void *user_data) {
  struct core_s3_audio_owner *const state = user_data;
  if (state == NULL || transmit ||
      __atomic_load_n(
          &state->capture_tap_enabled, __ATOMIC_ACQUIRE) == 0U) {
    return false;
  }

  /*
   * The interrupt does exactly one bounded raw 1,024-byte copy. Four-slot
   * deinterleave and every DSP operation stay in the AEC task. This is more
   * internal RAM than the tempting two-channel ISR copy, but it makes callback
   * work fixed and auditably small while preserving all slots for physical
   * mapping diagnostics.
   */
  (void)iterate_kit_core_s3_capture_reserve_push_raw(
      &state->capture_reserve,
      sequence,
      completed_at_us,
      pcm,
      bytes);
  BaseType_t higher_priority_task_woken = pdFALSE;
  vTaskNotifyGiveFromISR(
      state->aec_task, &higher_priority_task_woken);
  return higher_priority_task_woken == pdTRUE;
}

static void wait_until_running(void) {
  while (__atomic_load_n(&owner.running, __ATOMIC_ACQUIRE) == 0U) {
    (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
  }
}

static void deinterleave_capture(
    const struct iterate_kit_core_s3_capture_chunk *chunk) {
  for (size_t frame = 0U;
       frame < ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES;
       ++frame) {
    const size_t base =
        frame * ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT;
    for (size_t slot = 0U;
         slot < ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT;
         ++slot) {
      const int32_t sample = chunk->interleaved[base + slot];
      const uint32_t magnitude = sample < 0
          ? (uint32_t)(-sample)
          : (uint32_t)sample;
      atomic_note_maximum(
          &owner.metrics.tdm_slot_peak[slot], magnitude);
    }
    owner.near_dma[frame] =
        chunk->interleaved[base + CORE_S3_TDM_NEAR_SLOT];
    owner.reference_dma[frame] =
        chunk->interleaved[base + CORE_S3_TDM_REFERENCE_SLOT];
  }
  atomic_saturating_increment(
      &owner.metrics.capture_chunks_deinterleaved);
}

static void aec_task_main(void *context) {
  (void)context;
  wait_until_running();

  for (;;) {
    (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    /*
     * One wake drains at most the entire static reserve. Bounding each pass
     * prevents a producer which stays just ahead from turning this into an
     * infinite lower-priority loop. Any later notifications remain sticky.
     */
    for (size_t attempt = 0U;
         attempt < ITERATE_KIT_CORE_S3_CAPTURE_RESERVE_CHUNKS;
         ++attempt) {
      const enum iterate_kit_core_s3_capture_take_result result =
          iterate_kit_core_s3_capture_reserve_take(
              &owner.capture_reserve, &owner.capture_chunk);
      if (result == ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY) {
        break;
      }
      if (result == ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH) {
        if (iterate_kit_aec_capture_bridge_reset(
                &owner.capture_bridge) != ITERATE_KIT_OK) {
          atomic_saturating_increment(
              &owner.metrics.capture_bridge_errors);
          mirror_capture_bridge_metrics();
          vTaskSuspend(NULL);
        }
        mirror_capture_bridge_metrics();
        continue;
      }

      deinterleave_capture(&owner.capture_chunk);
      const enum iterate_kit_status bridge_status =
          iterate_kit_aec_capture_bridge_push_aligned(
              &owner.capture_bridge,
              owner.capture_chunk.sequence,
              owner.capture_chunk.captured_through_at_us,
              owner.near_dma,
              owner.reference_dma,
              ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES);
      if (bridge_status != ITERATE_KIT_OK &&
          bridge_status != ITERATE_KIT_BACKPRESSURE) {
        atomic_saturating_increment(
            &owner.metrics.capture_bridge_errors);
      }
      mirror_capture_bridge_metrics();
    }
  }
}

static void apply_playback_reset_if_requested(void) {
  if (__atomic_exchange_n(
          &owner.playback_reset_requested,
          0U,
          __ATOMIC_ACQUIRE) == 0U) {
    return;
  }
  uint32_t discarded_frames = 0U;
  const enum iterate_kit_status playback_status =
      iterate_kit_pcm_clock_playback_reset(&owner.playback);
  const enum iterate_kit_status lane_status =
      iterate_kit_pcm_lane_discard_downlink(
          owner.lane, &discarded_frames);
  if (playback_status != ITERATE_KIT_OK ||
      lane_status != ITERATE_KIT_OK) {
    atomic_saturating_increment(
        &owner.metrics.playback_policy_errors);
  }
  atomic_saturating_increment(&owner.metrics.playback_resets);
  atomic_saturating_add(
      &owner.metrics.downlink_frames_discarded_by_reset,
      discarded_frames);
}

static void note_codec_timing(
    volatile uint32_t *last,
    volatile uint32_t *maximum,
    int64_t started_at_us) {
  const uint32_t elapsed = monotonic_us_since(started_at_us);
  __atomic_store_n(last, elapsed, __ATOMIC_RELAXED);
  atomic_note_maximum(maximum, elapsed);
}

static void io_task_main(void *context) {
  (void)context;
  wait_until_running();

  /*
   * Channels run before this task. Draining exactly the configured five DMA
   * descriptors abandons startup history before capture publication begins;
   * otherwise a perfectly healthy first uplink frame can start 40 ms old and
   * make that offset permanent. Speaker DMA auto-clear emits silence here.
   */
  for (size_t chunk = 0U;
       chunk < CORE_S3_RX_STARTUP_DRAIN_CHUNKS;
       ++chunk) {
    if (esp_codec_dev_read(
            owner.microphone,
            owner.capture_drain,
            (int)sizeof(owner.capture_drain)) != ESP_CODEC_DEV_OK) {
      atomic_saturating_increment(
          &owner.metrics.codec_read_errors);
      break;
    }
  }
  iterate_kit_core_s3_i2s_stats_t startup_stats = {0};
  iterate_kit_core_s3_i2s_stats_snapshot(&startup_stats);
  owner.last_rx_queue_overflows = startup_stats.rx_queue_overflows;
  __atomic_store_n(
      &owner.capture_tap_enabled, 1U, __ATOMIC_RELEASE);

  uint32_t consecutive_write_errors = 0U;
  uint32_t consecutive_read_errors = 0U;
  bool speaker_io_enabled = true;
  bool microphone_io_enabled = true;
  for (;;) {
    apply_playback_reset_if_requested();

    if (speaker_io_enabled) {
      struct iterate_kit_pcm_clock_playback_result result;
      const enum iterate_kit_status render_status =
          iterate_kit_pcm_clock_playback_render(
              &owner.playback,
              monotonic_ms(),
              owner.playback_dma,
              ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES,
              &result);
      atomic_saturating_add(
          &owner.metrics.playback_content_samples,
          result.content_samples);
      atomic_saturating_add(
          &owner.metrics.playback_silence_samples,
          result.silence_samples);
      if (render_status != ITERATE_KIT_OK) {
        atomic_saturating_increment(
            &owner.metrics.playback_policy_errors);
      }
      const struct iterate_kit_pcm_clock_playback_metrics *playback_metrics =
          iterate_kit_pcm_clock_playback_metrics(&owner.playback);
      if (playback_metrics != NULL) {
        __atomic_store_n(
            &owner.metrics.last_receive_to_render_ms,
            playback_metrics->last_receive_to_render_ms,
            __ATOMIC_RELAXED);
        atomic_note_maximum(
            &owner.metrics.maximum_receive_to_render_ms,
            playback_metrics->maximum_receive_to_render_ms);
      }

      const int64_t write_started_at_us = esp_timer_get_time();
      const int write_status = esp_codec_dev_write(
          owner.speaker,
          owner.playback_dma,
          (int)sizeof(owner.playback_dma));
      note_codec_timing(
          &owner.metrics.last_codec_write_us,
          &owner.metrics.maximum_codec_write_us,
          write_started_at_us);
      if (write_status == ESP_CODEC_DEV_OK) {
        consecutive_write_errors = 0U;
      } else {
        atomic_saturating_increment(
            &owner.metrics.codec_write_errors);
        if (consecutive_write_errors != UINT32_MAX) {
          ++consecutive_write_errors;
        }
        if (consecutive_write_errors >= CORE_S3_IO_FAILURE_LIMIT) {
          speaker_io_enabled = false;
          __atomic_store_n(
              &owner.playback_failed, 1U, __ATOMIC_RELEASE);
        }
      }
    }

    if (microphone_io_enabled) {
      const int64_t read_started_at_us = esp_timer_get_time();
      const int read_status = esp_codec_dev_read(
          owner.microphone,
          owner.capture_drain,
          (int)sizeof(owner.capture_drain));
      note_codec_timing(
          &owner.metrics.last_codec_read_us,
          &owner.metrics.maximum_codec_read_us,
          read_started_at_us);
      if (read_status == ESP_CODEC_DEV_OK) {
        consecutive_read_errors = 0U;
      } else {
        atomic_saturating_increment(
            &owner.metrics.codec_read_errors);
        if (consecutive_read_errors != UINT32_MAX) {
          ++consecutive_read_errors;
        }
        if (consecutive_read_errors >= CORE_S3_IO_FAILURE_LIMIT) {
          microphone_io_enabled = false;
          __atomic_store_n(
              &owner.capture_failed, 1U, __ATOMIC_RELEASE);
          __atomic_store_n(
              &owner.capture_tap_enabled, 0U, __ATOMIC_RELEASE);
        }
      }
    }

    iterate_kit_core_s3_i2s_stats_t i2s = {0};
    iterate_kit_core_s3_i2s_stats_snapshot(&i2s);
    if (i2s.rx_queue_overflows != owner.last_rx_queue_overflows) {
      owner.last_rx_queue_overflows = i2s.rx_queue_overflows;
      iterate_kit_core_s3_capture_reserve_note_discontinuity(
          &owner.capture_reserve);
      xTaskNotifyGive(owner.aec_task);
    }
    atomic_saturating_increment(&owner.metrics.io_cycles);

    if (!speaker_io_enabled && !microphone_io_enabled) {
      /*
       * With both blocking codec clocks gone, continuing would become a tight
       * priority-23 error loop. Suspend permanently: bounded fail-closed state
       * is observable, and a higher layer may reboot rather than hiding a
       * broken peripheral behind retries.
       */
      vTaskSuspend(NULL);
    }
  }
}

static bool valid_options(
    const struct iterate_kit_core_s3_audio_owner_options *options) {
  return options != NULL &&
      options->lane != NULL && options->lane->initialized &&
      options->maximum_downlink_frame_age_ms > 0U &&
      options->maximum_lane_items_per_dma_chunk > 0U &&
      options->speaker_volume_percent >= 0 &&
      options->speaker_volume_percent <= 100 &&
      options->microphone_gain_db >= 0 &&
      options->microphone_gain_db <= 37;
}

esp_err_t iterate_kit_core_s3_audio_owner_start(
    const struct iterate_kit_core_s3_audio_owner_options *options) {
  if (!valid_options(options)) {
    return ESP_ERR_INVALID_ARG;
  }
  uint32_t expected = 0U;
  if (!__atomic_compare_exchange_n(
          &owner.started,
          &expected,
          1U,
          false,
          __ATOMIC_ACQ_REL,
          __ATOMIC_ACQUIRE)) {
    return ESP_ERR_INVALID_STATE;
  }

  owner.lane = options->lane;
  owner.speaker_volume_percent = options->speaker_volume_percent;
  owner.microphone_gain_db = options->microphone_gain_db;
  if (iterate_kit_core_s3_capture_reserve_init(
          &owner.capture_reserve) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_pcm_clock_playback_options playback_options = {
      .lane = owner.lane,
      .retained_frame = owner.retained_downlink,
      .retained_frame_capacity =
          ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
      .maximum_frame_age_ms =
          options->maximum_downlink_frame_age_ms,
      .maximum_lane_items_per_render =
          options->maximum_lane_items_per_dma_chunk,
  };
  if (iterate_kit_pcm_clock_playback_init(
          &owner.playback, &playback_options) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }

  owner.aec = create_aec();
  if (owner.aec == NULL) {
    __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
    return ESP_ERR_NO_MEM;
  }
  const struct iterate_kit_aec_capture_bridge_options bridge_options = {
      .sample_rate_hz = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
      .processing_frame_samples =
          ITERATE_KIT_CORE_S3_AEC_FRAME_SAMPLES,
      .egress_frame_samples =
          ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
      .near_frame = owner.aec_near,
      .reference_frame = owner.aec_reference,
      .clean_frame = owner.aec_clean,
      .processing_frame_capacity =
          ITERATE_KIT_CORE_S3_AEC_FRAME_SAMPLES,
      .egress_frame = owner.clean_egress,
      .egress_frame_capacity =
          ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
      .processor_context = &owner,
      .process = process_aec,
      .reset_processor = reset_aec,
      .egress_context = &owner,
      .copy_egress = copy_clean_uplink,
  };
  if (iterate_kit_aec_capture_bridge_init(
          &owner.capture_bridge,
          &bridge_options) != ITERATE_KIT_OK) {
    aec_destroy(owner.aec);
    owner.aec = NULL;
    return ESP_ERR_INVALID_STATE;
  }

  owner.io_task = xTaskCreateStaticPinnedToCore(
      io_task_main,
      "core-s3-io",
      sizeof(owner.io_stack),
      NULL,
      CORE_S3_IO_TASK_PRIORITY,
      owner.io_stack,
      &owner.io_task_control,
      CORE_S3_AUDIO_TASK_CORE);
  owner.aec_task = xTaskCreateStaticPinnedToCore(
      aec_task_main,
      "core-s3-aec",
      sizeof(owner.aec_stack),
      NULL,
      CORE_S3_AEC_TASK_PRIORITY,
      owner.aec_stack,
      &owner.aec_task_control,
      CORE_S3_AUDIO_TASK_CORE);
  if (owner.io_task == NULL || owner.aec_task == NULL) {
    __atomic_store_n(&owner.playback_failed, 1U, __ATOMIC_RELEASE);
    __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
    return ESP_ERR_NO_MEM;
  }

  const esp_err_t codec_status = initialize_codecs();
  if (codec_status != ESP_OK) {
    __atomic_store_n(&owner.playback_failed, 1U, __ATOMIC_RELEASE);
    __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
    return codec_status;
  }

  /*
   * Install the ISR handoff only after both task handles and codecs exist.
   * Until the IO task drains startup DMA it leaves capture_tap_enabled false;
   * the callback remains a constant-time no-op rather than publishing history.
   */
  iterate_kit_core_s3_i2s_set_tap(i2s_tap, &owner);
  __atomic_store_n(&owner.running, 1U, __ATOMIC_RELEASE);
  __atomic_store_n(&owner.ready, 1U, __ATOMIC_RELEASE);
  xTaskNotifyGive(owner.io_task);
  xTaskNotifyGive(owner.aec_task);

  ESP_LOGI(
      TAG,
      "ready: 16 kHz; DMA=5x128 (40 ms); raw reserve=8x1024 "
      "(64 ms); AEC=512; wire=320; static owner=%u bytes",
      (unsigned)sizeof(owner));
  ESP_LOGI(
      TAG,
      "measured TDM mapping: slot0=MIC1 near %d dB, "
      "slot1=MIC3 actual-speaker reference 0 dB",
      owner.microphone_gain_db);
  return ESP_OK;
}

void iterate_kit_core_s3_audio_owner_request_playback_reset(void) {
  if (__atomic_load_n(&owner.started, __ATOMIC_ACQUIRE) == 0U) {
    return;
  }
  __atomic_store_n(
      &owner.playback_reset_requested, 1U, __ATOMIC_RELEASE);
}

void iterate_kit_core_s3_audio_owner_metrics_snapshot(
    struct iterate_kit_core_s3_audio_owner_metrics *snapshot) {
  if (snapshot == NULL) {
    return;
  }
  memset(snapshot, 0, sizeof(*snapshot));
  snapshot->ready = atomic_load(&owner.ready) != 0U;
  snapshot->playback_failed =
      atomic_load(&owner.playback_failed) != 0U;
  snapshot->capture_failed =
      atomic_load(&owner.capture_failed) != 0U;
  snapshot->sample_rate_hz =
      ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ;
  snapshot->dma_frame_samples =
      ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES;
  snapshot->dma_descriptor_count =
      CORE_S3_DMA_DESCRIPTOR_COUNT;
  snapshot->configured_dma_reserve_ms =
      CORE_S3_DMA_DESCRIPTOR_COUNT *
      ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES * 1000U /
      ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ;
  snapshot->static_owner_bytes = sizeof(owner);
  iterate_kit_core_s3_i2s_stats_snapshot(&snapshot->i2s);
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &owner.capture_reserve, &snapshot->capture_reserve);
  if (owner.lane != NULL) {
    iterate_kit_pcm_lane_metrics(owner.lane, &snapshot->lane);
  }

#define COPY_ATOMIC_METRIC(name) \
  snapshot->name = atomic_load(&owner.metrics.name)
  COPY_ATOMIC_METRIC(io_cycles);
  COPY_ATOMIC_METRIC(codec_write_errors);
  COPY_ATOMIC_METRIC(codec_read_errors);
  COPY_ATOMIC_METRIC(playback_policy_errors);
  COPY_ATOMIC_METRIC(playback_content_samples);
  COPY_ATOMIC_METRIC(playback_silence_samples);
  COPY_ATOMIC_METRIC(playback_resets);
  COPY_ATOMIC_METRIC(downlink_frames_discarded_by_reset);
  COPY_ATOMIC_METRIC(last_codec_write_us);
  COPY_ATOMIC_METRIC(maximum_codec_write_us);
  COPY_ATOMIC_METRIC(last_codec_read_us);
  COPY_ATOMIC_METRIC(maximum_codec_read_us);
  COPY_ATOMIC_METRIC(last_receive_to_render_ms);
  COPY_ATOMIC_METRIC(maximum_receive_to_render_ms);
  COPY_ATOMIC_METRIC(capture_chunks_deinterleaved);
  COPY_ATOMIC_METRIC(capture_bridge_errors);
  COPY_ATOMIC_METRIC(aec_frames);
  COPY_ATOMIC_METRIC(aec_recreates);
  COPY_ATOMIC_METRIC(aec_recreate_failures);
  COPY_ATOMIC_METRIC(last_aec_linear_us);
  COPY_ATOMIC_METRIC(maximum_aec_linear_us);
  COPY_ATOMIC_METRIC(last_aec_nlp_us);
  COPY_ATOMIC_METRIC(maximum_aec_nlp_us);
  COPY_ATOMIC_METRIC(clean_uplink_frames);
  COPY_ATOMIC_METRIC(clean_uplink_drops);
  COPY_ATOMIC_METRIC(last_capture_to_uplink_us);
  COPY_ATOMIC_METRIC(maximum_capture_to_uplink_us);
  COPY_ATOMIC_METRIC(aec_input_partial_samples);
  COPY_ATOMIC_METRIC(clean_egress_partial_samples);
#undef COPY_ATOMIC_METRIC
  for (size_t slot = 0U;
       slot < ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT;
       ++slot) {
    snapshot->tdm_slot_peak[slot] =
        atomic_load(&owner.metrics.tdm_slot_peak[slot]);
  }

  if (owner.io_task != NULL) {
    snapshot->io_stack_minimum_free_bytes =
        (uint32_t)uxTaskGetStackHighWaterMark(owner.io_task);
  }
  if (owner.aec_task != NULL) {
    snapshot->aec_stack_minimum_free_bytes =
        (uint32_t)uxTaskGetStackHighWaterMark(owner.aec_task);
  }
  snapshot->internal_heap_free_bytes = (uint32_t)heap_caps_get_free_size(
      MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  snapshot->internal_heap_largest_block_bytes =
      (uint32_t)heap_caps_get_largest_free_block(
          MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  snapshot->psram_heap_free_bytes = (uint32_t)heap_caps_get_free_size(
      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  snapshot->psram_heap_largest_block_bytes =
      (uint32_t)heap_caps_get_largest_free_block(
          MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}
