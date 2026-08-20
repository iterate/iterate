/*
 * SPDX-FileCopyrightText: 2025 Espressif Systems (Shanghai) CO LTD
 * SPDX-FileContributor: Iterate
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file
 * @brief M5Stack CoreS3 board support, distilled for StackChan.
 *
 * This is the first-party replacement for the vendored espressif
 * m5stack_core_s3 3.0.2 BSP override.  It keeps only the surface StackChan
 * calls; every pin assignment, type, and register sequence behind these
 * declarations is copied verbatim from the audited vendored sources.  The
 * include path is unchanged so consumers keep reading like BSP users.
 */

#pragma once

#include "driver/gpio.h"
#include "esp_codec_dev.h"
#include "esp_err.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_types.h"

/**************************************************************************************************
 *  M5Stack-Core-S3 pinout
 **************************************************************************************************/

/* I2C */
#define BSP_I2C_SCL           (GPIO_NUM_11)
#define BSP_I2C_SDA           (GPIO_NUM_12)

/* Audio */
#define BSP_I2S_SCLK          (GPIO_NUM_34)
#define BSP_I2S_MCLK          (GPIO_NUM_0)
#define BSP_I2S_LCLK          (GPIO_NUM_33)
#define BSP_I2S_DOUT          (GPIO_NUM_13) // To Codec AW88298
#define BSP_I2S_DSIN          (GPIO_NUM_14) // From ADC ES7210

/* Display */
#define BSP_LCD_MOSI          (GPIO_NUM_37)
#define BSP_LCD_MISO          (GPIO_NUM_35)
#define BSP_LCD_PCLK          (GPIO_NUM_36)
#define BSP_LCD_CS            (GPIO_NUM_3)
#define BSP_LCD_DC            (GPIO_NUM_35)
#define BSP_LCD_RST           (GPIO_NUM_NC)
#define BSP_LCD_TOUCH_INT     (GPIO_NUM_NC)

/* Camera */
#define BSP_CAMERA_XCLK      (GPIO_NUM_NC)
#define BSP_CAMERA_PCLK      (GPIO_NUM_45)
#define BSP_CAMERA_VSYNC     (GPIO_NUM_46)
#define BSP_CAMERA_HSYNC     (GPIO_NUM_38)
#define BSP_CAMERA_D0        (GPIO_NUM_39)
#define BSP_CAMERA_D1        (GPIO_NUM_40)
#define BSP_CAMERA_D2        (GPIO_NUM_41)
#define BSP_CAMERA_D3        (GPIO_NUM_42)
#define BSP_CAMERA_D4        (GPIO_NUM_15)
#define BSP_CAMERA_D5        (GPIO_NUM_16)
#define BSP_CAMERA_D6        (GPIO_NUM_48)
#define BSP_CAMERA_D7        (GPIO_NUM_47)

/*
 * Fixed board facts that were Kconfig options in the vendored BSP.  The
 * values are the ones StackChan has always built with (sdkconfig defaults).
 */
#define BSP_I2C_NUM     (1)

/* LCD display definition */
#define BSP_LCD_PIXEL_CLOCK_HZ     (40 * 1000 * 1000)
#define BSP_LCD_SPI_NUM            (SPI3_HOST)
/* LCD display color bits */
#define BSP_LCD_BITS_PER_PIXEL      (16)
/* LCD display color space */
#define BSP_LCD_COLOR_SPACE         (LCD_RGB_ELEMENT_ORDER_BGR)
/* LCD definition */
#define BSP_LCD_H_RES              (320)
#define BSP_LCD_V_RES              (240)

