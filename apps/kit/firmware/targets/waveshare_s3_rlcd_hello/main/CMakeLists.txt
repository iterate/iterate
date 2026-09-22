idf_component_register(SRCS main.c ../../../devices/waveshare_s3_rlcd/rlcd_display.c INCLUDE_DIRS ../../../devices/waveshare_s3_rlcd REQUIRES esp_driver_spi esp_driver_gpio esp_timer)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
