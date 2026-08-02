#include "iterate/kit/platforms/voice_pe_audio_owner.h"

#include "iterate/kit/pcm_clock_playback.h"
#include "iterate/kit/platforms/voice_pe_hardware_config.h"
#include "iterate/kit/platforms/voice_pe_pcm_format.h"

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"

#include <limits.h>
#include <string.h>

/*
 * This file is the only owner of HAVPE's audio peripherals. Network code owns
 * the opposite sides of pcm_lane and never calls I2S. The split is structural:
 * a TLS stall or Cap'n Web callback can delay its own task, but cannot inherit
 * an I2S mutex or put a socket wait on the physical audio clock.
 *
 * The board has two independent XMOS-owned buses, so a single alternating I/O
 * loop would be subtly wrong. A blocked 20 ms microphone read could postpone
 * the 10 ms speaker refill (or vice versa) even though neither peripheral
 * depends on the other. Two same-core priority owners stay allocation-free and
 * spend almost all their time blocked in their respective IDF drivers.
 */

#define VOICE_PE_PLAYBACK_STACK_BYTES 4096U
#define VOICE_PE_CAPTURE_STACK_BYTES 4096U
#define VOICE_PE_AUDIO_TASK_PRIORITY 24U
#define VOICE_PE_AUDIO_TASK_CORE 1
#define VOICE_PE_IO_FAILURE_LIMIT 3U

#define VOICE_PE_PLAYBACK_DMA_DESCRIPTOR_COUNT 6U
#define VOICE_PE_PLAYBACK_DMA_FRAMES 480U
#define VOICE_PE_CAPTURE_DMA_DESCRIPTOR_COUNT 5U
#define VOICE_PE_CAPTURE_DMA_FRAMES 320U
#define VOICE_PE_PLAYBACK_WRITE_TIMEOUT_MS 25U
#define VOICE_PE_CAPTURE_READ_TIMEOUT_MS 40U

#define VOICE_PE_I2C_SDA_GPIO GPIO_NUM_5
#define VOICE_PE_I2C_SCL_GPIO GPIO_NUM_6
#define VOICE_PE_XMOS_RESET_GPIO GPIO_NUM_4
#define VOICE_PE_SPEAKER_ENABLE_GPIO GPIO_NUM_47
#define VOICE_PE_XMOS_I2C_ADDRESS 0x42U
#define VOICE_PE_AIC3204_I2C_ADDRESS 0x18U
#define VOICE_PE_I2C_FREQUENCY_HZ 400000U
#define VOICE_PE_I2C_TIMEOUT_MS 50
#define VOICE_PE_XMOS_BOOT_MS 3000U

#define VOICE_PE_PLAYBACK_WS_GPIO GPIO_NUM_7
#define VOICE_PE_PLAYBACK_BCLK_GPIO GPIO_NUM_8
#define VOICE_PE_PLAYBACK_DATA_GPIO GPIO_NUM_10
#define VOICE_PE_CAPTURE_WS_GPIO GPIO_NUM_14
#define VOICE_PE_CAPTURE_BCLK_GPIO GPIO_NUM_13
#define VOICE_PE_CAPTURE_DATA_GPIO GPIO_NUM_15

#define VOICE_PE_AEC_SIGNAL_SAMPLE_STRIDE 8U
#define VOICE_PE_AEC_SIGNAL_WINDOW_US UINT64_C(1000000)

static const char *const TAG = "iterate-voice-pe-audio";

struct voice_pe_signal_window {
  uint64_t sampled_samples;
  uint64_t raw_absolute_sum;
  uint64_t clean_absolute_sum;
  uint32_t raw_peak;
  uint32_t clean_peak;
};

struct voice_pe_atomic_metrics {
  volatile uint32_t playback_edges;
  volatile uint32_t playback_content_samples;
  volatile uint32_t playback_silence_samples;
  volatile uint32_t playback_policy_errors;
  volatile uint32_t playback_write_errors;
  volatile uint32_t playback_partial_writes;
  volatile uint32_t playback_queue_overflows;
  volatile uint32_t playback_resets;
  volatile uint32_t playback_reset_failures;
  volatile uint32_t downlink_frames_discarded_by_reset;
  volatile uint32_t last_playback_write_us;
  volatile uint32_t maximum_playback_write_us;
  volatile uint32_t last_receive_to_render_ms;
  volatile uint32_t maximum_receive_to_render_ms;

  volatile uint32_t capture_frames;
  volatile uint32_t capture_read_errors;
  volatile uint32_t capture_partial_reads;
  volatile uint32_t capture_queue_overflows;
  volatile uint32_t capture_resets;
  volatile uint32_t capture_reset_failures;
  volatile uint32_t capture_format_errors;
  volatile uint32_t capture_turn_poll_failures;
  volatile uint32_t aec_signal_measurement_failures;
  volatile uint32_t capture_failure_incidents;
  volatile uint32_t last_capture_read_us;
  volatile uint32_t maximum_capture_read_us;
  volatile uint32_t last_capture_to_uplink_us;
  volatile uint32_t maximum_capture_to_uplink_us;
};

struct voice_pe_audio_owner {
  struct iterate_kit_pcm_lane *lane;
  i2c_master_bus_handle_t i2c_bus;
  i2c_master_dev_handle_t xmos;
  i2c_master_dev_handle_t codec;
  i2s_chan_handle_t playback_channel;
  i2s_chan_handle_t capture_channel;

  struct iterate_kit_pcm_clock_playback playback;
  struct iterate_kit_pcm_capture_turn capture_turn;
  struct iterate_kit_pcm_generation_fence generation_fence;
  struct iterate_kit_pcm_playback_interruption playback_interruption;
  struct iterate_kit_voice_pe_playback_resampler playback_resampler;

  int16_t retained_downlink[ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME]
      __attribute__((aligned(16)));
  int16_t playback_pcm[ITERATE_KIT_VOICE_PE_PLAYBACK_EDGE_SAMPLES]
      __attribute__((aligned(16)));
  int32_t playback_i2s[
      ITERATE_KIT_VOICE_PE_PLAYBACK_EDGE_SAMPLES *
      ITERATE_KIT_VOICE_PE_PLAYBACK_WORDS_PER_PCM16_SAMPLE]
      __attribute__((aligned(16)));
  int32_t capture_i2s[
      ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES * 2U]
      __attribute__((aligned(16)));
  int16_t capture_clean[ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES]
      __attribute__((aligned(16)));
  int16_t capture_raw[ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES]
      __attribute__((aligned(16)));

