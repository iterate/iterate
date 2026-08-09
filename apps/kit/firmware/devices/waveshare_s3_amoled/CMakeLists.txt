# The voice loop is one program shared by every board. It is compiled here,
# from the shared tree, while the board is still bound to it at compile time;
# the binding becomes a vtable in the next step.
idf_component_register(
  SRCS
    ${CMAKE_CURRENT_LIST_DIR}/../../components/voice/src/voice_loop.c
    waveshare_audio.c
    waveshare_avatar.c
    waveshare_buttons.c
    waveshare_display.c
  INCLUDE_DIRS include
  PRIV_INCLUDE_DIRS .
  REQUIRES
    audio
    avatar
    capnweb
    capabilities
    core
    iterate_esp_idf
    esp_timer
    esp_wifi
    esp_netif
    esp_driver_i2s
    esp_driver_i2c
    esp_driver_gpio
    espressif__esp_codec_dev
    mbedtls
    nvs_flash
    waveshare__esp32_s3_touch_amoled_1_8)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