#ifdef __cplusplus
extern "C" {
#endif

/**************************************************************************************************
 *
 * I2S audio interface
 *
 * There are two devices connected to the I2S peripheral:
 *  - Codec AW88298 for output (playback) path
 *  - ADC ES7210 for input (recording) path
 *
 * After speaker or microphone initialization, use functions from
 * esp_codec_dev for play/record audio.
 **************************************************************************************************/

/**
 * @brief Initialize speaker codec device
 *
 * @return Pointer to codec device handle or NULL when error occured
 */
esp_codec_dev_handle_t bsp_audio_codec_speaker_init(void);

/**
 * @brief Initialize microphone codec device
 *
 * @return Pointer to codec device handle or NULL when error occured
 */
esp_codec_dev_handle_t bsp_audio_codec_microphone_init(void);

/**************************************************************************************************
 *
 * I2C interface
 *
 * There are multiple devices connected to I2C peripheral:
 *  - Codec AW88298 (configuration only)
 *  - ADC ES7210 (configuration only)
 *  - LCD Touch controller
 **************************************************************************************************/

/**
 * @brief Init I2C driver
 *
 * @return
 *      - ESP_OK                On success
 *      - ESP_ERR_INVALID_ARG   I2C parameter error
 *      - ESP_FAIL              I2C driver installation error
 *
 */
esp_err_t bsp_i2c_init(void);

/**
 * Enables and verifies CoreS3's externally switched M-BUS power rail.
 *
 * The BSP owns the AW9523 output-register shadow, so module drivers must use
 * this operation rather than independently touching BUS_OUT_EN or BOOST_EN.
 * The operation preserves every unrelated output and reads the latch and
 * direction registers back before returning success.
 *
 * @return ESP_OK when BUS_OUT_EN and BOOST_EN are latched as outputs and high.
 */
esp_err_t bsp_external_power_enable(void);

/**
 * Latched AXP2101 power-key events.
 *
 * CoreS3 has no ordinary GPIO button; its side power key terminates at the
 * PMIC.  Exposing the PMIC event bits here keeps applications on the audited
 * board component's I2C handle instead of making them reach through ESP-IDF
 * private bus APIs or install a second device handle behind its back.  These
 * values are flags because the PMIC can latch more than one event before
 * software samples the register.
 */
typedef enum {
    BSP_POWER_BUTTON_EVENT_NONE = 0,
    BSP_POWER_BUTTON_EVENT_LONG_PRESS = 1 << 0,
    BSP_POWER_BUTTON_EVENT_SHORT_PRESS = 1 << 1,
} bsp_power_button_event_t;

/**
 * Reads and acknowledges the power-key events latched by the AXP2101.
 *
 * This is a nonblocking state sample, not a gesture timer.  The PMIC remains
 * responsible for its configured long-hold power policy; consumers should
 * use the short-press bit for ordinary application actions.
 *
 * @param[out] events Latched event flags, or NONE when no event is pending.
 * @return ESP_OK on success, otherwise the underlying I2C transaction error.
 */
esp_err_t bsp_power_button_take_events(bsp_power_button_event_t *events);

/**************************************************************************************************
 *
 * Camera interface
 *
 * M5Stack-Core-S3 is shipped with GC0308 camera module.
 * As a camera driver, esp32-camera component is used.
 **************************************************************************************************/
/**
 * @brief Camera default configuration
 *
 * In this configuration we select RGB565 color format and 320x240 image size - matching the display.
 * We use double-buffering for the best performance.
 * Since we don't want to waste internal SRAM, we allocate the framebuffers in external PSRAM.
 * By setting XCLK to 16MHz, we configure the esp32-camera driver to use EDMA when accessing the PSRAM.
 *
 * @attention I2C must be enabled by bsp_i2c_init(), before camera is initialized
 */
#define BSP_CAMERA_DEFAULT_CONFIG         \
    {                                     \
        .pin_pwdn = GPIO_NUM_NC,          \
        .pin_reset = GPIO_NUM_NC,         \
        .pin_xclk = BSP_CAMERA_XCLK,      \
        .pin_sccb_sda = GPIO_NUM_NC,      \
        .pin_sccb_scl = GPIO_NUM_NC,      \
        .pin_d7 = BSP_CAMERA_D7,          \
        .pin_d6 = BSP_CAMERA_D6,          \
        .pin_d5 = BSP_CAMERA_D5,          \
        .pin_d4 = BSP_CAMERA_D4,          \
        .pin_d3 = BSP_CAMERA_D3,          \
        .pin_d2 = BSP_CAMERA_D2,          \
        .pin_d1 = BSP_CAMERA_D1,          \
        .pin_d0 = BSP_CAMERA_D0,          \
        .pin_vsync = BSP_CAMERA_VSYNC,    \
        .pin_href = BSP_CAMERA_HSYNC,     \
        .pin_pclk = BSP_CAMERA_PCLK,      \
        .xclk_freq_hz = 10000000,         \
        .ledc_timer = LEDC_TIMER_0,       \
        .ledc_channel = LEDC_CHANNEL_0,   \
        .pixel_format = PIXFORMAT_RGB565, \
        .frame_size = FRAMESIZE_QVGA,  \
        .jpeg_quality = 12,               \
        .fb_count = 2,                    \
        .fb_location = CAMERA_FB_IN_PSRAM,\
        .sccb_i2c_port = BSP_I2C_NUM,     \
    }

/**************************************************************************************************
 *
 * LCD interface
 *
 * M5Stack-Core-S3 is shipped with 2.0inch ILI9341C display controller.
 * It features 16-bit colors, 320x240 resolution and capacitive touch controller.
 *
 * Display's backlight must be enabled explicitly by calling bsp_display_backlight_on()
 **************************************************************************************************/

/**
 * @brief BSP display configuration structure
 *
 */
typedef struct {
    int max_transfer_sz;    /*!< Maximum transfer size, in bytes. */
} bsp_display_config_t;

/**
 * @brief Create new display panel
 *
 * For maximum flexibility, this function performs only reset and initialization of the display.
 * You must turn on the display explicitly by calling esp_lcd_panel_disp_on_off().
 * The display's backlight is not turned on either. You can use bsp_display_backlight_on/off(),
 * bsp_display_brightness_set() (on supported boards) or implement your own backlight control.
 *
 * If you want to free resources allocated by this function, you can use esp_lcd API, ie.:
 *
 * \code{.c}
 * esp_lcd_panel_del(panel);
 * esp_lcd_panel_io_del(io);
 * spi_bus_free(spi_num_from_configuration);
 * \endcode
 *
 * @param[in]  config    display configuration
 * @param[out] ret_panel esp_lcd panel handle
 * @param[out] ret_io    esp_lcd IO handle
 * @return
 *      - ESP_OK         On success
 *      - Else           esp_lcd failure
 */
esp_err_t bsp_display_new(const bsp_display_config_t *config, esp_lcd_panel_handle_t *ret_panel, esp_lcd_panel_io_handle_t *ret_io);

/**
 * @brief Initialize display's brightness
 *
 * Brightness is controlled with AXP2101 via I2C.
 *
 * @return
 *      - ESP_OK                On success
 *      - ESP_ERR_INVALID_ARG   Parameter error
 */
esp_err_t bsp_display_brightness_init(void);

/**
 * @brief Turn on display backlight
 *
 * Backlight must be already initialized by calling bsp_display_brightness_init()
 *
 * @return
 *      - ESP_OK                On success
 *      - ESP_ERR_INVALID_ARG   Parameter error
 */
esp_err_t bsp_display_backlight_on(void);

/**
 * @brief BSP touch configuration structure
 *
 */
typedef struct {
    void *dummy;    /*!< Prepared for future use. */
} bsp_touch_config_t;

/**
 * @brief Create new touchscreen
 *
 * If you want to free resources allocated by this function, you can use esp_lcd_touch API, ie.:
 *
 * \code{.c}
 * esp_lcd_touch_del(tp);
 * \endcode
 *
 * @param[in]  config    touch configuration
 * @param[out] ret_touch esp_lcd_touch touchscreen handle
 * @return
 *      - ESP_OK         On success
 *      - Else           esp_lcd_touch failure
 */
esp_err_t bsp_touch_new(const bsp_touch_config_t *config, esp_lcd_touch_handle_t *ret_touch);

#ifdef __cplusplus
}
#endif