  struct voice_pe_signal_window current_signal_window;
  struct voice_pe_signal_window latest_signal_window;
  uint64_t current_signal_started_at_us;
  uint64_t latest_signal_started_at_us;
  uint64_t latest_signal_produced_at_us;
  uint32_t latest_signal_sequence;

  StaticTask_t playback_task_control;
  StaticTask_t capture_task_control;
  StackType_t playback_stack[VOICE_PE_PLAYBACK_STACK_BYTES]
      __attribute__((aligned(16)));
  StackType_t capture_stack[VOICE_PE_CAPTURE_STACK_BYTES]
      __attribute__((aligned(16)));
  TaskHandle_t playback_task;
  TaskHandle_t capture_task;

  struct voice_pe_atomic_metrics metrics;
  volatile uint32_t started;
  volatile uint32_t running;
  volatile uint32_t ready;
  volatile uint32_t playback_failed;
  volatile uint32_t capture_failed;
  volatile uint32_t playback_reset_requested;
};

/*
 * Every Iterate frame and both task stacks are link-visible internal memory.
 * IDF may allocate its driver objects once during startup, but no steady-state
 * audio path depends on heap availability or PSRAM cache latency. This exact
 * object size is exported in metrics and the ELF/map resource report.
 */
static DRAM_ATTR struct voice_pe_audio_owner owner
    __attribute__((aligned(16)));

/*
 * Capture is the only writer. A control task copies seven scalar fields at
 * most once per subscriber interval. Walking samples and dividing sums happen
 * outside this critical section, so metrics cannot stretch an audio deadline.
 */
static portMUX_TYPE signal_window_mux = portMUX_INITIALIZER_UNLOCKED;

/*
 * ESP-IDF otherwise evicts the oldest completed DMA descriptor silently when
 * its internal queue fills. The ISR does no logging, allocation, wakeup, or
 * policy work: it only makes that physical discontinuity observable. The
 * audio task later owns recovery and the low-rate metrics snapshot owns
 * presentation, keeping interrupt time fixed and tiny.
 */
static IRAM_ATTR bool note_i2s_queue_overflow(
    i2s_chan_handle_t handle,
    i2s_event_data_t *event,
    void *user_context) {
  (void)handle;
  (void)event;
  volatile uint32_t *counter = user_context;
  if (counter != NULL) {
    (void)__atomic_fetch_add(counter, 1U, __ATOMIC_RELAXED);
  }
  return false;
}

static uint64_t monotonic_ms(void) {
  const int64_t now_us = esp_timer_get_time();
  return now_us <= 0 ? 0U : (uint64_t)now_us / 1000U;
}

static uint32_t monotonic_us_since(int64_t started_at_us) {
  const int64_t elapsed = esp_timer_get_time() - started_at_us;
  if (elapsed <= 0) {
    return 0U;
  }
  return (uint64_t)elapsed > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)elapsed;
}

