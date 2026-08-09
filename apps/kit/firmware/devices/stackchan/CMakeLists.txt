idf_component_register(
  SRCS
    stackchan_device.c
    stackchan_audio.c
    stackchan_processor.c
    stackchan_avatar.c
    stackchan_body.c
    stackchan_camera.c
    core_s3_capture_reserve.c
  INCLUDE_DIRS include
  PRIV_INCLUDE_DIRS .
  REQUIRES
    audio
    avatar
    capnweb
    capabilities
    core
    voice
    iterate_esp_idf
    esp_timer
    esp_wifi
    esp_netif
    esp_driver_i2s
    esp_driver_i2c
    esp_driver_gpio
    esp_driver_uart
    esp_lcd
    mbedtls
    nvs_flash
    espressif__esp-sr
    espressif__m5stack_core_s3
    espressif__esp32-camera)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
