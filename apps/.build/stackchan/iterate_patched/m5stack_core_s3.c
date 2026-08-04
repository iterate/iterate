/*
 * SPDX-FileCopyrightText: 2024-2025 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/spi_master.h"
#include "driver/sdspi_host.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_spiffs.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"
#include "esp_vfs_fat.h"

#include "bsp/m5stack_core_s3.h"
#include "bsp/display.h"
#include "bsp/touch.h"
#include "esp_lcd_ili9341.h"
#include "esp_lcd_touch_ft5x06.h"
#include "bsp_err_check.h"
#include "esp_codec_dev_defaults.h"

static const char *TAG = "M5Stack";

#define BSP_AXP2101_ADDR    0x34
#define BSP_AW9523_ADDR     0x58
#define BSP_AXP2101_IRQ_STATUS_1_REG 0x49
#define BSP_AXP2101_POWER_BUTTON_EVENT_MASK 0x0C

/* Features */
typedef enum {
    BSP_FEATURE_LCD,
    BSP_FEATURE_TOUCH,
    BSP_FEATURE_SD,
    BSP_FEATURE_SPEAKER,
    BSP_FEATURE_CAMERA,
} bsp_feature_t;

#if (BSP_CONFIG_NO_GRAPHIC_LIB == 0)
static lv_display_t *disp;
static lv_indev_t *disp_indev = NULL;
#endif // (BSP_CONFIG_NO_GRAPHIC_LIB == 0)
static esp_lcd_touch_handle_t tp;   // LCD touch handle
static sdmmc_card_t *bsp_sdcard = NULL;    // Global uSD card handler

/**
 * @brief I2C handle for BSP usage
 *
 * You can call i2c_master_get_bus_handle(BSP_I2C_NUM, i2c_master_bus_handle_t *ret_handle)
 * from #include "esp_private/i2c_platform.h"
 */
static i2c_master_bus_handle_t i2c_handle = NULL;
static bool i2c_initialized = false;
static i2c_master_dev_handle_t axp2101_h = NULL;
static i2c_master_dev_handle_t aw9523_h = NULL;
static bool spi_initialized = false;
/*
 * The output latch is one board-wide register pair, not five independent
 * feature switches.  Keep its shadow beside the BSP-owned device handle so a
 * later display/audio/camera update cannot unknowingly undo external-bus
 * power established for a module such as StackChan.  No target-local driver
 * may write AW9523 output registers behind this shadow.
 */
static uint8_t aw9523_P0 = 0b00000010;
static uint8_t aw9523_P1 = 0b10100000;

esp_err_t bsp_i2c_init(void)
{
    /* I2C was initialized before */
    if (i2c_initialized) {
        return ESP_OK;
    }

    const i2c_master_bus_config_t i2c_config = {
        .i2c_port = BSP_I2C_NUM,
        .sda_io_num = BSP_I2C_SDA,
        .scl_io_num = BSP_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        /*
         * Match M5Stack's CoreS3 bus contract.  The body is reached through a
         * board-to-board connector, where the ESP's weak pull-ups are useful
         * during the interval before the powered module contributes its own.
         * A missing pull-up manifested as ESP_ERR_TIMEOUT (a held bus), not a
         * clean NACK, and therefore looked misleadingly like a slow PY32.
         */
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = 1,
    };
    BSP_ERROR_CHECK_RETURN_ERR(i2c_new_master_bus(&i2c_config, &i2c_handle));

    // AXP2101 and AW9523 are managed by this BSP
    const i2c_device_config_t axp2101_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = BSP_AXP2101_ADDR,
        .scl_speed_hz = CONFIG_BSP_I2C_CLK_SPEED_HZ,
    };
    BSP_ERROR_CHECK_RETURN_ERR(i2c_master_bus_add_device(i2c_handle, &axp2101_config, &axp2101_h));
    const i2c_device_config_t aw9523_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = BSP_AW9523_ADDR,
        .scl_speed_hz = CONFIG_BSP_I2C_CLK_SPEED_HZ,
    };
    BSP_ERROR_CHECK_RETURN_ERR(i2c_master_bus_add_device(i2c_handle, &aw9523_config, &aw9523_h));

    i2c_initialized = true;
    return ESP_OK;
}

