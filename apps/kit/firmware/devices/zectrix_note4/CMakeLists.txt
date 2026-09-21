idf_component_register(SRCS note4_device.c note4_display.c zectrix_epd.cc
  PRIV_INCLUDE_DIRS .
  REQUIRES board voice capabilities core audio driver esp_timer esp_driver_gpio
    esp_driver_i2c espressif__esp_codec_dev)
include(${CMAKE_CURRENT_LIST_DIR}/../../tools/baked-sounds.cmake)
iterate_kit_add_baked_sounds(TRIM_WAKE)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
target_compile_features(${COMPONENT_LIB} PRIVATE cxx_std_17)
