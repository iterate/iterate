idf_component_register(
  SRCS
    "m5sticks3_direct_audio.cpp"
    "m5unified.cpp"
  INCLUDE_DIRS
    "include"
    "../common/include"
  REQUIRES
    m5stack__m5unified
    capabilities
    core
    esp_driver_i2s
    esp_timer
    esp_system
    heap
    iterate_esp_idf
)
target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
