cmake_minimum_required(VERSION 3.20)

project(capnweb_c VERSION 0.1.0 LANGUAGES C)

option(CAPNWEB_SANITIZE "Enable address and undefined-behavior sanitizers" OFF)
option(CAPNWEB_BUILD_TOOLS "Build host-side profiling tools" ON)
option(CAPNWEB_BUILD_FUZZER "Build the libFuzzer session harness" OFF)

include(CTest)

set(CAPNWEB_SOURCES
  src/call.c
  src/expression.c
  src/json.c
  src/reply.c
  src/responder.c
  src/session.c
  src/value.c
  src/writer.c
)

add_library(capnweb STATIC ${CAPNWEB_SOURCES})
target_include_directories(capnweb PUBLIC include)
target_compile_features(capnweb PUBLIC c_std_99)
target_compile_options(capnweb PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)

if(CAPNWEB_SANITIZE AND CMAKE_C_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
  target_compile_options(capnweb PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(capnweb PUBLIC -fsanitize=address,undefined)
endif()

add_executable(capnweb-native-peer
  tests/native_peer.c
)
target_link_libraries(capnweb-native-peer PRIVATE capnweb)

if(BUILD_TESTING)
  add_executable(capnweb-session-test
    tests/session_test.c
  )
  target_link_libraries(capnweb-session-test PRIVATE capnweb)
  add_test(NAME capnweb-session-test COMMAND capnweb-session-test)
endif()

if(CAPNWEB_BUILD_TOOLS)
  add_executable(capnweb-resource-profile
    tools/resource_profile.c
  )
  target_link_libraries(capnweb-resource-profile PRIVATE capnweb)
endif()

if(CAPNWEB_BUILD_FUZZER)
  if(NOT CMAKE_C_COMPILER_ID STREQUAL "Clang")
    message(FATAL_ERROR
      "CAPNWEB_BUILD_FUZZER requires upstream Clang with libFuzzer")
  endif()
  add_executable(capnweb-session-fuzzer
    tests/fuzz_session.c
    ${CAPNWEB_SOURCES}
  )
  target_include_directories(capnweb-session-fuzzer PRIVATE include)
  target_compile_features(capnweb-session-fuzzer PRIVATE c_std_99)
  target_compile_options(capnweb-session-fuzzer PRIVATE
    -Wall
    -Wextra
    -Werror
    -Wpedantic
    -fsanitize=fuzzer,address,undefined
    -fno-omit-frame-pointer
  )
  target_link_options(capnweb-session-fuzzer PRIVATE
    -fsanitize=fuzzer,address,undefined
  )
endif()
