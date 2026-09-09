if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/assets/satellite1_sounds_generated.inc")
  message(FATAL_ERROR
    "assets/satellite1_sounds_generated.inc is generated, not committed - run "
    "apps/kit/firmware/tools/generate-sounds.sh (needs OPENAI_API_KEY)")
endif()

idf_component_register(
  SRCS satellite1_device.c
  INCLUDE_DIRS include
  PRIV_INCLUDE_DIRS .
  REQUIRES board audio capnweb capabilities core voice iterate_esp_idf
    esp_timer esp_driver_i2s esp_driver_i2c esp_driver_gpio esp_driver_spi)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
