idf_component_register(
  SRCS lcd_transfer.c
  INCLUDE_DIRS include
  REQUIRES esp_lcd freertos)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
