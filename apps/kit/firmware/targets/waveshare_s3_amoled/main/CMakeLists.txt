idf_component_register(
  SRCS "main.c" "waveshare_audio.c"
  REQUIRES capnweb core iterate_esp_idf esp_timer esp_wifi esp_driver_i2s esp_driver_i2c
)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
)