esp_err_t bsp_i2c_deinit(void)
{
    BSP_ERROR_CHECK_RETURN_ERR(i2c_del_master_bus(i2c_handle));
    i2c_initialized = false;
    return ESP_OK;
}

esp_err_t bsp_power_button_take_events(bsp_power_button_event_t *events)
{
    if (events == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    *events = BSP_POWER_BUTTON_EVENT_NONE;
    BSP_ERROR_CHECK_RETURN_ERR(bsp_i2c_init());

    const uint8_t register_address = BSP_AXP2101_IRQ_STATUS_1_REG;
    uint8_t status = 0;
    ESP_RETURN_ON_ERROR(
        i2c_master_transmit_receive(
            axp2101_h,
            &register_address,
            sizeof(register_address),
            &status,
            sizeof(status),
            1000),
        TAG,
        "AXP2101 power-key status read failed");

    status &= BSP_AXP2101_POWER_BUTTON_EVENT_MASK;
    if (status != 0) {
        /*
         * AXP2101 IRQ status is write-one-to-clear.  Acknowledge exactly the
         * observed key bits so an unrelated PMIC condition cannot be erased
         * by an application button poll.  This mirrors M5Stack's first-party
         * getPekPress() contract while retaining ESP-IDF's error reporting.
         */
        const uint8_t acknowledge[] = {
            BSP_AXP2101_IRQ_STATUS_1_REG,
            status,
        };
        ESP_RETURN_ON_ERROR(
            i2c_master_transmit(
                axp2101_h, acknowledge, sizeof(acknowledge), 1000),
            TAG,
            "AXP2101 power-key status clear failed");
    }
    *events = (bsp_power_button_event_t)(status >> 2);
    return ESP_OK;
}

static esp_err_t bsp_enable_feature(bsp_feature_t feature)
{
    esp_err_t err = ESP_OK;
    uint8_t data[2];

    /* Initilize I2C */
    BSP_ERROR_CHECK_RETURN_ERR(bsp_i2c_init());

    switch (feature) {
    case BSP_FEATURE_LCD:
        /* Enable LCD */
        aw9523_P1 |= (1 << 1);
        break;
    case BSP_FEATURE_TOUCH:
        /* Enable Touch */
        aw9523_P0 |= (1);
        break;
    case BSP_FEATURE_SD:
        /* AXP ALDO4 voltage / SD Card / 3V3 */
        data[0] = 0x95;
        data[1] = 0b00011100; //3V3
        err |= i2c_master_transmit(axp2101_h, data, sizeof(data), 1000);
        /* Enable SD */
        aw9523_P0 |= (1 << 4);
        break;
    case BSP_FEATURE_SPEAKER:
        /* AXP ALDO1 voltage / PA PVDD / 1V8 */
        data[0] = 0x92;
        data[1] = 0b00001101; //1V8
        err |= i2c_master_transmit(axp2101_h, data, sizeof(data), 1000);
        /* AXP ALDO2 voltage / Codec / 3V3 */
        data[0] = 0x93;
        data[1] = 0b00011100; //3V3
        err |= i2c_master_transmit(axp2101_h, data, sizeof(data), 1000);
        /* AXP ALDO3 voltage / Codec+Mic / 3V3 */
        data[0] = 0x94;
        data[1] = 0b00011100; //3V3
        err |= i2c_master_transmit(axp2101_h, data, sizeof(data), 1000);
        /* Enable Codec AW88298 */
        aw9523_P0 |= (1 << 2);
        break;
    case BSP_FEATURE_CAMERA:
        /* Enable Camera */
        aw9523_P1 |= (1);
        break;
    }

    /*
     * The output latch alone does not energise a CoreS3 rail after an AW9523
     * reset: its pins remain inputs until CONFIG_P0/P1 say otherwise.  The
     * upstream ESP-IDF BSP omitted those writes, which happened to leave the
     * LCD usable but kept StackChan's M-BUS-powered PY32 body invisible at
     * 0x6f.  Use M5Stack's first-party M5Unified CoreS3 configuration here so
     * every feature update re-establishes the electrical contract before
     * changing its latch.  Keeping this in the BSP is important: a body
     * driver that writes the AW9523 independently would race this function's
     * cached P0/P1 values and could later remove display, camera, or speaker
     * power while updating an unrelated feature.
     *
     * In the AW9523 direction registers 1 means input and 0 means output.
     * P0.1 is BUS_OUT_EN and P1.7 is BOOST_EN, so both are outputs in these
     * board-specific masks.  0xff in LEDMODE selects ordinary GPIO operation;
     * the PY32 on the StackChan body, not this CoreS3 expander, owns the twelve
     * conversational LEDs.
     */
    data[0] = 0x04;
    data[1] = 0b00011000;
    err |= i2c_master_transmit(aw9523_h, data, sizeof(data), 1000);

    data[0] = 0x05;
    data[1] = 0b00001100;
    err |= i2c_master_transmit(aw9523_h, data, sizeof(data), 1000);

    /* AW9523 P0 is in push-pull mode */
    data[0] = 0x11;
    data[1] = 0x10;
    err |= i2c_master_transmit(aw9523_h, data, sizeof(data), 1000);

    data[0] = 0x12;
    data[1] = 0xff;
    err |= i2c_master_transmit(aw9523_h, data, sizeof(data), 1000);

    data[0] = 0x13;
    data[1] = 0xff;
    err |= i2c_master_transmit(aw9523_h, data, sizeof(data), 1000);

    data[0] = 0x02;
    data[1] = aw9523_P0;
    err |= i2c_master_transmit(aw9523_h, data, sizeof(data), 1000);

    data[0] = 0x03;
    data[1] = aw9523_P1;
    err |= i2c_master_transmit(aw9523_h, data, sizeof(data), 1000);

    return err;
}

esp_err_t bsp_external_power_enable(void)
{
    uint8_t register_address = 0x02;
    uint8_t outputs[2] = {0};
    uint8_t write_outputs[3];
    uint8_t configuration[4] = {0};

    BSP_ERROR_CHECK_RETURN_ERR(bsp_i2c_init());

    /*
     * This is the exact electrical operation M5Unified performs for CoreS3's
     * setExtOutput(true): BUS_OUT_EN is P0.1 and the SY7088 boost enable is
     * P1.7.  Read-modify-write matters because the output registers also own
     * display, camera, touch, speaker-reset, and USB-OTG rails.  Replaying a
     * guessed constant here would turn an external-power fix into an
     * intermittent failure in one of those unrelated peripherals.
     */
    ESP_RETURN_ON_ERROR(
        i2c_master_transmit_receive(
            aw9523_h,
            &register_address,
            sizeof(register_address),
            outputs,
            sizeof(outputs),
            1000),
        TAG,
        "AW9523 output read failed");
    outputs[0] |= 0b00000010;
    outputs[1] |= 0b10000000;
    write_outputs[0] = 0x02;
    write_outputs[1] = outputs[0];
    write_outputs[2] = outputs[1];
    ESP_RETURN_ON_ERROR(
        i2c_master_transmit(
            aw9523_h, write_outputs, sizeof(write_outputs), 1000),
        TAG,
        "AW9523 external-power write failed");
    aw9523_P0 = outputs[0];
    aw9523_P1 = outputs[1];

    /*
     * A successful I2C write proves only that the expander acknowledged.  It
     * does not prove the two pins are configured as outputs or that the
     * latches retained the requested levels.  Read the whole output/config
     * block back once so a body-probe failure can be attributed to the module
     * side of the connector rather than silently blamed on its firmware.
     */
    register_address = 0x02;
    ESP_RETURN_ON_ERROR(
        i2c_master_transmit_receive(
            aw9523_h,
            &register_address,
            sizeof(register_address),
            configuration,
            sizeof(configuration),
            1000),
        TAG,
        "AW9523 external-power readback failed");
    ESP_LOGI(TAG,
             "external power readback: P0=0x%02x P1=0x%02x CFG0=0x%02x CFG1=0x%02x",
             configuration[0], configuration[1], configuration[2], configuration[3]);
    if ((configuration[0] & 0b00000010) == 0 ||
        (configuration[1] & 0b10000000) == 0 ||
        (configuration[2] & 0b00000010) != 0 ||
        (configuration[3] & 0b10000000) != 0) {
        ESP_LOGE(TAG, "external power readback violates CoreS3 BUS/BOOST contract");
        return ESP_ERR_INVALID_RESPONSE;
    }
    return ESP_OK;
}

static esp_err_t bsp_spi_init(uint32_t max_transfer_sz)
{
    /* SPI was initialized before */
    if (spi_initialized) {
        return ESP_OK;
    }

    ESP_LOGD(TAG, "Initialize SPI bus");
    const spi_bus_config_t buscfg = {
        .sclk_io_num = BSP_LCD_PCLK,
        .mosi_io_num = BSP_LCD_MOSI,
        .miso_io_num = BSP_LCD_MISO,
        .quadwp_io_num = GPIO_NUM_NC,
        .quadhd_io_num = GPIO_NUM_NC,
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
    ESP_RETURN_ON_ERROR(spi_bus_initialize(BSP_LCD_SPI_NUM, &buscfg, SPI_DMA_CH_AUTO), TAG, "SPI init failed");

    spi_initialized = true;

    return ESP_OK;
}

esp_err_t bsp_spiffs_mount(void)
{
    esp_vfs_spiffs_conf_t conf = {
        .base_path = CONFIG_BSP_SPIFFS_MOUNT_POINT,
        .partition_label = CONFIG_BSP_SPIFFS_PARTITION_LABEL,
        .max_files = CONFIG_BSP_SPIFFS_MAX_FILES,
#ifdef CONFIG_BSP_SPIFFS_FORMAT_ON_MOUNT_FAIL
        .format_if_mount_failed = true,
#else
        .format_if_mount_failed = false,
#endif
    };

    esp_err_t ret_val = esp_vfs_spiffs_register(&conf);

    BSP_ERROR_CHECK_RETURN_ERR(ret_val);

    size_t total = 0, used = 0;
    ret_val = esp_spiffs_info(conf.partition_label, &total, &used);
    if (ret_val != ESP_OK) {
        ESP_LOGE(TAG, "Failed to get SPIFFS partition information (%s)", esp_err_to_name(ret_val));
    } else {
        ESP_LOGI(TAG, "Partition size: total: %d, used: %d", total, used);
    }

    return ret_val;
}

esp_err_t bsp_spiffs_unmount(void)
{
    return esp_vfs_spiffs_unregister(CONFIG_BSP_SPIFFS_PARTITION_LABEL);
}

sdmmc_card_t *bsp_sdcard_get_handle(void)
{
    return bsp_sdcard;
}

void bsp_sdcard_get_sdmmc_host(const int slot, sdmmc_host_t *config)
{
    assert(config);
    memset(config, 0, sizeof(sdmmc_host_t));
    ESP_LOGE(TAG, "SD card MMC mode is not supported by HW (Shared SPI)!");
}

void bsp_sdcard_get_sdspi_host(const int slot, sdmmc_host_t *config)
{
    assert(config);

    sdmmc_host_t host_config = SDSPI_HOST_DEFAULT();
    host_config.slot = slot;

    memcpy(config, &host_config, sizeof(sdmmc_host_t));
}

void bsp_sdcard_sdmmc_get_slot(const int slot, sdmmc_slot_config_t *config)
{
    assert(config);
    memset(config, 0, sizeof(sdmmc_slot_config_t));
    ESP_LOGE(TAG, "SD card MMC mode is not supported by HW (Shared SPI)!");
}

void bsp_sdcard_sdspi_get_slot(const spi_host_device_t spi_host, sdspi_device_config_t *config)
{
    assert(config);
    memset(config, 0, sizeof(sdspi_device_config_t));

    config->gpio_cs   = BSP_SD_SPI_CS;
    config->gpio_cd   = SDSPI_SLOT_NO_CD;
    config->gpio_wp   = SDSPI_SLOT_NO_WP;
    config->gpio_int  = GPIO_NUM_NC;
    config->host_id = spi_host;
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 2, 0)
    config->gpio_wp_polarity = SDSPI_IO_ACTIVE_LOW;
#endif
}

esp_err_t bsp_sdcard_sdmmc_mount(bsp_sdcard_cfg_t *cfg)
{
    ESP_LOGE(TAG, "SD card MMC mode is not supported by HW (Shared SPI)!");
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t bsp_sdcard_sdspi_mount(bsp_sdcard_cfg_t *cfg)
{
    sdmmc_host_t sdhost = {0};
    sdspi_device_config_t sdslot = {0};
    const esp_vfs_fat_sdmmc_mount_config_t mount_config = {
#ifdef CONFIG_BSP_SD_FORMAT_ON_MOUNT_FAIL
        .format_if_mount_failed = true,
#else
        .format_if_mount_failed = false,
#endif
        .max_files = 5,
        .allocation_unit_size = 16 * 1024
    };
    assert(cfg);

    BSP_ERROR_CHECK_RETURN_ERR(bsp_enable_feature(BSP_FEATURE_SD));

    ESP_RETURN_ON_ERROR(bsp_spi_init((BSP_LCD_H_RES * BSP_LCD_V_RES) * sizeof(uint16_t)), TAG, "");

    if (!cfg->mount) {
        cfg->mount = &mount_config;
    }

    if (!cfg->host) {
        bsp_sdcard_get_sdspi_host(SDMMC_HOST_SLOT_0, &sdhost);
        cfg->host = &sdhost;
    }

    if (!cfg->slot.sdspi) {
        bsp_sdcard_sdspi_get_slot(BSP_SDSPI_HOST, &sdslot);
        cfg->slot.sdspi = &sdslot;
    }

#if !CONFIG_FATFS_LONG_FILENAMES
    ESP_LOGW(TAG, "Warning: Long filenames on SD card are disabled in menuconfig!");
#endif

    return esp_vfs_fat_sdspi_mount(BSP_SD_MOUNT_POINT, cfg->host, cfg->slot.sdspi, cfg->mount, &bsp_sdcard);
}

esp_err_t bsp_sdcard_mount(void)
{
    bsp_sdcard_cfg_t cfg = {0};
    return bsp_sdcard_sdspi_mount(&cfg);
}

esp_err_t bsp_sdcard_unmount(void)
{
    esp_err_t ret = ESP_OK;

    ret |= esp_vfs_fat_sdcard_unmount(BSP_SD_MOUNT_POINT, bsp_sdcard);
    bsp_sdcard = NULL;

    //TODO: Check if LCD initialized (when LCD deinit will be covered by BSP)
    if (spi_initialized) {
        ret |= spi_bus_free(BSP_SDSPI_HOST);
        spi_initialized = false;
    }

    return ret;
}

esp_codec_dev_handle_t bsp_audio_codec_speaker_init(void)
{
    const audio_codec_data_if_t *i2s_data_if = bsp_audio_get_codec_itf();
    if (i2s_data_if == NULL) {
        /* Initilize I2C */
        BSP_ERROR_CHECK_RETURN_NULL(bsp_i2c_init());
        /* Configure I2S peripheral and Power Amplifier */
        BSP_ERROR_CHECK_RETURN_NULL(bsp_audio_init(NULL));
        i2s_data_if = bsp_audio_get_codec_itf();
    }
    assert(i2s_data_if);

    BSP_ERROR_CHECK_RETURN_ERR(bsp_enable_feature(BSP_FEATURE_SPEAKER));

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = BSP_I2C_NUM,
        .addr = AW88298_CODEC_DEFAULT_ADDR,
        .bus_handle = i2c_handle,
    };
    const audio_codec_ctrl_if_t *out_ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);

    const audio_codec_gpio_if_t *gpio_if = audio_codec_new_gpio();

    // New output codec interface
    aw88298_codec_cfg_t aw88298_cfg = {
        .ctrl_if = out_ctrl_if,
        .gpio_if = gpio_if,
        .hw_gain.pa_gain = 15,
        // .reset_pin = -1,
    };
    const audio_codec_if_t *out_codec_if = aw88298_codec_new(&aw88298_cfg);

    esp_codec_dev_cfg_t codec_dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_OUT,
        .codec_if = out_codec_if,
        .data_if = i2s_data_if,
    };
    return esp_codec_dev_new(&codec_dev_cfg);
}

