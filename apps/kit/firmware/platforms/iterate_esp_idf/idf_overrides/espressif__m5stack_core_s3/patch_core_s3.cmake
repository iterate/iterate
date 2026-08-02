#
# Exact-source CoreS3 BSP 3.0.2 audio patch.
#
# The replacement is intentionally generated instead of checking in a fork of
# the board package. Exact-once guards make the maintenance burden honest: a
# future BSP edit fails loudly at configure time, and the rest of the component
# continues to receive upstream fixes through the managed dependency.
#

function(iterate_kit_core_s3_replace_exactly_once
    source_variable search replacement description)
  set(source "${${source_variable}}")
  string(FIND "${source}" "${search}" first_offset)
  if(first_offset EQUAL -1)
    message(FATAL_ERROR
      "Iterate CoreS3 patch no longer matches: ${description}")
  endif()
  string(LENGTH "${search}" search_length)
  math(EXPR remainder_offset "${first_offset} + ${search_length}")
  string(SUBSTRING "${source}" ${remainder_offset} -1 remainder)
  string(FIND "${remainder}" "${search}" second_offset)
  if(NOT second_offset EQUAL -1)
    message(FATAL_ERROR
      "Iterate CoreS3 patch became ambiguous: ${description}")
  endif()
  string(REPLACE "${search}" "${replacement}" patched "${source}")
  set(${source_variable} "${patched}" PARENT_SCOPE)
endfunction()

