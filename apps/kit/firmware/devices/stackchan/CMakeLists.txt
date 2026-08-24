if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/assets/stackchan_sounds_generated.inc")
  message(FATAL_ERROR
    "assets/stackchan_sounds_generated.inc is generated, not committed - run "
    "apps/kit/firmware/tools/generate-sounds.sh (needs OPENAI_API_KEY)")
endif()

idf_component_register(
  SRCS
    stackchan_device.c
    stackchan_audio.c
    stackchan_processor.c
    stackchan_avatar.c
    stackchan_body.c
    stackchan_camera.c
    stackchan_image.c
    stackchan_modes.c
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
    esp_http_client
    mbedtls
    nvs_flash
    espressif__esp-sr
    core_s3_board
    espressif__esp32-camera
    espressif__esp_jpeg)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