esp_codec_dev_handle_t bsp_audio_codec_microphone_init(void)
{
    const audio_codec_data_if_t *i2s_data_if = bsp_audio_get_codec_itf();
    if (i2s_data_if == NULL) {
        /* Initialize I2C */
        BSP_ERROR_CHECK_RETURN_NULL(bsp_i2c_init());
        /* Configure I2S peripheral and Power Amplifier */
        BSP_ERROR_CHECK_RETURN_NULL(bsp_audio_init(NULL));
        i2s_data_if = bsp_audio_get_codec_itf();
    }
    assert(i2s_data_if);

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = BSP_I2C_NUM,
        .addr = ES7210_CODEC_DEFAULT_ADDR,
        .bus_handle = i2c_handle,
    };
    const audio_codec_ctrl_if_t *i2c_ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    BSP_NULL_CHECK(i2c_ctrl_if, NULL);

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
    const audio_codec_if_t *es7210_dev = es7210_codec_new(&es7210_cfg);
    BSP_NULL_CHECK(es7210_dev, NULL);

    esp_codec_dev_cfg_t codec_es7210_dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
        .codec_if = es7210_dev,
        .data_if = i2s_data_if,
    };
    return esp_codec_dev_new(&codec_es7210_dev_cfg);
}

// Bit number used to represent command and parameter
#define LCD_CMD_BITS           8
#define LCD_PARAM_BITS         8
#define LCD_LEDC_CH            CONFIG_BSP_DISPLAY_BRIGHTNESS_LEDC_CH

