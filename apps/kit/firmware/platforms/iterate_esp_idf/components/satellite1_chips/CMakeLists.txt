idf_component_register(
  SRCS tas2780_registers.c tas2780.c pcm5122_registers.c pcm5122.c
       xmos_spi_registers.c xmos_spi.c
  INCLUDE_DIRS include
  REQUIRES core capabilities esp_driver_i2c esp_driver_spi esp_timer esp_driver_gpio)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
