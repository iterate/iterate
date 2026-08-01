idf_component_register(
  SRCS "main.c"
  INCLUDE_DIRS "."
  REQUIRES
    core
    espressif__m5stack_core_s3
    esp_timer
    iterate_core_s3_audio
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
