idf_component_register(
  SRCS "main.cpp"
  INCLUDE_DIRS "."
  REQUIRES
    capnweb
    core
    m5sticks3
    iterate_esp_idf
    iterate_m5unified
    esp_timer
    esp_wifi
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
