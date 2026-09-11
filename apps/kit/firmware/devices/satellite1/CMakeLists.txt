idf_component_register(
  SRCS satellite1_device.c
  PRIV_INCLUDE_DIRS .
  REQUIRES board audio capnweb capabilities core voice iterate_esp_idf
    esp_timer esp_driver_i2s esp_driver_i2c esp_driver_gpio esp_driver_spi)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
