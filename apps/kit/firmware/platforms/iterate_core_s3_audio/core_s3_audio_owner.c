#include "iterate/kit/platforms/core_s3_audio_owner.h"

#include <limits.h>
#include <string.h>

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
#include "iterate/kit/aec_reference_scaler.h"
#include "iterate/kit/aec_uplink_selector.h"
#include "iterate/kit/pcm_high_pass.h"

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
/*
 * Userspace authorizes a finite twelve-item lead, but those WebSocket messages
 * arrive at the device one by one. Holding eight complete ordered items before
 * the first codec edge leaves four items of transport headroom and 160 ms of
 * local playback runway. The shared playback core bypasses this for a complete
 * shorter response and never tries to refill the watermark mid-response.
 */
#define CORE_S3_PLAYBACK_STARTUP_ITEMS 8U
#define CORE_S3_AEC_SIGNAL_SAMPLE_STRIDE 7U
#define CORE_S3_AEC_SIGNAL_WINDOW_US UINT64_C(1000000)
/*
 * Keep AEC output for eight 16 ms frames after digital playback becomes zero.
 * This covers 128 ms of loudspeaker/enclosure tail without adding a PCM queue
 * or delaying the microphone. Outside that interval the raw mic is used:
 * retained physical evidence showed the VOIP residual suppressor removing
 * 92--99% of near-only speech while its exact reference was already zero.
 */
#define CORE_S3_AEC_UPLINK_HANGOVER_FRAMES 8U
#define CORE_S3_AEC_REFERENCE_SCALE_MULTIPLIER 8U
#define CORE_S3_NEAR_HIGH_PASS_DECAY_Q15 31506U
#define CORE_S3_TDM_NEAR_SLOT 2U
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
  volatile uint32_t playback_underrun_incidents;
  volatile uint32_t playback_underrun_silence_samples;
  volatile uint32_t playback_stale_frames_discarded;
  volatile uint32_t playout_observer_frames;
  volatile uint32_t playout_observer_shape_errors;

  volatile uint32_t capture_chunks_deinterleaved;
  volatile uint32_t tdm_slot_peak[ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT];
  volatile uint32_t capture_chunks_with_playback_content;
  volatile uint32_t capture_chunks_without_playback_content;
  volatile uint32_t capture_bridge_errors;
  volatile uint32_t aec_frames;
  volatile uint32_t aec_recreates;
  volatile uint32_t aec_recreate_failures;
  volatile uint32_t last_aec_process_us;
  volatile uint32_t maximum_aec_process_us;
  volatile uint32_t last_capture_to_uplink_us;
  volatile uint32_t maximum_capture_to_uplink_us;
  volatile uint32_t aec_signal_measurement_failures;
  volatile uint32_t near_high_pass_clipped_samples;
  volatile uint32_t reference_scale_clipped_samples;
  volatile uint32_t uplink_gain_clipped_samples;
  volatile uint32_t aec_input_partial_samples;
  volatile uint32_t clean_egress_partial_samples;
  volatile uint32_t capture_turn_poll_failures;
};

struct core_s3_audio_owner {
  struct iterate_kit_pcm_lane *lane;
  esp_codec_dev_handle_t speaker;
  esp_codec_dev_handle_t microphone;
  aec_handle_t *aec;

