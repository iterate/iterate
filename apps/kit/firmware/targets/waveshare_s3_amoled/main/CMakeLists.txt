idf_component_register(
  SRCS "main.c"
  REQUIRES capnweb core iterate_esp_idf esp_timer esp_wifi
)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
)