function(iterate_kit_patch_core_s3_audio_source input_path output_path)
  file(READ "${input_path}" source)

  set(search [=[
#include "esp_err.h"
#include "bsp/m5stack_core_s3.h"
]=])
  set(replacement [=[
#include "esp_err.h"
#include "esp_attr.h"
#include "bsp/m5stack_core_s3.h"
#include "driver/i2s_tdm.h"
#include "esp_timer.h"
]=])
  iterate_kit_core_s3_replace_exactly_once(
    source "${search}" "${replacement}" "audio ISR dependencies")

  set(search [=[
static const audio_codec_data_if_t *i2s_data_if = NULL;  /* Codec data interface */


]=])
  set(replacement [=[
static const audio_codec_data_if_t *i2s_data_if = NULL;  /* Codec data interface */

/*
 * ITERATE PATCH: callbacks report physical DMA completion, not codec API copy
 * completion. They intentionally contain no queue policy; the Iterate CoreS3
 * platform installs one bounded ISR consumer and owns all loss handling.
 */
static DRAM_ATTR uint32_t i2s_tx_dma_events;
static DRAM_ATTR uint32_t i2s_tx_queue_overflows;
static DRAM_ATTR uint32_t i2s_rx_dma_events;
static DRAM_ATTR uint32_t i2s_rx_queue_overflows;
static DRAM_ATTR uint32_t i2s_tx_dma_sequence;
static DRAM_ATTR uint32_t i2s_rx_dma_sequence;
static iterate_kit_core_s3_i2s_tap_callback_t i2s_tap_callback;
static void *i2s_tap_user_data;

static bool IRAM_ATTR on_i2s_tx_sent(i2s_chan_handle_t handle,
                                    i2s_event_data_t *event,
                                    void *user_data)
{
    (void)handle;
    (void)user_data;
    __atomic_fetch_add(&i2s_tx_dma_events, 1, __ATOMIC_RELAXED);
    const uint32_t sequence =
        __atomic_add_fetch(&i2s_tx_dma_sequence, 1, __ATOMIC_RELAXED);
    iterate_kit_core_s3_i2s_tap_callback_t callback = __atomic_load_n(
        &i2s_tap_callback, __ATOMIC_ACQUIRE);
    if (callback == NULL || event == NULL || event->dma_buf == NULL) {
        return false;
    }
    return callback(
        true, sequence, (uint64_t)esp_timer_get_time(),
        event->dma_buf, event->size,
        __atomic_load_n(&i2s_tap_user_data, __ATOMIC_RELAXED));
}

static bool IRAM_ATTR on_i2s_tx_queue_overflow(i2s_chan_handle_t handle,
                                               i2s_event_data_t *event,
                                               void *user_data)
{
    (void)handle;
    (void)event;
    (void)user_data;
    __atomic_fetch_add(&i2s_tx_queue_overflows, 1, __ATOMIC_RELAXED);
    return false;
}

static bool IRAM_ATTR on_i2s_rx_received(i2s_chan_handle_t handle,
                                        i2s_event_data_t *event,
                                        void *user_data)
{
    (void)handle;
    (void)user_data;
    __atomic_fetch_add(&i2s_rx_dma_events, 1, __ATOMIC_RELAXED);
    const uint32_t sequence =
        __atomic_add_fetch(&i2s_rx_dma_sequence, 1, __ATOMIC_RELAXED);
    iterate_kit_core_s3_i2s_tap_callback_t callback = __atomic_load_n(
        &i2s_tap_callback, __ATOMIC_ACQUIRE);
    if (callback == NULL || event == NULL || event->dma_buf == NULL) {
        return false;
    }
    return callback(
        false, sequence, (uint64_t)esp_timer_get_time(),
        event->dma_buf, event->size,
        __atomic_load_n(&i2s_tap_user_data, __ATOMIC_RELAXED));
}

static bool IRAM_ATTR on_i2s_rx_queue_overflow(i2s_chan_handle_t handle,
                                               i2s_event_data_t *event,
                                               void *user_data)
{
    (void)handle;
    (void)event;
    (void)user_data;
    __atomic_fetch_add(&i2s_rx_queue_overflows, 1, __ATOMIC_RELAXED);
    return false;
}

]=])
  iterate_kit_core_s3_replace_exactly_once(
    source "${search}" "${replacement}" "DMA completion seam")

  set(search [=[
esp_err_t bsp_audio_init(const i2s_std_config_t *i2s_config)
{
    esp_err_t ret = ESP_FAIL;
    if (i2s_tx_chan && i2s_rx_chan) {
        /* Audio was initialized before */
        return ESP_OK;
    }

    /* Setup I2S peripheral */
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(CONFIG_BSP_I2S_NUM, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true; // Auto clear the legacy data in the DMA buffer
    BSP_ERROR_CHECK_RETURN_ERR(i2s_new_channel(&chan_cfg, &i2s_tx_chan, &i2s_rx_chan));

    /* Setup I2S channels */
    const i2s_std_config_t std_cfg_default = BSP_I2S_DUPLEX_MONO_CFG(22050);
    const i2s_std_config_t *p_i2s_cfg = &std_cfg_default;
    if (i2s_config != NULL) {
        p_i2s_cfg = i2s_config;
    }

    if (i2s_tx_chan != NULL) {
        ESP_GOTO_ON_ERROR(i2s_channel_init_std_mode(i2s_tx_chan, p_i2s_cfg), err, TAG, "I2S channel initialization failed");
        ESP_GOTO_ON_ERROR(i2s_channel_enable(i2s_tx_chan), err, TAG, "I2S enabling failed");
    }
    if (i2s_rx_chan != NULL) {
        ESP_GOTO_ON_ERROR(i2s_channel_init_std_mode(i2s_rx_chan, p_i2s_cfg), err, TAG, "I2S channel initialization failed");
        ESP_GOTO_ON_ERROR(i2s_channel_enable(i2s_rx_chan), err, TAG, "I2S enabling failed");
    }

    audio_codec_i2s_cfg_t i2s_cfg = {
        .port = CONFIG_BSP_I2S_NUM,
        .rx_handle = i2s_rx_chan,
        .tx_handle = i2s_tx_chan,
    };
    i2s_data_if = audio_codec_new_i2s_data(&i2s_cfg);
    BSP_NULL_CHECK_GOTO(i2s_data_if, err);

    return ESP_OK;

err:
    if (i2s_tx_chan) {
        i2s_del_channel(i2s_tx_chan);
    }
    if (i2s_rx_chan) {
        i2s_del_channel(i2s_rx_chan);
    }

    return ret;
}
]=])
  set(replacement [=[
static esp_err_t iterate_kit_audio_init_channels(
    const i2s_std_config_t *tx_config,
    const i2s_std_config_t *rx_std_config,
    const i2s_tdm_config_t *rx_tdm_config)
{
    esp_err_t ret = ESP_FAIL;
    if (tx_config == NULL ||
        ((rx_std_config == NULL) == (rx_tdm_config == NULL))) {
        return ESP_ERR_INVALID_ARG;
    }
    if (i2s_tx_chan && i2s_rx_chan) {
        return ESP_OK;
    }

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(
        CONFIG_BSP_I2S_NUM, I2S_ROLE_MASTER);
    /*
     * ITERATE PATCH: the IDF default 6 x 240 frames retains 90 ms at 16 kHz.
     * Five 128-frame descriptors retain 40 ms: one 32 ms ESP-SR AEC frame and
     * one 8 ms scheduling interval, without turning DMA into a speech FIFO.
     */
    chan_cfg.dma_desc_num = 5;
    chan_cfg.dma_frame_num = 128;
    chan_cfg.auto_clear = true;
    BSP_ERROR_CHECK_RETURN_ERR(
        i2s_new_channel(&chan_cfg, &i2s_tx_chan, &i2s_rx_chan));

    ESP_GOTO_ON_ERROR(
        i2s_channel_init_std_mode(i2s_tx_chan, tx_config),
        err, TAG, "I2S TX initialization failed");
    const i2s_event_callbacks_t tx_callbacks = {
        .on_recv = NULL,
        .on_recv_q_ovf = NULL,
        .on_sent = on_i2s_tx_sent,
        .on_send_q_ovf = on_i2s_tx_queue_overflow,
    };
    ESP_GOTO_ON_ERROR(
        i2s_channel_register_event_callback(
            i2s_tx_chan, &tx_callbacks, NULL),
        err, TAG, "I2S TX callback registration failed");

    if (rx_tdm_config != NULL) {
        ESP_GOTO_ON_ERROR(
            i2s_channel_init_tdm_mode(i2s_rx_chan, rx_tdm_config),
            err, TAG, "I2S TDM RX initialization failed");
    } else {
        ESP_GOTO_ON_ERROR(
            i2s_channel_init_std_mode(i2s_rx_chan, rx_std_config),
            err, TAG, "I2S standard RX initialization failed");
    }
    const i2s_event_callbacks_t rx_callbacks = {
        .on_recv = on_i2s_rx_received,
        .on_recv_q_ovf = on_i2s_rx_queue_overflow,
        .on_sent = NULL,
        .on_send_q_ovf = NULL,
    };
    ESP_GOTO_ON_ERROR(
        i2s_channel_register_event_callback(
            i2s_rx_chan, &rx_callbacks, NULL),
        err, TAG, "I2S RX callback registration failed");
    ESP_GOTO_ON_ERROR(
        i2s_channel_enable(i2s_tx_chan),
        err, TAG, "I2S TX enabling failed");
    ESP_GOTO_ON_ERROR(
        i2s_channel_enable(i2s_rx_chan),
        err, TAG, "I2S RX enabling failed");

    audio_codec_i2s_cfg_t i2s_cfg = {
        .port = CONFIG_BSP_I2S_NUM,
        .rx_handle = i2s_rx_chan,
        .tx_handle = i2s_tx_chan,
    };
    i2s_data_if = audio_codec_new_i2s_data(&i2s_cfg);
    BSP_NULL_CHECK_GOTO(i2s_data_if, err);
    return ESP_OK;

err:
    if (i2s_tx_chan) {
        i2s_del_channel(i2s_tx_chan);
        i2s_tx_chan = NULL;
    }
    if (i2s_rx_chan) {
        i2s_del_channel(i2s_rx_chan);
        i2s_rx_chan = NULL;
    }
    return ret;
}

esp_err_t bsp_audio_init(const i2s_std_config_t *i2s_config)
{
    const i2s_std_config_t default_config =
        BSP_I2S_DUPLEX_MONO_CFG(22050);
    const i2s_std_config_t *config =
        i2s_config != NULL ? i2s_config : &default_config;
    return iterate_kit_audio_init_channels(config, config, NULL);
}

esp_err_t iterate_kit_core_s3_audio_init_tdm_rx(
    const i2s_std_config_t *tx_config,
    const i2s_tdm_config_t *rx_config)
{
    return iterate_kit_audio_init_channels(tx_config, NULL, rx_config);
}
]=])
  iterate_kit_core_s3_replace_exactly_once(
    source "${search}" "${replacement}" "standard/TDM channel initialization")

  set(search [=[
const audio_codec_data_if_t *bsp_audio_get_codec_itf(void)
{
    return i2s_data_if;
}
]=])
  set(replacement [=[
const audio_codec_data_if_t *bsp_audio_get_codec_itf(void)
{
    return i2s_data_if;
}

void iterate_kit_core_s3_i2s_stats_snapshot(
    iterate_kit_core_s3_i2s_stats_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }
    snapshot->tx_dma_events =
        __atomic_load_n(&i2s_tx_dma_events, __ATOMIC_RELAXED);
    snapshot->tx_queue_overflows =
        __atomic_load_n(&i2s_tx_queue_overflows, __ATOMIC_RELAXED);
    snapshot->rx_dma_events =
        __atomic_load_n(&i2s_rx_dma_events, __ATOMIC_RELAXED);
    snapshot->rx_queue_overflows =
        __atomic_load_n(&i2s_rx_queue_overflows, __ATOMIC_RELAXED);
}

void iterate_kit_core_s3_i2s_set_tap(
    iterate_kit_core_s3_i2s_tap_callback_t callback,
    void *user_data)
{
    if (callback == NULL) {
        __atomic_store_n(&i2s_tap_callback, NULL, __ATOMIC_RELEASE);
        __atomic_store_n(&i2s_tap_user_data, NULL, __ATOMIC_RELAXED);
        return;
    }
    __atomic_store_n(&i2s_tap_user_data, user_data, __ATOMIC_RELAXED);
    __atomic_store_n(&i2s_tap_callback, callback, __ATOMIC_RELEASE);
}
]=])
  iterate_kit_core_s3_replace_exactly_once(
    source "${search}" "${replacement}" "DMA diagnostics API")

  # The generated source includes the Iterate-only declarations without
  # modifying or shadowing the upstream public BSP header.
  set(preamble [=[
#include "iterate/kit/platforms/core_s3_bsp_audio.h"
]=])
  set(source "${preamble}${source}")
  file(WRITE "${output_path}" "${source}")