static uint32_t atomic_load(const volatile uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static void atomic_saturating_increment(volatile uint32_t *value) {
  uint32_t current = atomic_load(value);
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
  uint32_t current = atomic_load(value);
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
  uint32_t current = atomic_load(maximum);
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

static uint32_t sample_magnitude(int16_t sample) {
  const int32_t widened = sample;
  return widened < 0 ? (uint32_t)-widened : (uint32_t)widened;
}

static uint64_t saturating_add_u64(uint64_t left, uint64_t right) {
  return right > UINT64_MAX - left ? UINT64_MAX : left + right;
}

static void measure_signal_window(
    const int16_t *raw,
    const int16_t *clean,
    size_t sample_count,
    struct voice_pe_signal_window *window) {
  memset(window, 0, sizeof(*window));
  for (size_t index = 0U;
       index < sample_count;
       index += VOICE_PE_AEC_SIGNAL_SAMPLE_STRIDE) {
    const uint32_t raw_magnitude = sample_magnitude(raw[index]);
    const uint32_t clean_magnitude = sample_magnitude(clean[index]);
    ++window->sampled_samples;
    window->raw_absolute_sum += raw_magnitude;
    window->clean_absolute_sum += clean_magnitude;
    if (raw_magnitude > window->raw_peak) {
      window->raw_peak = raw_magnitude;
    }
    if (clean_magnitude > window->clean_peak) {
      window->clean_peak = clean_magnitude;
    }
  }
}

static void merge_signal_observation(
    const struct voice_pe_signal_window *observation,
    uint64_t observed_at_us) {
  portENTER_CRITICAL(&signal_window_mux);
  if (owner.current_signal_started_at_us == 0U) {
    owner.current_signal_started_at_us = observed_at_us;
  }
  if (observed_at_us >= owner.current_signal_started_at_us &&
      observed_at_us - owner.current_signal_started_at_us >=
          VOICE_PE_AEC_SIGNAL_WINDOW_US &&
      owner.current_signal_window.sampled_samples != 0U) {
    owner.latest_signal_window = owner.current_signal_window;
    memset(
        &owner.current_signal_window,
        0,
        sizeof(owner.current_signal_window));
    owner.latest_signal_started_at_us =
        owner.current_signal_started_at_us;
    owner.latest_signal_produced_at_us = observed_at_us;
    if (owner.latest_signal_sequence != UINT32_MAX) {
      ++owner.latest_signal_sequence;
    }
    owner.current_signal_started_at_us = observed_at_us;
  }
  owner.current_signal_window.sampled_samples = saturating_add_u64(
      owner.current_signal_window.sampled_samples,
      observation->sampled_samples);
  owner.current_signal_window.raw_absolute_sum = saturating_add_u64(
      owner.current_signal_window.raw_absolute_sum,
      observation->raw_absolute_sum);
  owner.current_signal_window.clean_absolute_sum = saturating_add_u64(
      owner.current_signal_window.clean_absolute_sum,
      observation->clean_absolute_sum);
  if (observation->raw_peak > owner.current_signal_window.raw_peak) {
    owner.current_signal_window.raw_peak = observation->raw_peak;
  }
  if (observation->clean_peak > owner.current_signal_window.clean_peak) {
    owner.current_signal_window.clean_peak = observation->clean_peak;
  }
  portEXIT_CRITICAL(&signal_window_mux);
}

static esp_err_t write_codec_registers(
    const struct iterate_kit_voice_pe_register_write *writes,
    size_t count) {
  if (writes == NULL || count == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  for (size_t index = 0U; index < count; ++index) {
    const uint8_t command[] = {
      writes[index].address,
      writes[index].value,
    };
    const esp_err_t status = i2c_master_transmit(
        owner.codec,
        command,
        sizeof(command),
        VOICE_PE_I2C_TIMEOUT_MS);
    if (status != ESP_OK) {
      return status;
    }
  }
  return ESP_OK;
}

static esp_err_t configure_xmos_pipeline(
    uint8_t channel,
    enum iterate_kit_voice_pe_xmos_stage stage) {
  uint8_t command[4];
  if (iterate_kit_voice_pe_xmos_pipeline_command(
          channel, stage, command, sizeof(command)) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  esp_err_t status = i2c_master_transmit(
      owner.xmos,
      command,
      sizeof(command),
      VOICE_PE_I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }

  uint8_t read_command[3];
  uint8_t response[2] = {0xffU, 0xffU};
  if (iterate_kit_voice_pe_xmos_pipeline_read_command(
          channel,
          read_command,
          sizeof(read_command)) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  status = i2c_master_transmit(
      owner.xmos,
      read_command,
      sizeof(read_command),
      VOICE_PE_I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  status = i2c_master_receive(
      owner.xmos,
      response,
      sizeof(response),
      VOICE_PE_I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  return iterate_kit_voice_pe_xmos_pipeline_response_matches(
      response, sizeof(response), stage)
      ? ESP_OK
      : ESP_ERR_INVALID_RESPONSE;
}

static esp_err_t verify_xmos_version(
    struct iterate_kit_voice_pe_xmos_version *version) {
  uint8_t command[3];
  uint8_t response[4] = {0xffU, 0xffU, 0xffU, 0xffU};
  if (version == NULL ||
      iterate_kit_voice_pe_xmos_version_command(
          command, sizeof(command)) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  esp_err_t status = i2c_master_transmit(
      owner.xmos,
      command,
      sizeof(command),
      VOICE_PE_I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  status = i2c_master_receive(
      owner.xmos,
      response,
      sizeof(response),
      VOICE_PE_I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  if (iterate_kit_voice_pe_parse_xmos_version(
          response, sizeof(response), version) != ITERATE_KIT_OK ||
      !iterate_kit_voice_pe_xmos_version_is_supported(version)) {
    return ESP_ERR_INVALID_VERSION;
  }
  return ESP_OK;
}

static esp_err_t initialize_i2c(void) {
  const i2c_master_bus_config_t bus_config = {
    .i2c_port = -1,
    .sda_io_num = VOICE_PE_I2C_SDA_GPIO,
    .scl_io_num = VOICE_PE_I2C_SCL_GPIO,
    .clk_source = I2C_CLK_SRC_DEFAULT,
    .glitch_ignore_cnt = 7U,
    .intr_priority = 0,
    .trans_queue_depth = 0U,
    .flags = {
      .enable_internal_pullup = true,
      .allow_pd = false,
    },
  };
  const i2c_device_config_t xmos_config = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = VOICE_PE_XMOS_I2C_ADDRESS,
    .scl_speed_hz = VOICE_PE_I2C_FREQUENCY_HZ,
  };
  const i2c_device_config_t codec_config = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = VOICE_PE_AIC3204_I2C_ADDRESS,
    .scl_speed_hz = VOICE_PE_I2C_FREQUENCY_HZ,
  };

  esp_err_t status = i2c_new_master_bus(
      &bus_config, &owner.i2c_bus);
  if (status != ESP_OK) {
    return status;
  }
  status = i2c_master_bus_add_device(
      owner.i2c_bus, &xmos_config, &owner.xmos);
  if (status != ESP_OK) {
    return status;
  }
  return i2c_master_bus_add_device(
      owner.i2c_bus, &codec_config, &owner.codec);
}

static esp_err_t initialize_control_gpios(void) {
  const gpio_config_t config = {
    .pin_bit_mask =
        (UINT64_C(1) << VOICE_PE_XMOS_RESET_GPIO) |
        (UINT64_C(1) << VOICE_PE_SPEAKER_ENABLE_GPIO),
    .mode = GPIO_MODE_OUTPUT,
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  esp_err_t status = gpio_config(&config);
  if (status != ESP_OK) {
    return status;
  }
  status = gpio_set_level(VOICE_PE_SPEAKER_ENABLE_GPIO, 0);
  if (status != ESP_OK) {
    return status;
  }
  status = gpio_set_level(VOICE_PE_XMOS_RESET_GPIO, 1);
  if (status != ESP_OK) {
    return status;
  }
  vTaskDelay(pdMS_TO_TICKS(1U));
  status = gpio_set_level(VOICE_PE_XMOS_RESET_GPIO, 0);
  if (status != ESP_OK) {
    return status;
  }

  /*
   * The three-second wait is a first-party hardware contract, not retry
   * padding. Sending configuration while XMOS firmware is still booting can
   * NACK once and leave the channel stages at unknown defaults for the boot.
   */
  vTaskDelay(pdMS_TO_TICKS(VOICE_PE_XMOS_BOOT_MS));
  return ESP_OK;
}

static esp_err_t initialize_i2s(void) {
  i2s_chan_config_t playback_channel_config =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
  playback_channel_config.dma_desc_num =
      VOICE_PE_PLAYBACK_DMA_DESCRIPTOR_COUNT;
  playback_channel_config.dma_frame_num = VOICE_PE_PLAYBACK_DMA_FRAMES;
  playback_channel_config.auto_clear_after_cb = true;
  playback_channel_config.auto_clear_before_cb = false;
  playback_channel_config.intr_priority = 3;

  i2s_chan_config_t capture_channel_config =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_SLAVE);
  capture_channel_config.dma_desc_num =
      VOICE_PE_CAPTURE_DMA_DESCRIPTOR_COUNT;
  capture_channel_config.dma_frame_num = VOICE_PE_CAPTURE_DMA_FRAMES;
  capture_channel_config.intr_priority = 3;

  const i2s_std_config_t playback_config = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(
        ITERATE_KIT_VOICE_PE_PLAYBACK_RATE_HZ),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
        I2S_DATA_BIT_WIDTH_32BIT,
        I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = VOICE_PE_PLAYBACK_BCLK_GPIO,
      .ws = VOICE_PE_PLAYBACK_WS_GPIO,
      .dout = VOICE_PE_PLAYBACK_DATA_GPIO,
      .din = I2S_GPIO_UNUSED,
      .invert_flags = {
        .mclk_inv = false,
        .bclk_inv = false,
        .ws_inv = false,
      },
    },
  };
  const i2s_std_config_t capture_config = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(
        ITERATE_KIT_VOICE_PE_CAPTURE_RATE_HZ),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
        I2S_DATA_BIT_WIDTH_32BIT,
        I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = VOICE_PE_CAPTURE_BCLK_GPIO,
      .ws = VOICE_PE_CAPTURE_WS_GPIO,
      .dout = I2S_GPIO_UNUSED,
      .din = VOICE_PE_CAPTURE_DATA_GPIO,
      .invert_flags = {
        .mclk_inv = false,
        .bclk_inv = false,
        .ws_inv = false,
      },
    },
  };

  esp_err_t status = i2s_new_channel(
      &playback_channel_config,
      &owner.playback_channel,
      NULL);
  if (status != ESP_OK) {
    return status;
  }
  status = i2s_channel_init_std_mode(
      owner.playback_channel, &playback_config);
  if (status != ESP_OK) {
    return status;
  }
  const i2s_event_callbacks_t playback_callbacks = {
    .on_recv = NULL,
    .on_recv_q_ovf = NULL,
    .on_sent = NULL,
    .on_send_q_ovf = note_i2s_queue_overflow,
  };
  status = i2s_channel_register_event_callback(
      owner.playback_channel,
      &playback_callbacks,
      (void *)&owner.metrics.playback_queue_overflows);
  if (status != ESP_OK) {
    return status;
  }
  status = i2s_new_channel(
      &capture_channel_config,
      NULL,
      &owner.capture_channel);
  if (status != ESP_OK) {
    return status;
  }
  status = i2s_channel_init_std_mode(
      owner.capture_channel, &capture_config);
  if (status != ESP_OK) {
    return status;
  }
  const i2s_event_callbacks_t capture_callbacks = {
    .on_recv = NULL,
    .on_recv_q_ovf = note_i2s_queue_overflow,
    .on_sent = NULL,
    .on_send_q_ovf = NULL,
  };
  return i2s_channel_register_event_callback(
      owner.capture_channel,
      &capture_callbacks,
      (void *)&owner.metrics.capture_queue_overflows);
}

static esp_err_t preload_playback_silence(void) {
  memset(owner.playback_i2s, 0, sizeof(owner.playback_i2s));
  const size_t total_dma_bytes =
      VOICE_PE_PLAYBACK_DMA_DESCRIPTOR_COUNT *
      VOICE_PE_PLAYBACK_DMA_FRAMES * 2U * sizeof(int32_t);
  size_t total_loaded = 0U;
  while (total_loaded < total_dma_bytes) {
    size_t loaded = 0U;
    const size_t remaining = total_dma_bytes - total_loaded;
    const size_t requested = remaining < sizeof(owner.playback_i2s)
        ? remaining
        : sizeof(owner.playback_i2s);
    const esp_err_t status = i2s_channel_preload_data(
        owner.playback_channel,
        owner.playback_i2s,
        requested,
        &loaded);
    if (status != ESP_OK || loaded != requested) {
      return status == ESP_OK ? ESP_FAIL : status;
    }
    total_loaded += loaded;
  }
  return ESP_OK;
}

static esp_err_t initialize_hardware(void) {
  size_t initial_write_count = 0U;
  size_t power_up_write_count = 0U;
  const struct iterate_kit_voice_pe_register_write *initial_writes =
      iterate_kit_voice_pe_aic3204_initial_writes(
          &initial_write_count);
  const struct iterate_kit_voice_pe_register_write *power_up_writes =
      iterate_kit_voice_pe_aic3204_power_up_writes(
          &power_up_write_count);

  esp_err_t status = initialize_control_gpios();
  if (status != ESP_OK) {
    return status;
  }
  status = initialize_i2c();
  if (status != ESP_OK) {
    return status;
  }
  struct iterate_kit_voice_pe_xmos_version xmos_version;
  status = verify_xmos_version(&xmos_version);
  if (status != ESP_OK) {
    return status;
  }
  ESP_LOGI(
      TAG,
      "verified XMOS firmware %u.%u.%u",
      xmos_version.major,
      xmos_version.minor,
      xmos_version.patch);
  status = configure_xmos_pipeline(
      0U, ITERATE_KIT_VOICE_PE_XMOS_STAGE_AGC);
  if (status != ESP_OK) {
    return status;
  }
  status = configure_xmos_pipeline(
      1U, ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE);
  if (status != ESP_OK) {
    return status;
  }
  status = write_codec_registers(initial_writes, initial_write_count);
  if (status != ESP_OK) {
    return status;
  }

  /*
   * This is the codec's analogue soft-start, not an arbitrary boot delay. The
   * power-up table must not be sent early or the hardware can pop and enter a
   * different analogue state from the first-party implementation.
   */
  vTaskDelay(pdMS_TO_TICKS(ITERATE_KIT_VOICE_PE_AIC3204_SETTLE_MS));

  status = initialize_i2s();
  if (status != ESP_OK) {
    return status;
  }
  status = preload_playback_silence();
  if (status != ESP_OK) {
    return status;
  }
  status = i2s_channel_enable(owner.playback_channel);
  if (status != ESP_OK) {
    return status;
  }
  status = i2s_channel_enable(owner.capture_channel);
  if (status != ESP_OK) {
    return status;
  }
  status = write_codec_registers(power_up_writes, power_up_write_count);
  if (status != ESP_OK) {
    return status;
  }
  return gpio_set_level(VOICE_PE_SPEAKER_ENABLE_GPIO, 1);
}

static void wait_until_running(void) {
  while (__atomic_load_n(&owner.running, __ATOMIC_ACQUIRE) == 0U) {
    (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
  }
}

static enum iterate_kit_status reset_playback_state(void *context) {
  (void)context;
  uint32_t discarded_frames = 0U;

  /*
   * Software queue purge alone is insufficient: up to 20 ms is already
   * visible in cyclic DMA. Disable waits for the sole writer, resets IDF's DMA
   * cursor/queue, and makes READY-state preloading legal. Only after that
   * physical barrier do we acknowledge the generation or interruption token.
   */
  esp_err_t hardware_status = i2s_channel_disable(
      owner.playback_channel);
  const enum iterate_kit_status playback_status =
      iterate_kit_pcm_clock_playback_reset(&owner.playback);
  iterate_kit_voice_pe_playback_resampler_reset(
      &owner.playback_resampler);
  const enum iterate_kit_status lane_status =
      iterate_kit_pcm_lane_discard_downlink(
          owner.lane, &discarded_frames);
  if (hardware_status == ESP_OK) {
    hardware_status = preload_playback_silence();
  }
  if (hardware_status == ESP_OK) {
    hardware_status = i2s_channel_enable(owner.playback_channel);
  }

  atomic_saturating_increment(&owner.metrics.playback_resets);
  atomic_saturating_add(
      &owner.metrics.downlink_frames_discarded_by_reset,
      discarded_frames);
  if (hardware_status != ESP_OK ||
      playback_status != ITERATE_KIT_OK ||
      lane_status != ITERATE_KIT_OK) {
    atomic_saturating_increment(
        &owner.metrics.playback_reset_failures);
    return hardware_status != ESP_OK
        ? ITERATE_KIT_IO_ERROR
        : (playback_status != ITERATE_KIT_OK
            ? playback_status
            : lane_status);
  }
  return ITERATE_KIT_OK;
}

static bool service_playback_resets(void) {
  const bool direct_reset_requested =
      __atomic_exchange_n(
          &owner.playback_reset_requested,
          0U,
          __ATOMIC_ACQUIRE) != 0U;
  const enum iterate_kit_status fence_status =
      iterate_kit_pcm_generation_fence_service(
          &owner.generation_fence);
  enum iterate_kit_status interruption_status = ITERATE_KIT_UNAVAILABLE;
  if (fence_status == ITERATE_KIT_UNAVAILABLE) {
    interruption_status =
        iterate_kit_pcm_playback_interruption_service(
            &owner.playback_interruption);
  }
  if (fence_status == ITERATE_KIT_UNAVAILABLE &&
      interruption_status == ITERATE_KIT_UNAVAILABLE &&
      direct_reset_requested) {
    return reset_playback_state(NULL) == ITERATE_KIT_OK;
  }
  if (fence_status != ITERATE_KIT_OK &&
      fence_status != ITERATE_KIT_UNAVAILABLE) {
    return false;
  }
  if (interruption_status != ITERATE_KIT_OK &&
      interruption_status != ITERATE_KIT_UNAVAILABLE) {
    return false;
  }
  /*
   * One acknowledged reset per edge is enough. Overlapping direct reset is
   * coalesced into that physical purge; retaining it for another purge would
   * add obsolete silence and CPU work without making older audio safer.
   */
  return true;
}

static void note_timing(
    volatile uint32_t *last,
    volatile uint32_t *maximum,
    int64_t started_at_us) {
  const uint32_t elapsed = monotonic_us_since(started_at_us);
  __atomic_store_n(last, elapsed, __ATOMIC_RELAXED);
  atomic_note_maximum(maximum, elapsed);
}

static void playback_task_main(void *context) {
  (void)context;
  wait_until_running();
  uint32_t consecutive_failures = 0U;

  for (;;) {
    if (!service_playback_resets()) {
      __atomic_store_n(&owner.playback_failed, 1U, __ATOMIC_RELEASE);
      vTaskSuspend(NULL);
    }

    struct iterate_kit_pcm_clock_playback_result result;
    const enum iterate_kit_status render_status =
        iterate_kit_pcm_clock_playback_render(
            &owner.playback,
            monotonic_ms(),
            owner.playback_pcm,
            ITERATE_KIT_VOICE_PE_PLAYBACK_EDGE_SAMPLES,
            &result);
    if (render_status != ITERATE_KIT_OK) {
      atomic_saturating_increment(
          &owner.metrics.playback_policy_errors);
    }
    const struct iterate_kit_pcm_clock_playback_metrics *clock_metrics =
        iterate_kit_pcm_clock_playback_metrics(&owner.playback);
    if (clock_metrics != NULL) {
      __atomic_store_n(
          &owner.metrics.last_receive_to_render_ms,
          clock_metrics->last_receive_to_render_ms,
          __ATOMIC_RELAXED);
      atomic_note_maximum(
          &owner.metrics.maximum_receive_to_render_ms,
          clock_metrics->maximum_receive_to_render_ms);
    }

    size_t hardware_words = 0U;
    const enum iterate_kit_status format_status =
        iterate_kit_voice_pe_expand_playback(
            &owner.playback_resampler,
            owner.playback_pcm,
            ITERATE_KIT_VOICE_PE_PLAYBACK_EDGE_SAMPLES,
            owner.playback_i2s,
            sizeof(owner.playback_i2s) /
                sizeof(owner.playback_i2s[0]),
            &hardware_words);
    if (format_status != ITERATE_KIT_OK ||
        hardware_words != sizeof(owner.playback_i2s) /
            sizeof(owner.playback_i2s[0])) {
      atomic_saturating_increment(
          &owner.metrics.playback_policy_errors);
      __atomic_store_n(&owner.playback_failed, 1U, __ATOMIC_RELEASE);
      vTaskSuspend(NULL);
    }

    size_t bytes_written = 0U;
    const int64_t write_started_at_us = esp_timer_get_time();
    const esp_err_t write_status = i2s_channel_write(
        owner.playback_channel,
        owner.playback_i2s,
        sizeof(owner.playback_i2s),
        &bytes_written,
        VOICE_PE_PLAYBACK_WRITE_TIMEOUT_MS);
    note_timing(
        &owner.metrics.last_playback_write_us,
        &owner.metrics.maximum_playback_write_us,
        write_started_at_us);

    if (write_status == ESP_OK &&
        bytes_written == sizeof(owner.playback_i2s)) {
      consecutive_failures = 0U;
      atomic_saturating_increment(&owner.metrics.playback_edges);
      atomic_saturating_add(
          &owner.metrics.playback_content_samples,
          result.content_samples);
      atomic_saturating_add(
          &owner.metrics.playback_silence_samples,
          result.silence_samples);
      continue;
    }

    atomic_saturating_increment(&owner.metrics.playback_write_errors);
    if (bytes_written != 0U &&
        bytes_written != sizeof(owner.playback_i2s)) {
      atomic_saturating_increment(
          &owner.metrics.playback_partial_writes);
    }
    if (consecutive_failures != UINT32_MAX) {
      ++consecutive_failures;
    }

    /*
     * Never retry a suffix. A partial IDF write has already changed which DMA
     * descriptors contain this edge; retrying would duplicate time. Purging
     * both physical DMA and the application lane restores "now" before the
     * next sample. Repeated hardware failure terminates instead of spinning.
     */
    if (reset_playback_state(NULL) != ITERATE_KIT_OK ||
        consecutive_failures >= VOICE_PE_IO_FAILURE_LIMIT) {
      __atomic_store_n(&owner.playback_failed, 1U, __ATOMIC_RELEASE);
      vTaskSuspend(NULL);
    }
  }
}

static bool reset_capture_channel(void) {
  esp_err_t status = i2s_channel_disable(owner.capture_channel);
  if (status == ESP_OK) {
    status = i2s_channel_enable(owner.capture_channel);
  }
  atomic_saturating_increment(&owner.metrics.capture_resets);
  if (status != ESP_OK) {
    atomic_saturating_increment(
        &owner.metrics.capture_reset_failures);
    return false;
  }
  return true;
}

static void poll_capture_turn(void) {
  const enum iterate_kit_status status =
      iterate_kit_pcm_capture_turn_poll(
          &owner.capture_turn, monotonic_ms());
  if (status != ITERATE_KIT_OK &&
      status != ITERATE_KIT_UNAVAILABLE &&
      status != ITERATE_KIT_BACKPRESSURE) {
    atomic_saturating_increment(
        &owner.metrics.capture_turn_poll_failures);
    atomic_saturating_increment(
        &owner.metrics.capture_failure_incidents);
  }
}

static void capture_task_main(void *context) {
  (void)context;
  wait_until_running();
  uint32_t consecutive_failures = 0U;

  for (;;) {
    /*
     * Apply lifecycle intent at the sole publication producer before taking
     * the next complete hardware frame. Server VAD suppresses a device turn
     * marker; closing the gate only prevents later frames from publication.
     */
    poll_capture_turn();

    size_t bytes_read = 0U;
    const int64_t read_started_at_us = esp_timer_get_time();
    const esp_err_t read_status = i2s_channel_read(
        owner.capture_channel,
        owner.capture_i2s,
        sizeof(owner.capture_i2s),
        &bytes_read,
        VOICE_PE_CAPTURE_READ_TIMEOUT_MS);
    const int64_t captured_at_us = esp_timer_get_time();
    note_timing(
        &owner.metrics.last_capture_read_us,
        &owner.metrics.maximum_capture_read_us,
        read_started_at_us);

    if (read_status != ESP_OK ||
        bytes_read != sizeof(owner.capture_i2s)) {
      atomic_saturating_increment(&owner.metrics.capture_read_errors);
      if (bytes_read != 0U &&
          bytes_read != sizeof(owner.capture_i2s)) {
        atomic_saturating_increment(
            &owner.metrics.capture_partial_reads);
      }
      atomic_saturating_increment(
          &owner.metrics.capture_failure_incidents);
      if (consecutive_failures != UINT32_MAX) {
        ++consecutive_failures;
      }

      /*
       * A timeout/partial read represents a capture-time discontinuity. IDF's
       * RX enable path clears its descriptor queue, which abandons old history
       * and resumes with current samples. No partial suffix is retained or
       * published, and recovery therefore cannot build latency debt.
       */
      if (!reset_capture_channel() ||
          consecutive_failures >= VOICE_PE_IO_FAILURE_LIMIT) {
        __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
        vTaskSuspend(NULL);
      }
      continue;
    }
    consecutive_failures = 0U;

    size_t extracted_frames = 0U;
    const enum iterate_kit_status format_status =
        iterate_kit_voice_pe_extract_capture(
            owner.capture_i2s,
            ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES,
            owner.capture_clean,
            owner.capture_raw,
            ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES,
            &extracted_frames);
    if (format_status != ITERATE_KIT_OK ||
        extracted_frames != ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES) {
      atomic_saturating_increment(&owner.metrics.capture_format_errors);
      atomic_saturating_increment(
          &owner.metrics.capture_failure_incidents);
      __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
      vTaskSuspend(NULL);
    }

    struct voice_pe_signal_window observation;
    measure_signal_window(
        owner.capture_raw,
        owner.capture_clean,
        ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES,
        &observation);
    if (observation.sampled_samples == 0U || captured_at_us < 0) {
      atomic_saturating_increment(
          &owner.metrics.aec_signal_measurement_failures);
    } else {
      merge_signal_observation(
          &observation, (uint64_t)captured_at_us);
    }

    const bool publication_was_active =
        iterate_kit_pcm_capture_turn_is_active(
            &owner.capture_turn);
    const uint64_t captured_through_at_us = captured_at_us < 0
        ? 0U
        : (uint64_t)captured_at_us;
    const enum iterate_kit_status submit_status =
        iterate_kit_pcm_capture_turn_submit(
            &owner.capture_turn,
            owner.capture_clean,
            ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES,
            ITERATE_KIT_VOICE_PE_CAPTURE_RATE_HZ,
            captured_through_at_us);
    if (submit_status == ITERATE_KIT_OK && publication_was_active) {
      const int64_t now_us = esp_timer_get_time();
      if (now_us >= 0 && (uint64_t)now_us >= captured_through_at_us) {
        const uint64_t elapsed =
            (uint64_t)now_us - captured_through_at_us;
        const uint32_t bounded = elapsed > UINT32_MAX
            ? UINT32_MAX
            : (uint32_t)elapsed;
        __atomic_store_n(
            &owner.metrics.last_capture_to_uplink_us,
            bounded,
            __ATOMIC_RELAXED);
        atomic_note_maximum(
            &owner.metrics.maximum_capture_to_uplink_us,
            bounded);
      }
    }
    /*
     * BACKPRESSURE is deliberately not retried: pcm_lane records the incident
     * and asks the transport to destroy the stale epoch. A retry queue here
     * would preserve old speech and turn a network outage into conversational
     * delay. Non-pressure errors remain visible in capture_turn metrics.
     */
    atomic_saturating_increment(&owner.metrics.capture_frames);
  }
}

static bool valid_options(
    const struct iterate_kit_voice_pe_audio_owner_options *options) {
  return options != NULL && options->lane != NULL &&
      options->lane->initialized &&
      options->maximum_downlink_frame_age_ms > 0U &&
      options->maximum_lane_items_per_playback_edge > 0U;
}

esp_err_t iterate_kit_voice_pe_audio_owner_start(
    const struct iterate_kit_voice_pe_audio_owner_options *options) {
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
  const struct iterate_kit_pcm_clock_playback_options playback_options = {
    .lane = owner.lane,
    .retained_frame = owner.retained_downlink,
    .retained_frame_capacity =
        ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME,
    .maximum_frame_age_ms = options->maximum_downlink_frame_age_ms,
    .maximum_lane_items_per_render =
        options->maximum_lane_items_per_playback_edge,
  };
  if (iterate_kit_pcm_clock_playback_init(
          &owner.playback, &playback_options) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_pcm_capture_turn_options capture_options = {
    .lane = owner.lane,
    .stop_boundary =
        ITERATE_KIT_PCM_CAPTURE_STOP_SUPPRESS_END_MARKER,
    .notify_uplink = options->notify_uplink,
    .notify_uplink_context = options->notify_uplink_context,
  };
  if (iterate_kit_pcm_capture_turn_init(
          &owner.capture_turn, &capture_options) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_pcm_generation_fence_options fence_options = {
    .reset = reset_playback_state,
    .reset_context = NULL,
    /* Blocking TX reaches a physical 10 ms edge without a separate wake. */
    .notify_consumer = NULL,
    .notify_consumer_context = NULL,
  };
  if (iterate_kit_pcm_generation_fence_init(
          &owner.generation_fence, &fence_options) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  const struct iterate_kit_pcm_playback_interruption_options
      interruption_options = {
        .reset = reset_playback_state,
        .reset_context = NULL,
        .notify_consumer = NULL,
        .notify_consumer_context = NULL,
      };
  if (iterate_kit_pcm_playback_interruption_init(
          &owner.playback_interruption,
          &interruption_options) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_STATE;
  }
  iterate_kit_voice_pe_playback_resampler_reset(
      &owner.playback_resampler);

  owner.playback_task = xTaskCreateStaticPinnedToCore(
      playback_task_main,
      "voice-pe-tx",
      sizeof(owner.playback_stack),
      NULL,
      VOICE_PE_AUDIO_TASK_PRIORITY,
      owner.playback_stack,
      &owner.playback_task_control,
      VOICE_PE_AUDIO_TASK_CORE);
  owner.capture_task = xTaskCreateStaticPinnedToCore(
      capture_task_main,
      "voice-pe-rx",
      sizeof(owner.capture_stack),
      NULL,
      VOICE_PE_AUDIO_TASK_PRIORITY,
      owner.capture_stack,
      &owner.capture_task_control,
      VOICE_PE_AUDIO_TASK_CORE);
  if (owner.playback_task == NULL || owner.capture_task == NULL) {
    __atomic_store_n(&owner.playback_failed, 1U, __ATOMIC_RELEASE);
    __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
    return ESP_ERR_NO_MEM;
  }

  const esp_err_t hardware_status = initialize_hardware();
  if (hardware_status != ESP_OK) {
    __atomic_store_n(&owner.playback_failed, 1U, __ATOMIC_RELEASE);
    __atomic_store_n(&owner.capture_failed, 1U, __ATOMIC_RELEASE);
    return hardware_status;
  }

  __atomic_store_n(&owner.running, 1U, __ATOMIC_RELEASE);
  __atomic_store_n(&owner.ready, 1U, __ATOMIC_RELEASE);
  xTaskNotifyGive(owner.playback_task);
  xTaskNotifyGive(owner.capture_task);

  ESP_LOGI(
      TAG,
      "ready: capture=16k stereo32 5x320; playback=48k stereo32 "
      "6x480; wire=16k mono16; static owner=%u bytes",
      (unsigned)sizeof(owner));
  ESP_LOGI(
      TAG,
      "XMOS channel0=AGC(clean/AEC), channel1=NONE(original mic); "
      "server VAD; no device turn markers");
  return ESP_OK;
}

void iterate_kit_voice_pe_audio_owner_request_playback_reset(void) {
  if (__atomic_load_n(&owner.started, __ATOMIC_ACQUIRE) == 0U) {
    return;
  }
  __atomic_store_n(
      &owner.playback_reset_requested, 1U, __ATOMIC_RELEASE);
}

enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_request_playback_interruption(
    void *context, uint32_t *token) {
  (void)context;
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return iterate_kit_pcm_playback_interruption_request(
      &owner.playback_interruption, token);
}

enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_poll_playback_interruption(
    void *context, uint32_t token) {
  (void)context;
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return iterate_kit_pcm_playback_interruption_poll(
      &owner.playback_interruption, token);
}

enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_downlink_generation_barrier(
    void *context,
    uint32_t generation,
    bool connected) {
  (void)context;
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return iterate_kit_pcm_generation_fence_poll(
      &owner.generation_fence, generation, connected);
}

enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_request_uplink_active(bool active) {
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U ||
      __atomic_load_n(&owner.capture_failed, __ATOMIC_ACQUIRE) != 0U ||
      owner.capture_task == NULL) {
    return ITERATE_KIT_STATE_ERROR;
  }
  const enum iterate_kit_status status =
      iterate_kit_pcm_capture_turn_request(
          &owner.capture_turn, active);
  /*
   * Do not pretend a task notification can wake i2s_channel_read(): it blocks
   * on the driver's descriptor queue, not the task-notification slot. The
   * capture clock reaches the command within one 20 ms frame, and the SPSC
   * command ring—not a best-effort wake—owns delivery.
   */
  return status;
}

void iterate_kit_voice_pe_audio_owner_metrics_snapshot(
    struct iterate_kit_voice_pe_audio_owner_metrics *snapshot) {
  if (snapshot == NULL) {
    return;
  }
  memset(snapshot, 0, sizeof(*snapshot));
  snapshot->ready = atomic_load(&owner.ready) != 0U;
  snapshot->playback_failed = atomic_load(&owner.playback_failed) != 0U;
  snapshot->capture_failed = atomic_load(&owner.capture_failed) != 0U;
  snapshot->capture_rate_hz = ITERATE_KIT_VOICE_PE_CAPTURE_RATE_HZ;
  snapshot->playback_rate_hz = ITERATE_KIT_VOICE_PE_PLAYBACK_RATE_HZ;
  snapshot->capture_dma_frame_samples = VOICE_PE_CAPTURE_DMA_FRAMES;
  snapshot->playback_dma_frame_samples = VOICE_PE_PLAYBACK_DMA_FRAMES;
  snapshot->capture_dma_descriptor_count =
      VOICE_PE_CAPTURE_DMA_DESCRIPTOR_COUNT;
  snapshot->playback_dma_descriptor_count =
      VOICE_PE_PLAYBACK_DMA_DESCRIPTOR_COUNT;
  snapshot->capture_dma_reserve_ms =
      (VOICE_PE_CAPTURE_DMA_DESCRIPTOR_COUNT - 1U) *
      VOICE_PE_CAPTURE_DMA_FRAMES * 1000U /
      ITERATE_KIT_VOICE_PE_CAPTURE_RATE_HZ;
  snapshot->playback_dma_reserve_ms =
      (VOICE_PE_PLAYBACK_DMA_DESCRIPTOR_COUNT - 1U) *
      VOICE_PE_PLAYBACK_DMA_FRAMES * 1000U /
      ITERATE_KIT_VOICE_PE_PLAYBACK_RATE_HZ;
  snapshot->static_owner_bytes = sizeof(owner);
  if (owner.lane != NULL) {
    iterate_kit_pcm_lane_metrics(owner.lane, &snapshot->lane);
  }
  iterate_kit_pcm_capture_turn_metrics(
      &owner.capture_turn, &snapshot->capture_turn);
  iterate_kit_pcm_generation_fence_metrics(
      &owner.generation_fence, &snapshot->generation_fence);
  iterate_kit_pcm_playback_interruption_metrics(
      &owner.playback_interruption,
      &snapshot->playback_interruption);

#define COPY_ATOMIC_METRIC(name) \
  snapshot->name = atomic_load(&owner.metrics.name)
  COPY_ATOMIC_METRIC(playback_edges);
  COPY_ATOMIC_METRIC(playback_content_samples);
  COPY_ATOMIC_METRIC(playback_silence_samples);
  COPY_ATOMIC_METRIC(playback_policy_errors);
  COPY_ATOMIC_METRIC(playback_write_errors);
  COPY_ATOMIC_METRIC(playback_partial_writes);
  COPY_ATOMIC_METRIC(playback_queue_overflows);
  COPY_ATOMIC_METRIC(playback_resets);
  COPY_ATOMIC_METRIC(playback_reset_failures);
  COPY_ATOMIC_METRIC(downlink_frames_discarded_by_reset);
  COPY_ATOMIC_METRIC(last_playback_write_us);
  COPY_ATOMIC_METRIC(maximum_playback_write_us);
  COPY_ATOMIC_METRIC(last_receive_to_render_ms);
  COPY_ATOMIC_METRIC(maximum_receive_to_render_ms);
  COPY_ATOMIC_METRIC(capture_frames);
  COPY_ATOMIC_METRIC(capture_read_errors);
  COPY_ATOMIC_METRIC(capture_partial_reads);
  COPY_ATOMIC_METRIC(capture_queue_overflows);
  COPY_ATOMIC_METRIC(capture_resets);
  COPY_ATOMIC_METRIC(capture_reset_failures);
  COPY_ATOMIC_METRIC(capture_format_errors);
  COPY_ATOMIC_METRIC(capture_turn_poll_failures);
  COPY_ATOMIC_METRIC(aec_signal_measurement_failures);
  COPY_ATOMIC_METRIC(last_capture_read_us);
  COPY_ATOMIC_METRIC(maximum_capture_read_us);
  COPY_ATOMIC_METRIC(last_capture_to_uplink_us);
  COPY_ATOMIC_METRIC(maximum_capture_to_uplink_us);
#undef COPY_ATOMIC_METRIC

  snapshot->clean_uplink_frames =
      snapshot->capture_turn.frames_accepted;
  const uint64_t clean_drops =
      (uint64_t)snapshot->capture_turn.frame_backpressure +
      snapshot->capture_turn.frame_failures;
  snapshot->clean_uplink_drops = clean_drops > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)clean_drops;
  snapshot->capture_failures =
      atomic_load(&owner.metrics.capture_failure_incidents);

  if (owner.playback_task != NULL) {
    snapshot->playback_stack_minimum_free_bytes =
        (uint32_t)uxTaskGetStackHighWaterMark(owner.playback_task);
  }
  if (owner.capture_task != NULL) {
    snapshot->capture_stack_minimum_free_bytes =
        (uint32_t)uxTaskGetStackHighWaterMark(owner.capture_task);
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

static uint32_t bounded_mean(uint64_t sum, uint64_t count) {
  if (count == 0U) {
    return 0U;
  }
  const uint64_t mean = sum / count;
  return mean > UINT32_MAX ? UINT32_MAX : (uint32_t)mean;
}

enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_aec_signal_metrics_snapshot(
    struct iterate_kit_voice_pe_aec_signal_metrics *snapshot) {
  if (snapshot == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  struct voice_pe_signal_window window;
  portENTER_CRITICAL(&signal_window_mux);
  if (owner.latest_signal_sequence == 0U) {
    window = owner.current_signal_window;
    snapshot->sequence = 0U;
    snapshot->window_started_at_us =
        owner.current_signal_started_at_us;
    snapshot->produced_at_us = 0U;
  } else {
    window = owner.latest_signal_window;
    snapshot->sequence = owner.latest_signal_sequence;
    snapshot->window_started_at_us =
        owner.latest_signal_started_at_us;
    snapshot->produced_at_us =
        owner.latest_signal_produced_at_us;
  }
  portEXIT_CRITICAL(&signal_window_mux);

  if (snapshot->produced_at_us == 0U) {
    const int64_t now_us = esp_timer_get_time();
    snapshot->produced_at_us = now_us < 0 ? 0U : (uint64_t)now_us;
  }
  snapshot->signal = (struct iterate_kit_voice_pe_aec_signal_summary){
    .sample_stride = VOICE_PE_AEC_SIGNAL_SAMPLE_STRIDE,
    .sampled_samples = window.sampled_samples > UINT32_MAX
        ? UINT32_MAX
        : (uint32_t)window.sampled_samples,
    .raw_peak = window.raw_peak,
    .clean_peak = window.clean_peak,
    .raw_mean_absolute = bounded_mean(
        window.raw_absolute_sum, window.sampled_samples),
    .clean_mean_absolute = bounded_mean(
        window.clean_absolute_sum, window.sampled_samples),
  };
  return ITERATE_KIT_OK;
}