esp_err_t bsp_display_brightness_init(void)
{
    /* Initilize I2C */
    BSP_ERROR_CHECK_RETURN_ERR(bsp_i2c_init());

    const uint8_t lcd_bl_en[] = { 0x90, 0xBF }; // AXP DLDO1 Enable
    ESP_RETURN_ON_ERROR(i2c_master_transmit(axp2101_h, lcd_bl_en, sizeof(lcd_bl_en), 1000), TAG, "I2C write failed");
    const uint8_t lcd_bl_val[] = { 0x99, 0b00011000 };  // AXP DLDO1 voltage
    ESP_RETURN_ON_ERROR(i2c_master_transmit(axp2101_h, lcd_bl_val, sizeof(lcd_bl_val), 1000), TAG, "I2C write failed");

    return ESP_OK;
}

esp_err_t bsp_display_brightness_set(int brightness_percent)
{
    if (brightness_percent > 100) {
        brightness_percent = 100;
    }
    if (brightness_percent < 0) {
        brightness_percent = 0;
    }

    ESP_LOGI(TAG, "Setting LCD backlight: %d%%", brightness_percent);
    const uint8_t reg_val = 20 + ((8 * brightness_percent) / 100); // 0b00000 ~ 0b11100; under 20, it is too dark
    const uint8_t lcd_bl_val[] = { 0x99, reg_val }; // AXP DLDO1 voltage
    ESP_RETURN_ON_ERROR(i2c_master_transmit(axp2101_h, lcd_bl_val, sizeof(lcd_bl_val), 1000), TAG, "I2C write failed");

    return ESP_OK;
}