endfunction()

function(iterate_kit_patch_core_s3_codec_source input_path output_path)
  file(READ "${input_path}" source)
  set(search [=[
        .max_transfer_sz = max_transfer_sz,
    };
]=])
  set(replacement [=[
        .max_transfer_sz = max_transfer_sz,
        /*
         * ITERATE PATCH: this SPI bus is created from app_main on core 0,
         * where ESP-IDF also pins Wi-Fi. AUTO affinity consequently places
         * every LCD DMA completion interrupt beside the radio even though
         * the lossy avatar task itself runs on core 1. Keep display work in
         * one scheduling domain; the separately initialized I2S interrupt
         * deliberately retains its measured baseline affinity.
         */
        .isr_cpu_id = ESP_INTR_CPU_AFFINITY_1,
    };
]=])
  iterate_kit_core_s3_replace_exactly_once(
    source "${search}" "${replacement}" "LCD SPI ISR affinity")

  set(search [=[
    es7210_codec_cfg_t es7210_cfg = {
        .ctrl_if = i2c_ctrl_if,
    };
]=])
  set(replacement [=[
    es7210_codec_cfg_t es7210_cfg = {
        .ctrl_if = i2c_ctrl_if,
        /*
         * ITERATE PATCH: MIC3 is wired to an analogue divider across speaker
         * output. Selecting MIC1..3 switches SDOUT1 to TDM and exposes near
         * microphone plus clock-aligned hardware reference to the platform.
         */
        .mic_selected =
            ES7210_SEL_MIC1 | ES7210_SEL_MIC2 | ES7210_SEL_MIC3,
    };
]=])
  iterate_kit_core_s3_replace_exactly_once(
    source "${search}" "${replacement}" "ES7210 MIC3 hardware reference")
  file(WRITE "${output_path}" "${source}")
endfunction()
