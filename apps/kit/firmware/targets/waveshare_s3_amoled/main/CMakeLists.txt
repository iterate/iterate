idf_component_register(
  SRCS "main.c" "waveshare_audio.c" "waveshare_buttons.c" "waveshare_display.c" "waveshare_recorder.c" "waveshare_tools.c"
  REQUIRES capnweb core iterate_esp_idf esp_timer esp_wifi esp_driver_i2s esp_driver_i2c esp_driver_gpio esp_lcd_touch
)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
)
