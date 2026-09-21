idf_component_register(SRCS rlcd_device.c rlcd_display.c PRIV_INCLUDE_DIRS .
  REQUIRES board voice capabilities core audio esp_driver_spi esp_driver_gpio
    esp_driver_i2c espressif__esp_codec_dev)
include(${CMAKE_CURRENT_LIST_DIR}/../../tools/baked-sounds.cmake)
iterate_kit_add_baked_sounds(TRIM_WAKE)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