esp_err_t bsp_display_backlight_off(void)
{
    return bsp_display_brightness_set(0);
}

esp_err_t bsp_display_backlight_on(void)
{
    return bsp_display_brightness_set(100);
}

esp_err_t bsp_display_new(const bsp_display_config_t *config, esp_lcd_panel_handle_t *ret_panel, esp_lcd_panel_io_handle_t *ret_io)
{
    esp_err_t ret = ESP_OK;
    assert(config != NULL && config->max_transfer_sz > 0);

    BSP_ERROR_CHECK_RETURN_ERR(bsp_enable_feature(BSP_FEATURE_LCD));
    BSP_ERROR_CHECK_RETURN_ERR(bsp_enable_feature(BSP_FEATURE_CAMERA));

    /* Initialize SPI */
    ESP_RETURN_ON_ERROR(bsp_spi_init(config->max_transfer_sz), TAG, "");

    ESP_LOGD(TAG, "Install panel IO");
    const esp_lcd_panel_io_spi_config_t io_config = {
        .dc_gpio_num = BSP_LCD_DC,
        .cs_gpio_num = BSP_LCD_CS,
        .pclk_hz = BSP_LCD_PIXEL_CLOCK_HZ,
        .lcd_cmd_bits = LCD_CMD_BITS,
        .lcd_param_bits = LCD_PARAM_BITS,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };
    ESP_GOTO_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)BSP_LCD_SPI_NUM, &io_config, ret_io), err, TAG, "New panel IO failed");

    ESP_LOGD(TAG, "Install LCD driver");
    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = BSP_LCD_RST, // Shared with Touch reset
        .rgb_ele_order = BSP_LCD_COLOR_SPACE,
        .bits_per_pixel = BSP_LCD_BITS_PER_PIXEL,
    };
    ESP_GOTO_ON_ERROR(esp_lcd_new_panel_ili9341(*ret_io, &panel_config, ret_panel), err, TAG, "New panel failed");

    esp_lcd_panel_reset(*ret_panel);
    esp_lcd_panel_init(*ret_panel);
    esp_lcd_panel_invert_color(*ret_panel, true);
    return ret;

