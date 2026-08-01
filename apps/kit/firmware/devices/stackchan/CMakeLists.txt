idf_component_register(
  SRCS "stackchan.c"
  INCLUDE_DIRS "include"
  REQUIRES capabilities core
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
