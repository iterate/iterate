idf_component_register(
  SRCS board.c i2s_codec.c led_ring.c codecs/aic3204.c xmos_i2c.c
    codecs/tas2780.c codecs/tas2780_registers.c
    codecs/pcm5122.c codecs/pcm5122_registers.c
    codecs/xmos_spi.c codecs/xmos_spi_registers.c
  INCLUDE_DIRS include
  REQUIRES voice audio core capabilities esp_driver_i2s esp_driver_i2c esp_driver_gpio esp_driver_spi esp_timer espressif__led_strip)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
