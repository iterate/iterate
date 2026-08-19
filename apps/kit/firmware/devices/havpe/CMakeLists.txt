if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/assets/havpe_sounds_generated.inc")
  message(FATAL_ERROR
    "assets/havpe_sounds_generated.inc is generated, not committed - run "
    "apps/kit/firmware/tools/generate-sounds.sh (needs OPENAI_API_KEY)")
endif()

idf_component_register(
  SRCS
    havpe_device.c
    havpe_audio.c
    havpe_modes.c
    havpe_ui.c
    voice_pe_hardware_config.c
    voice_pe_pcm_format.c
  INCLUDE_DIRS include
  PRIV_INCLUDE_DIRS .
  REQUIRES
    audio
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
    mbedtls
    nvs_flash
    espressif__led_strip)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