  struct iterate_kit_core_s3_capture_reserve capture_reserve;
  struct iterate_kit_core_s3_capture_chunk capture_chunk;
  struct iterate_kit_pcm_clock_playback playback;
  struct iterate_kit_pcm_capture_turn capture_turn;
  struct iterate_kit_pcm_generation_fence generation_fence;
  struct iterate_kit_pcm_playback_interruption playback_interruption;
  struct iterate_kit_aec_capture_bridge capture_bridge;
  struct iterate_kit_aec_uplink_selector uplink_selector;
  struct iterate_kit_aec_diagnostic_trace *diagnostic_trace;
  struct iterate_kit_pcm_high_pass near_high_pass;
  iterate_kit_core_s3_playout_observer_fn observe_playout;
  void *observe_playout_context;

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
  int16_t playback_activity_dma[ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t aec_near[ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t aec_reference[ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t aec_playout[ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t aec_clean[ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t clean_egress[ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME]
      __attribute__((aligned(16)));
  struct iterate_kit_aec_signal_window current_aec_signal_window;
  struct iterate_kit_aec_signal_window latest_aec_signal_window;
  uint64_t current_aec_signal_started_at_us;
  uint64_t latest_aec_signal_started_at_us;
  uint64_t latest_aec_signal_produced_at_us;
  uint32_t latest_aec_signal_sequence;

  StaticTask_t io_task_control;
  StaticTask_t aec_task_control;
  StackType_t io_stack[CORE_S3_IO_STACK_BYTES] __attribute__((aligned(16)));
  StackType_t aec_stack[CORE_S3_AEC_STACK_BYTES] __attribute__((aligned(16)));
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
  /*
   * The I/O task renders/writes one speaker edge before it reads the matching
   * microphone edge. The RX callback snapshots this bit into reserve-owned
   * metadata. It never waits on a TX callback, so a failed speaker path cannot
   * stop microphone capture or manufacture a backlog.
   */
  volatile uint32_t playback_content_active;
  uint32_t last_rx_queue_overflows;
  uint32_t last_tx_queue_overflows;
  int speaker_volume_percent;
  int microphone_gain_db;
  int reference_gain_db;
  enum iterate_kit_core_s3_aec_profile aec_profile;
  size_t aec_frame_samples;
  uint64_t reference_scale_clipped_samples;
  uint32_t diagnostic_frame_sequence;
};

/*
 * Every ISR-visible sample, both task stacks, and every intermediary frame are
 * one link-visible internal-DRAM object. That is less flexible than heap
 * allocation but makes the exact realtime reservation visible in the map file
 * and prevents PSRAM/cache stalls from entering the DMA callback path.
 */
static DRAM_ATTR struct core_s3_audio_owner owner __attribute__((aligned(16)));

/*
 * The AEC task on core 1 is the only writer; the low-rate Cap'n Web owner may
 * snapshot on the other core. A FreeRTOS spinlock is preferable to seven
 * independent atomic exchanges: exchanging fields one by one can split one
 * DSP frame across adjacent windows and fabricate a suppression ratio. Both
 * sides hold this lock for a fixed seven-scalar merge/copy only. Sample walking
 * and division are explicitly outside it.
 */
static portMUX_TYPE aec_signal_window_mux = portMUX_INITIALIZER_UNLOCKED;

static uint32_t monotonic_us_since(int64_t started_at_us) {
  const int64_t elapsed = esp_timer_get_time() - started_at_us;
  if (elapsed <= 0) {
    return 0U;
  }
  return (uint64_t)elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed;
}

static uint64_t monotonic_ms(void) {
  const int64_t now_us = esp_timer_get_time();
  return now_us <= 0 ? 0U : (uint64_t)now_us / 1000U;
}

static void atomic_saturating_increment(volatile uint32_t *value) {
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX &&
         !__atomic_compare_exchange_n(value,
                                      &current,
                                      current + 1U,
                                      false,
                                      __ATOMIC_RELAXED,
                                      __ATOMIC_RELAXED)) {
  }
}

static void atomic_saturating_add(volatile uint32_t *value, size_t amount) {
#if SIZE_MAX > UINT32_MAX
  const uint32_t bounded_amount =
      amount > UINT32_MAX ? UINT32_MAX : (uint32_t)amount;
#else
  const uint32_t bounded_amount = (uint32_t)amount;
#endif
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX) {
    const uint32_t next = bounded_amount > UINT32_MAX - current
                              ? UINT32_MAX
                              : current + bounded_amount;
    if (__atomic_compare_exchange_n(
            value, &current, next, false, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {
      return;
    }
  }
}

static void atomic_note_maximum(volatile uint32_t *maximum,
                                uint32_t candidate) {
  uint32_t current = __atomic_load_n(maximum, __ATOMIC_RELAXED);
  while (candidate > current &&
         !__atomic_compare_exchange_n(maximum,
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

/*
 * These two counters have exactly one I2S-ISR writer. A compare/exchange loop
 * would add an unbounded retry shape to the most timing-sensitive callback for
 * no ownership benefit; diagnostics only performs atomic loads.
 */
static void IRAM_ATTR isr_saturating_increment(volatile uint32_t *value) {
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

static void merge_aec_signal_observation(
    struct core_s3_audio_owner *state,
    const struct iterate_kit_aec_signal_window *observation,
    uint64_t observed_at_us) {
  portENTER_CRITICAL(&aec_signal_window_mux);
  if (state->current_aec_signal_started_at_us == 0U) {
    state->current_aec_signal_started_at_us = observed_at_us;
  }
  if (observed_at_us >= state->current_aec_signal_started_at_us &&
      observed_at_us - state->current_aec_signal_started_at_us >=
          CORE_S3_AEC_SIGNAL_WINDOW_US &&
      state->current_aec_signal_window.sampled_samples != 0U) {
    /*
     * Rotation is driven by the continuous audio clock, not by a subscriber.
     * Thus a slow callback merely misses old latest-state windows; it cannot
     * accumulate telemetry or change the boundaries seen by realtime code.
     */
    iterate_kit_aec_signal_window_take(&state->current_aec_signal_window,
                                       &state->latest_aec_signal_window);
    state->latest_aec_signal_started_at_us =
        state->current_aec_signal_started_at_us;
    state->latest_aec_signal_produced_at_us = observed_at_us;
    if (state->latest_aec_signal_sequence != UINT32_MAX) {
      ++state->latest_aec_signal_sequence;
    }
    state->current_aec_signal_started_at_us = observed_at_us;
  }
  iterate_kit_aec_signal_window_merge(&state->current_aec_signal_window,
                                      observation);
  portEXIT_CRITICAL(&aec_signal_window_mux);
}

static void mirror_capture_bridge_metrics(void) {
  const struct iterate_kit_aec_capture_bridge_metrics *metrics =
      iterate_kit_aec_capture_bridge_metrics(&owner.capture_bridge);
  if (metrics == NULL) {
    return;
  }
  const uint32_t input_partial = metrics->input_partial_samples > UINT32_MAX
                                     ? UINT32_MAX
                                     : (uint32_t)metrics->input_partial_samples;
  const uint32_t egress_partial =
      metrics->egress_partial_samples > UINT32_MAX
          ? UINT32_MAX
          : (uint32_t)metrics->egress_partial_samples;
  __atomic_store_n(&owner.metrics.aec_input_partial_samples,
                   input_partial,
                   __ATOMIC_RELAXED);
  __atomic_store_n(&owner.metrics.clean_egress_partial_samples,
                   egress_partial,
                   __ATOMIC_RELAXED);
}

static esp_err_t configure_speaker_for_shared_tdm_clock(void) {
  int value = 0;
  if (esp_codec_dev_read_reg(owner.speaker,
                             CORE_S3_AW88298_I2SCTRL_REG,
                             &value) != ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  value = (value & ~CORE_S3_AW88298_I2SBCK_MASK) | CORE_S3_AW88298_I2SBCK_64FS;
  if (esp_codec_dev_write_reg(owner.speaker,
                              CORE_S3_AW88298_I2SCTRL_REG,
                              value) != ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  int verified = 0;
  if (esp_codec_dev_read_reg(owner.speaker,
                             CORE_S3_AW88298_I2SCTRL_REG,
                             &verified) != ESP_CODEC_DEV_OK ||
      (verified & CORE_S3_AW88298_I2SBCK_MASK) != CORE_S3_AW88298_I2SBCK_64FS) {
    return ESP_FAIL;
  }
  return ESP_OK;
}

static esp_err_t initialize_codecs(void) {
  /*
   * TX remains ordinary Philips stereo for AW88298. RX is four-slot TDM for
   * ES7210: measured slots 0 and 2 are the two acoustic microphones, while
   * measured slot 1 is the analogue divider across actual speaker output.
   * Using the latter—not a software copy of intended playback—keeps the AEC
   * reference aligned with
   * what the amplifier really emitted, including mute/gain/clock effects.
   *
   * Interval telemetry establishes those output slots, but neither M5Stack's
   * public schematic nor the codec API establishes TDM order. A retained
   * production capture from slot 0 has a broad 4.5–5.7 kHz interference shelf
   * that changes "Hey pal" into "PayPal" at the independent STT oracle. Slot 2
   * is the other acoustic capsule and is therefore the production near channel
   * while this physical comparison is made. Both acoustic inputs receive the
   * same gain below; the speaker divider alone stays at reference gain. Keeping
   * the choice as one named constant means the experiment changes no queue,
   * AEC, transport, or provider behavior and can be reverted from retained
   * evidence instead of accumulating a compensating filter around a bad mic.
   */
  const i2s_std_config_t tx = {
      .clk_cfg =
          I2S_STD_CLK_DEFAULT_CONFIG(ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ),
      .slot_cfg =
          {
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
      .gpio_cfg =
          {
              .mclk = BSP_I2S_MCLK,
              .bclk = BSP_I2S_SCLK,
              .ws = BSP_I2S_LCLK,
              .dout = BSP_I2S_DOUT,
              .din = I2S_GPIO_UNUSED,
              .invert_flags =
                  {
                      .mclk_inv = false,
                      .bclk_inv = false,
                      .ws_inv = false,
                  },
          },
  };
  const i2s_tdm_config_t rx = {
      .clk_cfg =
          {
              .sample_rate_hz = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
              .clk_src = I2S_CLK_SRC_DEFAULT,
              .ext_clk_freq_hz = 0,
              .mclk_multiple = I2S_MCLK_MULTIPLE_256,
              .bclk_div = 8,
          },
      .slot_cfg =
          {
              .data_bit_width = I2S_DATA_BIT_WIDTH_16BIT,
              .slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO,
              .slot_mode = I2S_SLOT_MODE_STEREO,
              .slot_mask =
                  I2S_TDM_SLOT0 | I2S_TDM_SLOT1 | I2S_TDM_SLOT2 | I2S_TDM_SLOT3,
              .ws_width = I2S_TDM_AUTO_WS_WIDTH,
              .ws_pol = false,
              .bit_shift = true,
              .left_align = false,
              .big_endian = false,
              .bit_order_lsb = false,
              .skip_mask = false,
              .total_slot = I2S_TDM_AUTO_SLOT_NUM,
          },
      .gpio_cfg =
          {
              .mclk = BSP_I2S_MCLK,
              .bclk = BSP_I2S_SCLK,
              .ws = BSP_I2S_LCLK,
              .dout = I2S_GPIO_UNUSED,
              .din = BSP_I2S_DSIN,
              .invert_flags =
                  {
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
      .count = sizeof(speaker_volume_map) / sizeof(speaker_volume_map[0]),
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
  if (esp_codec_dev_set_vol_curve(owner.speaker, &curve) != ESP_CODEC_DEV_OK ||
      esp_codec_dev_set_out_vol(owner.speaker, owner.speaker_volume_percent) !=
          ESP_CODEC_DEV_OK ||
      esp_codec_dev_open(owner.speaker, &speaker_format) != ESP_CODEC_DEV_OK ||
      esp_codec_dev_open(owner.microphone, &microphone_format) !=
          ESP_CODEC_DEV_OK ||
      configure_speaker_for_shared_tdm_clock() != ESP_OK ||
      esp_codec_dev_set_in_channel_gain(owner.microphone,
                                        ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0) |
                                            ESP_CODEC_DEV_MAKE_CHANNEL_MASK(1),
                                        (float)owner.microphone_gain_db) !=
          ESP_CODEC_DEV_OK ||
      esp_codec_dev_set_in_channel_gain(owner.microphone,
                                        ESP_CODEC_DEV_MAKE_CHANNEL_MASK(2),
                                        (float)owner.reference_gain_db) !=
          ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  return ESP_OK;
}

size_t iterate_kit_core_s3_aec_processing_frame_samples(
    enum iterate_kit_core_s3_aec_profile profile) {
  switch (profile) {
    case ITERATE_KIT_CORE_S3_AEC_VOIP_SELECTOR:
    case ITERATE_KIT_CORE_S3_AEC_VOIP_CONSTANT:
    case ITERATE_KIT_CORE_S3_AEC_VOIP_LINEAR_CONSTANT:
      return ITERATE_KIT_CORE_S3_AEC_VOIP_FRAME_SAMPLES;
    case ITERATE_KIT_CORE_S3_AEC_FD_NORMAL_CONSTANT:
    case ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_CONSTANT:
    case ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_LINEAR_CONSTANT:
      return ITERATE_KIT_CORE_S3_AEC_FD_FRAME_SAMPLES;
  }
  return 0U;
}

static bool aec_profile_uses_constant_processed(
    enum iterate_kit_core_s3_aec_profile profile) {
  return profile == ITERATE_KIT_CORE_S3_AEC_FD_NORMAL_CONSTANT ||
         profile == ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_CONSTANT ||
         profile == ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_LINEAR_CONSTANT ||
         profile == ITERATE_KIT_CORE_S3_AEC_VOIP_CONSTANT ||
         profile == ITERATE_KIT_CORE_S3_AEC_VOIP_LINEAR_CONSTANT;
}

static bool aec_profile_uses_linear_output(
    enum iterate_kit_core_s3_aec_profile profile) {
  return profile == ITERATE_KIT_CORE_S3_AEC_VOIP_LINEAR_CONSTANT ||
         profile == ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_LINEAR_CONSTANT;
}

static aec_mode_t aec_mode_for_profile(
    enum iterate_kit_core_s3_aec_profile profile) {
  switch (profile) {
    case ITERATE_KIT_CORE_S3_AEC_FD_NORMAL_CONSTANT:
      return AEC_MODE_FD_LOW_COST;
    case ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_CONSTANT:
    case ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_LINEAR_CONSTANT:
      return AEC_MODE_FD_HIGH_PERF;
    case ITERATE_KIT_CORE_S3_AEC_VOIP_SELECTOR:
    case ITERATE_KIT_CORE_S3_AEC_VOIP_CONSTANT:
    case ITERATE_KIT_CORE_S3_AEC_VOIP_LINEAR_CONSTANT:
      return AEC_MODE_VOIP_HIGH_PERF;
  }
  return AEC_MODE_VOIP_HIGH_PERF;
}

static aec_nlp_level_t aec_nlp_for_profile(
    enum iterate_kit_core_s3_aec_profile profile) {
  /*
   * NORMAL is intentional for the FD experiment: Espressif warns that more
   * aggressive NLP can damage near speech during double-talk. The retained
   * VOIP control stays AGGR so this experiment does not silently retune both
   * sides at once; ESP-SR 2.4.7 ignores that field in VOIP mode anyway.
   */
  return profile == ITERATE_KIT_CORE_S3_AEC_FD_NORMAL_CONSTANT ||
                 profile == ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_CONSTANT ||
                 profile ==
                     ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_LINEAR_CONSTANT
             ? AEC_NLP_LEVEL_NORMAL
             : AEC_NLP_LEVEL_AGGR;
}

static aec_handle_t *create_aec(const struct core_s3_audio_owner *state) {
  if (state == NULL || state->aec_frame_samples == 0U) {
    return NULL;
  }
  aec_config_t config = {
      .mic_num = 1,
      .ref_num = 1,
      .out_num = 1,
      .filter_length = CORE_S3_AEC_FILTER_LENGTH,
      .sample_rate = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
      .caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT,
      .mode = aec_mode_for_profile(state->aec_profile),
      .nlp_level = aec_nlp_for_profile(state->aec_profile),
  };
  aec_handle_t *const aec = aec_create_from_config(&config);
  if (aec == NULL) {
    return NULL;
  }
  if (aec_get_chunksize(aec) != (int)state->aec_frame_samples) {
    /*
     * The bridge's static envelope is an executable contract, not a hint.
     * Running a future ESP-SR frame shape against a differently configured
     * bridge would be memory corruption; fail startup instead of truncating.
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

  if (state->diagnostic_trace != NULL) {
    /*
     * AEC recreation destroys filter history, so one trace must never span
     * this boundary. STATE_ERROR merely means no capture was active; it is
     * intentionally not a realtime failure or a reason to recreate twice.
     */
    (void)iterate_kit_aec_diagnostic_trace_abort(
        state->diagnostic_trace);
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
  state->aec = create_aec(state);
  if (state->aec == NULL) {
    atomic_saturating_increment(&state->metrics.aec_recreate_failures);
    __atomic_store_n(&state->capture_failed, 1U, __ATOMIC_RELEASE);
    __atomic_store_n(&state->capture_tap_enabled, 0U, __ATOMIC_RELEASE);
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status process_aec(void *context,
                                           const int16_t *near_samples,
                                           const int16_t *reference_samples,
                                           const int16_t *playout_samples,
                                           int16_t *clean_samples,
                                           size_t sample_count) {
  struct core_s3_audio_owner *const state = context;
  if (state == NULL || state->aec == NULL ||
      sample_count != state->aec_frame_samples) {
    return ITERATE_KIT_STATE_ERROR;
  }

  const int64_t process_started_at_us = esp_timer_get_time();
  /*
   * Profiles 4 and 6 are deliberately narrow experiments, not home-grown
   * AEC: each keeps its profile's adaptive filter, frame size, reference, and
   * cadence, but publishes ESP-SR's documented linear output before residual
   * nonlinear suppression. The physical profile-5 run opened provider VAD
   * during barge-in yet removed the first nearby words while far speech was
   * active; aligned device samples showed roughly 85-92% mean attenuation in
   * those windows. This call boundary tests whether that damage belongs to NLP
   * without changing transport or training the adaptive filter twice. Never
   * follow this branch with aec_process() or aec_nlp_process(): either would
   * turn a one-variable A/B into two passes over the same physical frame.
   */
  if (aec_profile_uses_linear_output(state->aec_profile)) {
    aec_linear_process(state->aec,
                       (int16_t *)near_samples,
                       (int16_t *)reference_samples,
                       clean_samples);
  } else {
    aec_process(state->aec,
                (int16_t *)near_samples,
                (int16_t *)reference_samples,
                clean_samples);
  }
  const uint32_t process_us = monotonic_us_since(process_started_at_us);

  /*
   * AEC runs on every frame, including far-end silence. The retained VOIP
   * control may select raw near speech outside playback because physical runs
   * proved its residual suppressor destructive there. The FD experiment uses
   * CONSTANT_PROCESSED, so this same call only applies one fixed gain and never
   * changes signal topology at playback edges. Neither policy queues or mutes.
   */
  /*
   * The selector's counter is owned by this AEC task. Mirror only its delta
   * into an atomic, saturating public counter after the call; reading the
   * uint64_t directly from the low-priority metrics task would be a torn
   * cross-core read on ESP32-S3.
   */
  const uint64_t selector_clipped_before =
      state->uplink_selector.clipped_samples;
  const enum iterate_kit_status selection_status =
      iterate_kit_aec_uplink_selector_process(&state->uplink_selector,
                                              near_samples,
                                              playout_samples,
                                              clean_samples,
                                              clean_samples,
                                              sample_count);
  if (state->uplink_selector.clipped_samples > selector_clipped_before) {
    const uint64_t delta =
        state->uplink_selector.clipped_samples - selector_clipped_before;
    atomic_saturating_add(&state->metrics.uplink_gain_clipped_samples,
                          delta > SIZE_MAX ? SIZE_MAX : (size_t)delta);
  }
  if (selection_status != ITERATE_KIT_OK) {
    return selection_status;
  }

  if (state->diagnostic_trace != NULL) {
    ++state->diagnostic_frame_sequence;
    const enum iterate_kit_status trace_status =
        iterate_kit_aec_diagnostic_trace_record(
            state->diagnostic_trace,
            state->diagnostic_frame_sequence,
            near_samples,
            reference_samples,
            NULL,
            NULL,
            clean_samples,
            sample_count);
    if (trace_status != ITERATE_KIT_OK &&
        trace_status != ITERATE_KIT_UNAVAILABLE) {
      /*
       * Evidence failure must remain out of the PCM decision path. The trace
       * state/counters retain the fault for the host; returning it here would
       * turn diagnostics pressure into microphone loss.
       */
    }
  }

  struct iterate_kit_aec_signal_window observation;
  const enum iterate_kit_status signal_status =
      iterate_kit_aec_signal_window_measure(near_samples,
                                            reference_samples,
                                            clean_samples,
                                            sample_count,
                                            CORE_S3_AEC_SIGNAL_SAMPLE_STRIDE,
                                            &observation);
  if (signal_status == ITERATE_KIT_OK) {
    const int64_t observed_at_us = esp_timer_get_time();
    merge_aec_signal_observation(
        state,
        &observation,
        observed_at_us < 0 ? 0U : (uint64_t)observed_at_us);
  } else {
    /*
     * `clean_samples` is now the signal actually selected for the wire, not an
     * internal AEC tap. This ordering keeps the once-per-second metrics useful
     * as an end-to-end oracle after undoing the profile-declared output gain.
     * Measuring
     * before selection would leave a green transport with telemetry describing
     * audio that Grok never received—the exact blind spot behind the delayed
     * “hey pal” incident.
     *
     * Instrumentation must never terminate or delay the audio graph, but it
     * also must not disappear. This counter invalidates any evidence window
     * whose aligned measurement unexpectedly failed.
     */
    atomic_saturating_increment(
        &state->metrics.aec_signal_measurement_failures);
  }

  atomic_saturating_increment(&state->metrics.aec_frames);
  __atomic_store_n(
      &state->metrics.last_aec_process_us, process_us, __ATOMIC_RELAXED);
  atomic_note_maximum(&state->metrics.maximum_aec_process_us, process_us);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status copy_clean_uplink(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us) {
  struct core_s3_audio_owner *const state = context;
  if (state == NULL || sample_count != ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME ||
      sample_rate_hz != ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  const bool publication_was_active =
      iterate_kit_pcm_capture_turn_is_active(&state->capture_turn);
  const enum iterate_kit_status status =
      iterate_kit_pcm_capture_turn_submit(&state->capture_turn,
                                          samples,
                                          sample_count,
                                          sample_rate_hz,
                                          captured_through_at_us);
  if (status == ITERATE_KIT_OK && publication_was_active) {
    const int64_t now_us = esp_timer_get_time();
    if (now_us >= 0 && (uint64_t)now_us >= captured_through_at_us) {
      const uint64_t elapsed = (uint64_t)now_us - captured_through_at_us;
      const uint32_t bounded =
          elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed;
      __atomic_store_n(
          &state->metrics.last_capture_to_uplink_us, bounded, __ATOMIC_RELAXED);
      atomic_note_maximum(&state->metrics.maximum_capture_to_uplink_us,
                          bounded);
    }
  }
  /*
   * Never retry a rejected frame. The bridge destroys the clean suffix from
   * the same DSP result, while pcm_capture_turn/pcm_lane classify pressure and
   * request an epoch purge. Recovery therefore resumes at "now" instead of
   * draining speech captured during the outage.
   */
  return status;
}

static bool IRAM_ATTR i2s_tap(bool transmit,
                              uint32_t sequence,
                              uint64_t completed_at_us,
                              const void *pcm,
                              size_t bytes,
                              void *user_data) {
  struct core_s3_audio_owner *const state = user_data;
  if (state == NULL) {
    return false;
  }
  if (transmit) {
    if (pcm == NULL ||
        bytes != ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES * sizeof(int16_t)) {
      isr_saturating_increment(&state->metrics.playout_observer_shape_errors);
    }
    bool observer_woke_task = false;
    if (state->observe_playout != NULL && pcm != NULL &&
        bytes == ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES * sizeof(int16_t)) {
      isr_saturating_increment(&state->metrics.playout_observer_frames);
      observer_woke_task =
          state->observe_playout(sequence,
                                 completed_at_us,
                                 pcm,
                                 ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES,
                                 state->observe_playout_context);
    }
    return observer_woke_task;
  }
  if (__atomic_load_n(&state->capture_tap_enabled, __ATOMIC_ACQUIRE) == 0U) {
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
      __atomic_load_n(&state->playback_content_active, __ATOMIC_ACQUIRE) != 0U,
      pcm,
      bytes);
  BaseType_t higher_priority_task_woken = pdFALSE;
  vTaskNotifyGiveFromISR(state->aec_task, &higher_priority_task_woken);
  return higher_priority_task_woken == pdTRUE;
}

static void wait_until_running(void) {
  while (__atomic_load_n(&owner.running, __ATOMIC_ACQUIRE) == 0U) {
    (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
  }
}

static void deinterleave_capture(
    const struct iterate_kit_core_s3_capture_chunk *chunk) {
  for (size_t frame = 0U; frame < ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES;
       ++frame) {
    const size_t base = frame * ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT;
    for (size_t slot = 0U; slot < ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT; ++slot) {
      const int32_t sample = chunk->interleaved[base + slot];
      const uint32_t magnitude =
          sample < 0 ? (uint32_t)(-sample) : (uint32_t)sample;
      atomic_note_maximum(&owner.metrics.tdm_slot_peak[slot], magnitude);
    }
    owner.near_dma[frame] = chunk->interleaved[base + CORE_S3_TDM_NEAR_SLOT];
    owner.reference_dma[frame] =
        chunk->interleaved[base + CORE_S3_TDM_REFERENCE_SLOT];
  }
  /*
   * This stateful 100 Hz high-pass is intentionally before both AEC and the
   * raw/processed selector. A retained production uplink changed from a wrong
   * transcript to exact “Hey pal” with this correction plus a measured 1.5x
   * gain increase, while generic denoising and a 4 kHz voice cutoff failed.
   * Filtering only the raw branch would give AEC a different near signal from
   * the one used during far silence and make a conversation-state transition
   * alter timbre. One persistent per-channel state also avoids a false step at
   * every 8 ms DMA boundary. It emits in place and cannot queue or allocate.
   */
  const uint64_t clipped_before = owner.near_high_pass.clipped_samples;
  if (iterate_kit_pcm_high_pass_process(
          &owner.near_high_pass,
          owner.near_dma,
          owner.near_dma,
          ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES) != ITERATE_KIT_OK) {
    memset(owner.near_dma, 0, sizeof(owner.near_dma));
    atomic_saturating_increment(&owner.metrics.capture_bridge_errors);
  }
  const uint64_t clipped_after = owner.near_high_pass.clipped_samples;
  if (clipped_after > clipped_before) {
    const uint64_t delta = clipped_after - clipped_before;
    atomic_saturating_add(&owner.metrics.near_high_pass_clipped_samples,
                          delta > SIZE_MAX ? SIZE_MAX : (size_t)delta);
  }
  /*
   * Slot 1 is the electrical divider from the actual AW88298 amplifier output,
   * not another acoustic microphone. It therefore contains limiter and
   * harmonic behaviour that pristine TX PCM cannot model, but the divider is
   * measured 9--18 dB below the echo entering the near mic. A saturating x8
   * brings it into ESP-SR's documented playback-scale reference regime. We do
   * this after deinterleave so the ISR remains one fixed raw copy, and before
   * the cadence bridge so every DSP sample and diagnostic sees the same
   * calibrated signal. Exact TX PCM remains a separate lane below: analog
   * noise must never make the raw/processed selector believe the speaker is
   * active during silence.
   */
  const uint64_t reference_clipped_before =
      owner.reference_scale_clipped_samples;
  if (iterate_kit_aec_reference_scale(owner.reference_dma,
                                      owner.reference_dma,
                                      ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES,
                                      CORE_S3_AEC_REFERENCE_SCALE_MULTIPLIER,
                                      &owner.reference_scale_clipped_samples) !=
      ITERATE_KIT_OK) {
    /* Constant, statically sized arguments make this a programming defect. */
    memset(owner.reference_dma, 0, sizeof(owner.reference_dma));
    atomic_saturating_increment(&owner.metrics.capture_bridge_errors);
  }
  const uint64_t reference_clipped_after =
      owner.reference_scale_clipped_samples;
  if (reference_clipped_after > reference_clipped_before) {
    const uint64_t delta = reference_clipped_after - reference_clipped_before;
    atomic_saturating_add(&owner.metrics.reference_scale_clipped_samples,
                          delta > SIZE_MAX ? SIZE_MAX : (size_t)delta);
  }
  atomic_saturating_increment(&owner.metrics.capture_chunks_deinterleaved);
}

static enum iterate_kit_status reset_capture_epoch(void) {
  /* A real missing DMA epoch is a signal discontinuity; chunk boundaries are
   * not. */
  iterate_kit_pcm_high_pass_reset(&owner.near_high_pass);
  const enum iterate_kit_status status =
      iterate_kit_aec_capture_bridge_reset(&owner.capture_bridge);
  if (status != ITERATE_KIT_OK) {
    atomic_saturating_increment(&owner.metrics.capture_bridge_errors);
  }
  mirror_capture_bridge_metrics();
  return status;
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
      const enum iterate_kit_core_s3_capture_take_result capture_result =
          iterate_kit_core_s3_capture_reserve_take(&owner.capture_reserve,
                                                   &owner.capture_chunk);
      if (capture_result == ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY) {
        break;
      }
      if (capture_result == ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH) {
        if (reset_capture_epoch() != ITERATE_KIT_OK) {
          vTaskSuspend(NULL);
        }
        continue;
      }

      deinterleave_capture(&owner.capture_chunk);
      const int16_t playback_activity =
          owner.capture_chunk.playback_content_active ? 1 : 0;
      for (size_t sample = 0U; sample < ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES;
           ++sample) {
        owner.playback_activity_dma[sample] = playback_activity;
      }
      if (owner.capture_chunk.playback_content_active) {
        atomic_saturating_increment(
            &owner.metrics.capture_chunks_with_playback_content);
      } else {
        atomic_saturating_increment(
            &owner.metrics.capture_chunks_without_playback_content);
      }
      const enum iterate_kit_status bridge_status =
          iterate_kit_aec_capture_bridge_push_aligned(
              &owner.capture_bridge,
              owner.capture_chunk.sequence,
              owner.capture_chunk.captured_through_at_us,
              owner.near_dma,
              owner.reference_dma,
              owner.playback_activity_dma,
              ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES);
      if (bridge_status != ITERATE_KIT_OK &&
          bridge_status != ITERATE_KIT_BACKPRESSURE) {
        atomic_saturating_increment(&owner.metrics.capture_bridge_errors);
      }
      mirror_capture_bridge_metrics();
    }

    /*
     * Apply PTT edges only after draining the bounded raw reserve which was
     * already waiting when this wake began. A tempting poll-before-drain puts
     * the release marker ahead of microphone chunks captured just before the
     * button edge. Draining at most eight 8 ms chunks bounds the tail and keeps
     * accepted frame/marker order causal without stopping the AEC timeline.
     * Notifications arriving during this pass remain sticky for the next pass.
     */
    const enum iterate_kit_status turn_status =
        iterate_kit_pcm_capture_turn_poll(&owner.capture_turn, monotonic_ms());
    if (turn_status != ITERATE_KIT_OK &&
        turn_status != ITERATE_KIT_UNAVAILABLE &&
        turn_status != ITERATE_KIT_BACKPRESSURE) {
      atomic_saturating_increment(&owner.metrics.capture_turn_poll_failures);
    }
  }
}

static enum iterate_kit_status reset_playback_state(void *context) {
  uint32_t discarded_frames = 0U;
  uint32_t discarded_items = 0U;
  (void)context;
  __atomic_store_n(&owner.playback_content_active, 0U, __ATOMIC_RELEASE);
  const enum iterate_kit_status playback_status =
      iterate_kit_pcm_clock_playback_reset(&owner.playback);
  const enum iterate_kit_status lane_status =
      iterate_kit_pcm_clock_playback_discard_queued(
          &owner.playback, &discarded_frames, &discarded_items);
  if (playback_status != ITERATE_KIT_OK || lane_status != ITERATE_KIT_OK) {
    atomic_saturating_increment(&owner.metrics.playback_policy_errors);
  }
  atomic_saturating_increment(&owner.metrics.playback_resets);
  atomic_saturating_add(&owner.metrics.downlink_frames_discarded_by_reset,
                        discarded_frames);
  (void)discarded_items;
  return playback_status != ITERATE_KIT_OK ? playback_status : lane_status;
}

static void apply_playback_reset_if_requested(void) {
  const bool direct_reset_requested =
      __atomic_exchange_n(
          &owner.playback_reset_requested, 0U, __ATOMIC_ACQUIRE) != 0U;
  const enum iterate_kit_status fence_status =
      iterate_kit_pcm_generation_fence_service(&owner.generation_fence);
  enum iterate_kit_status interruption_status = ITERATE_KIT_UNAVAILABLE;
  if (fence_status == ITERATE_KIT_UNAVAILABLE) {
    interruption_status = iterate_kit_pcm_playback_interruption_service(
        &owner.playback_interruption);
  }
  if (fence_status == ITERATE_KIT_UNAVAILABLE &&
      interruption_status == ITERATE_KIT_UNAVAILABLE &&
      direct_reset_requested) {
    (void)reset_playback_state(NULL);
  }
  /*
   * At most one handshake reset runs in an 8 ms codec pass. If a socket edge
   * and provider interruption overlap, the generation fence wins this pass
   * and the interruption is settled on the next one. Running both resets
   * before one DMA write would add CPU and silence without increasing safety;
   * queueing either elsewhere would create unbounded lifecycle backlog.
   *
   * A fire-and-forget reset coalesces with whichever acknowledged reset ran.
   * Any failure remains retained by that handshake and its metrics; this
   * realtime owner never logs or retries it in a tight loop.
   */
}

static void note_codec_timing(volatile uint32_t *last,
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
  for (size_t chunk = 0U; chunk < CORE_S3_RX_STARTUP_DRAIN_CHUNKS; ++chunk) {
    if (esp_codec_dev_read(owner.microphone,
                           owner.capture_drain,
                           (int)sizeof(owner.capture_drain)) !=
        ESP_CODEC_DEV_OK) {
      atomic_saturating_increment(&owner.metrics.codec_read_errors);
      break;
    }
  }
  iterate_kit_core_s3_i2s_stats_t startup_stats = {0};
  iterate_kit_core_s3_i2s_stats_snapshot(&startup_stats);
  owner.last_rx_queue_overflows = startup_stats.rx_queue_overflows;
  __atomic_store_n(&owner.capture_tap_enabled, 1U, __ATOMIC_RELEASE);

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
      atomic_saturating_add(&owner.metrics.playback_content_samples,
                            result.content_samples);
      atomic_saturating_add(&owner.metrics.playback_silence_samples,
                            result.silence_samples);
      if (render_status != ITERATE_KIT_OK) {
        atomic_saturating_increment(&owner.metrics.playback_policy_errors);
      }
      /*
       * The blocking owner writes this exact 8 ms edge, then performs the RX
       * read whose callback snapshots this bit. Publishing before the write is
       * deliberately conservative on a write failure: at worst one capture
       * edge uses processed AEC output, while publishing raw microphone during
       * an uncertain speaker edge could leak self-talk to server VAD.
       */
      __atomic_store_n(&owner.playback_content_active,
                       result.content_samples > 0U ? 1U : 0U,
                       __ATOMIC_RELEASE);
      const struct iterate_kit_pcm_clock_playback_metrics *playback_metrics =
          iterate_kit_pcm_clock_playback_metrics(&owner.playback);
      if (playback_metrics != NULL) {
        /*
         * Only this high-priority task may inspect the non-atomic playback
         * clock. Mirror its cumulative integrity counters for the low-rate
         * diagnostics sampler instead of adding a second owner or a queue to
         * the audio path.
         */
        __atomic_store_n(&owner.metrics.playback_underrun_incidents,
                         playback_metrics->underrun_incidents,
                         __ATOMIC_RELAXED);
        __atomic_store_n(
            &owner.metrics.playback_underrun_silence_samples,
            playback_metrics->underrun_silence_samples > UINT32_MAX
                ? UINT32_MAX
                : (uint32_t)playback_metrics->underrun_silence_samples,
            __ATOMIC_RELAXED);
        __atomic_store_n(&owner.metrics.playback_stale_frames_discarded,
                         playback_metrics->stale_frames_discarded,
                         __ATOMIC_RELAXED);
        __atomic_store_n(&owner.metrics.last_receive_to_render_ms,
                         playback_metrics->last_receive_to_render_ms,
                         __ATOMIC_RELAXED);
        atomic_note_maximum(&owner.metrics.maximum_receive_to_render_ms,
                            playback_metrics->maximum_receive_to_render_ms);
      }

      const int64_t write_started_at_us = esp_timer_get_time();
      const int write_status = esp_codec_dev_write(
          owner.speaker, owner.playback_dma, (int)sizeof(owner.playback_dma));
      note_codec_timing(&owner.metrics.last_codec_write_us,
                        &owner.metrics.maximum_codec_write_us,
                        write_started_at_us);
      if (write_status == ESP_CODEC_DEV_OK) {
        consecutive_write_errors = 0U;
      } else {
        atomic_saturating_increment(&owner.metrics.codec_write_errors);
        if (consecutive_write_errors != UINT32_MAX) {
          ++consecutive_write_errors;
        }
        if (consecutive_write_errors >= CORE_S3_IO_FAILURE_LIMIT) {
          speaker_io_enabled = false;
          __atomic_store_n(
              &owner.playback_content_active, 0U, __ATOMIC_RELEASE);
          __atomic_store_n(&owner.playback_failed, 1U, __ATOMIC_RELEASE);
        }
      }
    }
    if (!speaker_io_enabled) {
      __atomic_store_n(&owner.playback_content_active, 0U, __ATOMIC_RELEASE);
    }

    if (microphone_io_enabled) {
      const int64_t read_started_at_us = esp_timer_get_time();
      const int read_status =
          esp_codec_dev_read(owner.microphone,
                             owner.capture_drain,
                             (int)sizeof(owner.capture_drain));
      note_codec_timing(&owner.metrics.last_codec_read_us,
                        &owner.metrics.maximum_codec_read_us,
                        read_started_at_us);
      if (read_status == ESP_CODEC_DEV_OK) {
        consecutive_read_errors = 0U;
      } else {
        atomic_saturating_increment(&owner.metrics.codec_read_errors);
        if (consecutive_read_errors != UINT32_MAX) {
          ++consecutive_read_errors;
        }
        if (consecutive_read_errors >= CORE_S3_IO_FAILURE_LIMIT) {
          microphone_io_enabled = false;
          __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
          __atomic_store_n(&owner.capture_tap_enabled, 0U, __ATOMIC_RELEASE);
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
    if (i2s.tx_queue_overflows != owner.last_tx_queue_overflows) {
      owner.last_tx_queue_overflows = i2s.tx_queue_overflows;
      /*
       * TX loss invalidates playback evidence, but the electrical reference is
       * still part of each RX edge and the microphone timeline remains valid.
       * Resetting capture here previously coupled a speaker diagnostic to AEC
       * starvation; the overflow counter remains the explicit run invalidator.
       */
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
  return options != NULL && options->lane != NULL &&
         options->lane->initialized &&
         (options->audio_mode == ITERATE_KIT_AUDIO_PUSH_TO_TALK ||
          options->audio_mode == ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC) &&
         (options->aec_profile == ITERATE_KIT_CORE_S3_AEC_VOIP_SELECTOR ||
          options->aec_profile == ITERATE_KIT_CORE_S3_AEC_FD_NORMAL_CONSTANT ||
          options->aec_profile ==
              ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_CONSTANT ||
          options->aec_profile ==
              ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_LINEAR_CONSTANT ||
          options->aec_profile == ITERATE_KIT_CORE_S3_AEC_VOIP_CONSTANT ||
          options->aec_profile ==
              ITERATE_KIT_CORE_S3_AEC_VOIP_LINEAR_CONSTANT) &&
         options->maximum_downlink_frame_age_ms > 0U &&
         options->maximum_lane_items_per_dma_chunk > 0U &&
         options->speaker_volume_percent >= 0 &&
         options->speaker_volume_percent <= 100 &&
         options->microphone_gain_db >= 0 &&
         options->microphone_gain_db <= 37 && options->reference_gain_db >= 0 &&
         options->reference_gain_db <= 37 &&
         (options->diagnostic_trace == NULL ||
          (options->diagnostic_trace->initialized != 0U &&
           options->diagnostic_trace->options.sample_rate_hz ==
               ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ &&
           options->diagnostic_trace->options.frame_samples ==
               iterate_kit_core_s3_aec_processing_frame_samples(
                   options->aec_profile)));
}

esp_err_t iterate_kit_core_s3_audio_owner_start(
    const struct iterate_kit_core_s3_audio_owner_options *options) {
  if (!valid_options(options)) {
    return ESP_ERR_INVALID_ARG;
  }
  uint32_t expected = 0U;
  if (!__atomic_compare_exchange_n(&owner.started,
                                   &expected,
                                   1U,
                                   false,
                                   __ATOMIC_ACQ_REL,
                                   __ATOMIC_ACQUIRE)) {
    return ESP_ERR_INVALID_STATE;
  }

  owner.lane = options->lane;
  owner.observe_playout = options->observe_playout;
  owner.observe_playout_context = options->observe_playout_context;
  owner.speaker_volume_percent = options->speaker_volume_percent;
  owner.microphone_gain_db = options->microphone_gain_db;
  owner.reference_gain_db = options->reference_gain_db;
  owner.diagnostic_trace = options->diagnostic_trace;
  owner.aec_profile = options->aec_profile;
  owner.aec_frame_samples =
      iterate_kit_core_s3_aec_processing_frame_samples(options->aec_profile);
  if (iterate_kit_pcm_high_pass_init(&owner.near_high_pass,
                                     CORE_S3_NEAR_HIGH_PASS_DECAY_Q15) !=
      ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  if (iterate_kit_core_s3_capture_reserve_init(&owner.capture_reserve) !=
      ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_pcm_clock_playback_options playback_options = {
      .lane = owner.lane,
      .retained_frame = owner.retained_downlink,
      .retained_frame_capacity = ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
      .maximum_frame_age_ms = options->maximum_downlink_frame_age_ms,
      .maximum_lane_items_per_render =
          options->maximum_lane_items_per_dma_chunk,
      .minimum_start_items = CORE_S3_PLAYBACK_STARTUP_ITEMS,
      .item_released = options->downlink_item_released,
      .item_released_context = options->downlink_item_released_context,
  };
  if (iterate_kit_pcm_clock_playback_init(&owner.playback, &playback_options) !=
      ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_pcm_capture_turn_options capture_turn_options = {
      .lane = owner.lane,
      .stop_boundary = options->audio_mode == ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC
                           ? ITERATE_KIT_PCM_CAPTURE_STOP_SUPPRESS_END_MARKER
                           : ITERATE_KIT_PCM_CAPTURE_STOP_EMIT_END_MARKER,
      .notify_uplink = options->notify_uplink,
      .notify_uplink_context = options->notify_uplink_context,
  };
  if (iterate_kit_pcm_capture_turn_init(
          &owner.capture_turn, &capture_turn_options) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_pcm_generation_fence_options
      generation_fence_options = {
          .reset = reset_playback_state,
          .reset_context = NULL,
          /*
           * CoreS3 playback is clocked continuously by blocking 8 ms codec I/O,
           * so a task notification cannot shorten this boundary. Leaving the
           * wake NULL avoids manufacturing a signal the owner never waits on;
           * the next physical edge services the one-slot command.
           */
          .notify_consumer = NULL,
          .notify_consumer_context = NULL,
      };
  if (iterate_kit_pcm_generation_fence_init(&owner.generation_fence,
                                            &generation_fence_options) !=
      ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_pcm_playback_interruption_options
      playback_interruption_options = {
          .reset = reset_playback_state,
          .reset_context = NULL,
          /* The continuously clocked I/O owner reaches the next edge in 8 ms.
           */
          .notify_consumer = NULL,
          .notify_consumer_context = NULL,
      };
  if (iterate_kit_pcm_playback_interruption_init(
          &owner.playback_interruption, &playback_interruption_options) !=
      ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }

  owner.aec = create_aec(&owner);
  if (owner.aec == NULL) {
    __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
    return ESP_ERR_NO_MEM;
  }
  if (iterate_kit_aec_uplink_selector_init(
          &owner.uplink_selector,
          aec_profile_uses_constant_processed(owner.aec_profile)
              ? ITERATE_KIT_AEC_UPLINK_CONSTANT_PROCESSED
              : ITERATE_KIT_AEC_UPLINK_PLAYBACK_SWITCHED,
          CORE_S3_AEC_UPLINK_HANGOVER_FRAMES,
          ITERATE_KIT_CORE_S3_AEC_RAW_GAIN_MULTIPLIER,
          ITERATE_KIT_CORE_S3_AEC_PROCESSED_GAIN_MULTIPLIER) !=
      ITERATE_KIT_OK) {
    aec_destroy(owner.aec);
    owner.aec = NULL;
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_aec_capture_bridge_options bridge_options = {
      .sample_rate_hz = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
      .processing_frame_samples = owner.aec_frame_samples,
      .egress_frame_samples = ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
      .near_frame = owner.aec_near,
      .reference_frame = owner.aec_reference,
      .playout_frame = owner.aec_playout,
      .clean_frame = owner.aec_clean,
      .processing_frame_capacity = ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES,
      .egress_frame = owner.clean_egress,
      .egress_frame_capacity = ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
      .processor_context = &owner,
      .process = process_aec,
      .reset_processor = reset_aec,
      .egress_context = &owner,
      .copy_egress = copy_clean_uplink,
  };
  if (iterate_kit_aec_capture_bridge_init(&owner.capture_bridge,
                                          &bridge_options) != ITERATE_KIT_OK) {
    aec_destroy(owner.aec);
    owner.aec = NULL;
    return ESP_ERR_INVALID_STATE;
  }

  owner.io_task = xTaskCreateStaticPinnedToCore(io_task_main,
                                                "core-s3-io",
                                                sizeof(owner.io_stack),
                                                NULL,
                                                CORE_S3_IO_TASK_PRIORITY,
                                                owner.io_stack,
                                                &owner.io_task_control,
                                                CORE_S3_AUDIO_TASK_CORE);
  owner.aec_task = xTaskCreateStaticPinnedToCore(aec_task_main,
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

  ESP_LOGI(TAG,
           "ready: 16 kHz; DMA=5x128 (40 ms); raw reserve=8x1024 "
           "(64 ms); AEC profile=%u frame=%u; wire=320; static owner=%u bytes",
           (unsigned)owner.aec_profile,
           (unsigned)owner.aec_frame_samples,
           (unsigned)sizeof(owner));
  ESP_LOGI(TAG,
           "capture mapping: slot2=near %d dB + 100 Hz HPF + x%u raw gain; "
           "slot1 electrical speaker divider "
           "x%u is the AEC reference; playback-owner activity attached to each "
           "RX edge is the far-active oracle; diagnostic non-near codec "
           "inputs=%d dB",
           owner.microphone_gain_db,
           (unsigned)ITERATE_KIT_CORE_S3_AEC_RAW_GAIN_MULTIPLIER,
           (unsigned)CORE_S3_AEC_REFERENCE_SCALE_MULTIPLIER,
           owner.reference_gain_db);
  return ESP_OK;
}

void iterate_kit_core_s3_audio_owner_request_playback_reset(void) {
  if (__atomic_load_n(&owner.started, __ATOMIC_ACQUIRE) == 0U) {
    return;
  }
  __atomic_store_n(&owner.playback_reset_requested, 1U, __ATOMIC_RELEASE);
}

enum iterate_kit_status
iterate_kit_core_s3_audio_owner_request_playback_interruption(void *context,
                                                              uint32_t *token) {
  (void)context;
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return iterate_kit_pcm_playback_interruption_request(
      &owner.playback_interruption, token);
}

enum iterate_kit_status
iterate_kit_core_s3_audio_owner_poll_playback_interruption(void *context,
                                                           uint32_t token) {
  (void)context;
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return iterate_kit_pcm_playback_interruption_poll(
      &owner.playback_interruption, token);
}

enum iterate_kit_status
iterate_kit_core_s3_audio_owner_downlink_generation_barrier(void *context,
                                                            uint32_t generation,
                                                            bool connected) {
  (void)context;
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return iterate_kit_pcm_generation_fence_poll(
      &owner.generation_fence, generation, connected);
}

enum iterate_kit_status iterate_kit_core_s3_audio_owner_request_uplink_active(
    bool active) {
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U ||
      __atomic_load_n(&owner.capture_failed, __ATOMIC_ACQUIRE) != 0U ||
      owner.aec_task == NULL) {
    /*
     * Accepting an edge after the DSP owner has terminated would make the
     * capability report success for work that can never be applied. Keep the
     * failed state explicit; the control owner may now end/restart the whole
     * session rather than silently leaving a requested open microphone.
     */
    return ITERATE_KIT_STATE_ERROR;
  }
  const enum iterate_kit_status status =
      iterate_kit_pcm_capture_turn_request(&owner.capture_turn, active);
  if (status == ITERATE_KIT_OK) {
    /*
     * Continuous capture normally wakes this task every 8 ms, but an explicit
     * edge wake keeps hang-up bounded even if the codec has just failed. It is
     * a counter notification, so racing an ISR wake cannot lose either reason.
     */
    xTaskNotifyGive(owner.aec_task);
  }
  return status;
}

void iterate_kit_core_s3_audio_owner_metrics_snapshot(
    struct iterate_kit_core_s3_audio_owner_metrics *snapshot) {
  if (snapshot == NULL) {
    return;
  }
  memset(snapshot, 0, sizeof(*snapshot));
  snapshot->ready = atomic_load(&owner.ready) != 0U;
  snapshot->playback_failed = atomic_load(&owner.playback_failed) != 0U;
  snapshot->capture_failed = atomic_load(&owner.capture_failed) != 0U;
  snapshot->sample_rate_hz = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ;
  snapshot->dma_frame_samples = ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES;
  snapshot->dma_descriptor_count = CORE_S3_DMA_DESCRIPTOR_COUNT;
  snapshot->configured_dma_reserve_ms =
      CORE_S3_DMA_DESCRIPTOR_COUNT * ITERATE_KIT_CORE_S3_DMA_FRAME_SAMPLES *
      1000U / ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ;
  snapshot->static_owner_bytes = sizeof(owner);
  snapshot->aec_profile = owner.aec_profile;
  snapshot->aec_frame_samples = (uint32_t)owner.aec_frame_samples;
  snapshot->near_window_gain_multiplier =
      aec_profile_uses_constant_processed(owner.aec_profile)
          ? ITERATE_KIT_CORE_S3_AEC_PROCESSED_GAIN_MULTIPLIER
          : ITERATE_KIT_CORE_S3_AEC_RAW_GAIN_MULTIPLIER;
  snapshot->far_window_gain_multiplier =
      ITERATE_KIT_CORE_S3_AEC_PROCESSED_GAIN_MULTIPLIER;
  /*
   * Retain the programmed values, not merely the requested target constants.
   * This snapshot is the evidence boundary used after boot and across remote
   * reconnects; without it a 24 dB trace could be mislabeled as the 18 dB
   * analogue-headroom experiment simply because the host had rebuilt source.
   */
  snapshot->speaker_volume_percent = owner.speaker_volume_percent;
  snapshot->microphone_gain_db = owner.microphone_gain_db;
  snapshot->reference_gain_db = owner.reference_gain_db;
  iterate_kit_core_s3_i2s_stats_snapshot(&snapshot->i2s);
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &owner.capture_reserve, &snapshot->capture_reserve);
  if (owner.lane != NULL) {
    iterate_kit_pcm_lane_metrics(owner.lane, &snapshot->lane);
  }
  iterate_kit_pcm_capture_turn_metrics(&owner.capture_turn,
                                       &snapshot->capture_turn);
  iterate_kit_pcm_generation_fence_metrics(&owner.generation_fence,
                                           &snapshot->generation_fence);
  iterate_kit_pcm_playback_interruption_metrics(
      &owner.playback_interruption, &snapshot->playback_interruption);

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
  COPY_ATOMIC_METRIC(playback_underrun_incidents);
  COPY_ATOMIC_METRIC(playback_underrun_silence_samples);
  COPY_ATOMIC_METRIC(playback_stale_frames_discarded);
  COPY_ATOMIC_METRIC(playout_observer_frames);
  COPY_ATOMIC_METRIC(playout_observer_shape_errors);
  COPY_ATOMIC_METRIC(capture_chunks_deinterleaved);
  COPY_ATOMIC_METRIC(capture_chunks_with_playback_content);
  COPY_ATOMIC_METRIC(capture_chunks_without_playback_content);
  COPY_ATOMIC_METRIC(capture_bridge_errors);
  COPY_ATOMIC_METRIC(aec_frames);
  COPY_ATOMIC_METRIC(aec_recreates);
  COPY_ATOMIC_METRIC(aec_recreate_failures);
  COPY_ATOMIC_METRIC(last_aec_process_us);
  COPY_ATOMIC_METRIC(maximum_aec_process_us);
  COPY_ATOMIC_METRIC(last_capture_to_uplink_us);
  COPY_ATOMIC_METRIC(maximum_capture_to_uplink_us);
  COPY_ATOMIC_METRIC(aec_signal_measurement_failures);
  COPY_ATOMIC_METRIC(near_high_pass_clipped_samples);
  COPY_ATOMIC_METRIC(reference_scale_clipped_samples);
  COPY_ATOMIC_METRIC(uplink_gain_clipped_samples);
  COPY_ATOMIC_METRIC(aec_input_partial_samples);
  COPY_ATOMIC_METRIC(clean_egress_partial_samples);
  COPY_ATOMIC_METRIC(capture_turn_poll_failures);
#undef COPY_ATOMIC_METRIC
  snapshot->clean_uplink_frames = snapshot->capture_turn.frames_accepted;
  const uint64_t clean_uplink_drops =
      (uint64_t)snapshot->capture_turn.frame_backpressure +
      snapshot->capture_turn.frame_failures;
  snapshot->clean_uplink_drops = clean_uplink_drops > UINT32_MAX
                                     ? UINT32_MAX
                                     : (uint32_t)clean_uplink_drops;
  /*
   * These three counters are the mutually exclusive top-level boundaries at
   * which captured PCM can fail: hardware read, DSP/bridge processing, and
   * publication of a completed PTT turn. Do not add AEC recreate failures:
   * the bridge records that same incident in capture_bridge_errors, and an
   * innocent-looking sum would make one failure appear twice in userspace.
   */
  const uint64_t capture_failures = (uint64_t)snapshot->codec_read_errors +
                                    snapshot->capture_bridge_errors +
                                    snapshot->capture_turn_poll_failures;
  snapshot->capture_failures =
      capture_failures > UINT32_MAX ? UINT32_MAX : (uint32_t)capture_failures;
  for (size_t slot = 0U; slot < ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT; ++slot) {
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
  snapshot->internal_heap_free_bytes =
      (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  snapshot->internal_heap_largest_block_bytes =
      (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL |
                                                 MALLOC_CAP_8BIT);
  snapshot->psram_heap_free_bytes =
      (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  snapshot->psram_heap_largest_block_bytes =
      (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM |
                                                 MALLOC_CAP_8BIT);
}

enum iterate_kit_status
iterate_kit_core_s3_audio_owner_aec_signal_metrics_snapshot(
    struct iterate_kit_core_s3_aec_signal_metrics *snapshot) {
  struct iterate_kit_aec_signal_window window;
  if (snapshot == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  portENTER_CRITICAL(&aec_signal_window_mux);
  if (owner.latest_aec_signal_sequence == 0U) {
    window = owner.current_aec_signal_window;
    snapshot->sequence = 0U;
    snapshot->window_started_at_us = owner.current_aec_signal_started_at_us;
    snapshot->produced_at_us = 0U;
  } else {
    window = owner.latest_aec_signal_window;
    snapshot->sequence = owner.latest_aec_signal_sequence;
    snapshot->window_started_at_us = owner.latest_aec_signal_started_at_us;
    snapshot->produced_at_us = owner.latest_aec_signal_produced_at_us;
  }
  portEXIT_CRITICAL(&aec_signal_window_mux);

  if (snapshot->produced_at_us == 0U) {
    const int64_t now_us = esp_timer_get_time();
    snapshot->produced_at_us = now_us < 0 ? 0U : (uint64_t)now_us;
  }
  return iterate_kit_aec_signal_window_summarize(
      &window, CORE_S3_AEC_SIGNAL_SAMPLE_STRIDE, &snapshot->signal);
}