err:
    if (*ret_panel) {
        esp_lcd_panel_del(*ret_panel);
    }
    if (*ret_io) {
        esp_lcd_panel_io_del(*ret_io);
    }
    spi_bus_free(BSP_LCD_SPI_NUM);
    return ret;
}

esp_err_t bsp_touch_new(const bsp_touch_config_t *config, esp_lcd_touch_handle_t *ret_touch)
{
    BSP_ERROR_CHECK_RETURN_ERR(bsp_enable_feature(BSP_FEATURE_TOUCH));

    /* Initialize touch */
    const esp_lcd_touch_config_t tp_cfg = {
        .x_max = BSP_LCD_H_RES,
        .y_max = BSP_LCD_V_RES,
        .rst_gpio_num = GPIO_NUM_NC, // Shared with LCD reset
        .int_gpio_num = BSP_LCD_TOUCH_INT,
        .levels = {
            .reset = 0,
            .interrupt = 0,
        },
        .flags = {
            .swap_xy = 0,
            .mirror_x = 0,
            .mirror_y = 0,
        },
    };
    esp_lcd_panel_io_handle_t tp_io_handle = NULL;
    esp_lcd_panel_io_i2c_config_t tp_io_config = ESP_LCD_TOUCH_IO_I2C_FT5x06_CONFIG();
    tp_io_config.scl_speed_hz = CONFIG_BSP_I2C_CLK_SPEED_HZ; // This parameter was introduced together with I2C Driver-NG in IDF v5.2
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_i2c(i2c_handle, &tp_io_config, &tp_io_handle), TAG, "");
    return esp_lcd_touch_new_i2c_ft5x06(tp_io_handle, &tp_cfg, ret_touch);
}

