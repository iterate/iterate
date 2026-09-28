idf_component_register(
  SRCS
    stackchan_device.c
    stackchan_audio.c
    stackchan_processor.c
    stackchan_avatar.c
    stackchan_body.c
    stackchan_camera.c
    core_s3_capture_reserve.c
  PRIV_INCLUDE_DIRS .
  REQUIRES
    board
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
    lcd_transfer
    espressif__esp-sr
    core_s3_board
    espressif__esp32-camera)

include(${CMAKE_CURRENT_LIST_DIR}/../../tools/baked-sounds.cmake)
iterate_kit_add_baked_sounds(TRIM_WAKE)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
