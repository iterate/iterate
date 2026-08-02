idf_component_register(
  SRCS
    "havpe_ui.c"
    "main.c"
  INCLUDE_DIRS "."
  REQUIRES
    capabilities
    core
    esp_driver_gpio
    esp_timer
    esp_wifi
    espressif__led_strip
    freertos
    heap
    iterate_esp_idf
    iterate_voice_pe_audio
    voice_satellite
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  # ESP-IDF public headers intentionally expose GCC extensions.
  -Wno-pedantic
)