#if (BSP_CONFIG_NO_GRAPHIC_LIB == 0)
static lv_display_t *bsp_display_lcd_init(const bsp_display_cfg_t *cfg)
{
    assert(cfg != NULL);
    esp_lcd_panel_io_handle_t io_handle = NULL;
    esp_lcd_panel_handle_t panel_handle = NULL;
    const bsp_display_config_t bsp_disp_cfg = {
        .max_transfer_sz = BSP_LCD_DRAW_BUFF_SIZE * sizeof(uint16_t),
    };
    BSP_ERROR_CHECK_RETURN_NULL(bsp_display_new(&bsp_disp_cfg, &panel_handle, &io_handle));

    esp_lcd_panel_disp_on_off(panel_handle, true);

    /* Add LCD screen */
    ESP_LOGD(TAG, "Add LCD screen");
    const lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = io_handle,
        .panel_handle = panel_handle,
        .buffer_size = cfg->buffer_size,
        .double_buffer = cfg->double_buffer,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
        .monochrome = false,
        /* Rotation values must be same as used in esp_lcd for initial settings of the screen */
        .rotation = {
            .swap_xy = false,
            .mirror_x = false,
            .mirror_y = false,
        },
        .flags = {
            .buff_dma = cfg->flags.buff_dma,
            .buff_spiram = cfg->flags.buff_spiram,
#if LVGL_VERSION_MAJOR >= 9
            .swap_bytes = (BSP_LCD_BIGENDIAN ? true : false),
#endif
        }
    };

    return lvgl_port_add_disp(&disp_cfg);
}

