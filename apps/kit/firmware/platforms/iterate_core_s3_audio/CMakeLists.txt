idf_component_register(
  SRCS
    "core_s3_audio_owner.c"
    "core_s3_capture_reserve.c"
  INCLUDE_DIRS "include"
  REQUIRES
    core
    esp_driver_i2s
    esp_timer
    espressif__esp-sr
    espressif__esp_codec_dev
    espressif__m5stack_core_s3
    freertos
    heap
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  # ESP-IDF public headers deliberately contain GCC extensions.
  -Wno-pedantic
)
