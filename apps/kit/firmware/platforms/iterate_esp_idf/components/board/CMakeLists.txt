idf_component_register(
  SRCS i2s_codec.c led_ring.c
  INCLUDE_DIRS include
  REQUIRES voice audio core capabilities esp_driver_i2s esp_driver_i2c esp_driver_gpio esp_timer espressif__led_strip)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