static lv_indev_t *bsp_display_indev_init(lv_display_t *disp)
{
    BSP_ERROR_CHECK_RETURN_NULL(bsp_touch_new(NULL, &tp));
    assert(tp);

    /* Add touch input (for selected screen) */
    const lvgl_port_touch_cfg_t touch_cfg = {
        .disp = disp,
        .handle = tp,
    };

    return lvgl_port_add_touch(&touch_cfg);
}

lv_display_t *bsp_display_start(void)
{
    bsp_display_cfg_t cfg = {
        .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG(),
        .buffer_size = BSP_LCD_DRAW_BUFF_SIZE,
        .double_buffer = BSP_LCD_DRAW_BUFF_DOUBLE,
        .flags = {
            .buff_dma = true,
            .buff_spiram = false,
        }
    };
    cfg.lvgl_port_cfg.task_affinity = 1; /* For camera */
    return bsp_display_start_with_config(&cfg);
}

lv_display_t *bsp_display_start_with_config(const bsp_display_cfg_t *cfg)
{
    assert(cfg != NULL);
    BSP_ERROR_CHECK_RETURN_NULL(lvgl_port_init(&cfg->lvgl_port_cfg));

    BSP_ERROR_CHECK_RETURN_NULL(bsp_display_brightness_init());

    BSP_NULL_CHECK(disp = bsp_display_lcd_init(cfg), NULL);

    BSP_NULL_CHECK(disp_indev = bsp_display_indev_init(disp), NULL);

    return disp;
}

lv_indev_t *bsp_display_get_input_dev(void)
{
    return disp_indev;
}

void bsp_display_rotate(lv_display_t *disp, lv_display_rotation_t rotation)
{
    lv_disp_set_rotation(disp, rotation);
}

bool bsp_display_lock(uint32_t timeout_ms)
{
    return lvgl_port_lock(timeout_ms);
}

void bsp_display_unlock(void)
{
    lvgl_port_unlock();
}
#endif // (BSP_CONFIG_NO_GRAPHIC_LIB == 0)
