idf_component_register(
  SRCS "main.c" "waveshare_audio.c" "waveshare_avatar.c" "waveshare_buttons.c" "waveshare_conversation_store.c" "waveshare_display.c" "waveshare_image.c" "waveshare_recorder.c" "waveshare_tools.c" "waveshare_touch.c"
  REQUIRES avatar capnweb core iterate_esp_idf esp_timer esp_wifi esp_netif esp_driver_i2s esp_driver_i2c esp_driver_gpio esp_lcd_touch esp_http_client mbedtls nvs_flash
)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
)
# waveshare_image.c handles remote, attacker-controlled bytes and does its own
# byte-width arithmetic, so it is held to the stricter set. -Wpedantic is not
# among them for the same reason platforms/iterate_esp_idf gives: ESP-IDF's
# public headers use GCC extensions on purpose.
set_source_files_properties(
  waveshare_image.c PROPERTIES COMPILE_OPTIONS "-Wconversion;-Wshadow"
)
