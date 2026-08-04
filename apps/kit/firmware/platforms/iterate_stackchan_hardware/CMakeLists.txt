if(COMMAND idf_component_register)
  # This branch makes the directory usable as an ESP-IDF component without
  # forcing the current device target to consume it before target glue exists.
  idf_component_register(
    SRCS "stackchan_hardware.c"
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
else()
  cmake_minimum_required(VERSION 3.20)
  project(iterate_stackchan_hardware_tests LANGUAGES C)

  enable_testing()
  add_executable(iterate-stackchan-hardware-test
    "stackchan_hardware.c"
    "../../components/core/src/conversation_lights.c"
    "tests/stackchan_hardware_test.c"
  )
  target_compile_features(iterate-stackchan-hardware-test PRIVATE c_std_99)
  set_target_properties(iterate-stackchan-hardware-test PROPERTIES
    C_EXTENSIONS OFF
  )
  target_compile_options(iterate-stackchan-hardware-test PRIVATE
    -Wall
    -Wextra
    -Werror
    -Wpedantic
  )
  target_include_directories(iterate-stackchan-hardware-test PRIVATE
    "include"
    "../../components/capabilities/include"
    "../../components/core/include"
    "../../vendor/capnweb/include"
  )
  add_test(
    NAME iterate-stackchan-hardware-test
    COMMAND iterate-stackchan-hardware-test
  )
endif()
