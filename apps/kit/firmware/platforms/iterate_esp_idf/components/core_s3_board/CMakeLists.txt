idf_component_register(
  SRCS core_s3_board.c
  INCLUDE_DIRS include
  REQUIRES
    esp_driver_gpio
    esp_driver_i2c
    esp_driver_i2s
    esp_lcd
    espressif__esp_codec_dev
    espressif__esp_lcd_touch
  PRIV_REQUIRES
    esp_driver_spi
    esp_timer
    espressif__esp_lcd_ili9341
    espressif__esp_lcd_touch_ft5x06)
