idf_component_register(
  SRCS
    "voice_pe_audio_owner.c"
    "voice_pe_hardware_config.c"
    "voice_pe_pcm_format.c"
  INCLUDE_DIRS "include"
  REQUIRES
    core
    esp_driver_gpio
    esp_driver_i2c
    esp_driver_i2s
    esp_timer
    freertos
    heap
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  # ESP-IDF public headers intentionally expose GCC extensions.
  -Wno-pedantic
)
