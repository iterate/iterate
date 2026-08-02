#include "iterate/kit/platforms/core_s3_bsp_audio.h"
/*
 * SPDX-FileCopyrightText: 2024 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include "esp_err.h"
#include "esp_attr.h"
#include "bsp/m5stack_core_s3.h"
#include "driver/i2s_tdm.h"
#include "esp_timer.h"
#include "bsp_err_check.h"
#include "esp_codec_dev_defaults.h"

static const char *TAG = "M5Stack";

static i2s_chan_handle_t i2s_tx_chan = NULL;
static i2s_chan_handle_t i2s_rx_chan = NULL;
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

/* Can be used for i2s_std_gpio_config_t and/or i2s_std_config_t initialization */
#define BSP_I2S_GPIO_CFG       \
    {                          \
        .mclk = BSP_I2S_MCLK,  \
        .bclk = BSP_I2S_SCLK,  \
        .ws = BSP_I2S_LCLK,    \
        .dout = BSP_I2S_DOUT,  \
        .din = BSP_I2S_DSIN,   \
        .invert_flags = {      \
            .mclk_inv = false, \
            .bclk_inv = false, \
            .ws_inv = false,   \
        },                     \
    }

/* This configuration is used by default in bsp_audio_init() */
#define BSP_I2S_DUPLEX_MONO_CFG(_sample_rate)                                                         \
    {                                                                                                 \
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(_sample_rate),                                          \
        .slot_cfg = I2S_STD_PHILIP_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO), \
        .gpio_cfg = BSP_I2S_GPIO_CFG,                                                                 \
    }

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
