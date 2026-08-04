idf_component_register(
  SRCS "stackchan_body.c"
  INCLUDE_DIRS "include"
  REQUIRES
    driver
    espressif__m5stack_core_s3
    iterate_stackchan_hardware
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
