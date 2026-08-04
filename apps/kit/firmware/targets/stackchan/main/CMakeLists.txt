idf_component_register(
  SRCS "main.c"
  INCLUDE_DIRS "."
  REQUIRES
    avatar
    capabilities
    core
    espressif__m5stack_core_s3
    esp_timer
    esp_wifi
    freertos
    heap
    iterate_core_s3_audio
    iterate_esp_idf
    iterate_stackchan_avatar
    iterate_stackchan_body
    iterate_stackchan_hardware
    stackchan
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
