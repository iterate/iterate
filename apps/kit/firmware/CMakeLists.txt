cmake_minimum_required(VERSION 3.20)

project(iterate_kit_firmware LANGUAGES C)

enable_testing()

option(
  ITERATE_KIT_SANITIZE
  "Enable address and undefined-behavior sanitizers for host verification"
  OFF)

if(ITERATE_KIT_SANITIZE AND CMAKE_C_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

# The bounded C Cap'n Web peer is maintained in its first-party repository.
# Pinning a commit keeps firmware builds reproducible without copying the
# upstream implementation into this monorepo.
include(FetchContent)
set(CAPNWEB_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(CAPNWEB_BUILD_FUZZER OFF CACHE BOOL "" FORCE)
set(CAPNWEB_SANITIZE ${ITERATE_KIT_SANITIZE} CACHE BOOL "" FORCE)
FetchContent_Declare(
  capnweb_c
  GIT_REPOSITORY https://github.com/iterate/capnweb.git
  GIT_TAG aee32b391063c4f5baf0aec852f38851eeeed1d9
  GIT_SHALLOW FALSE
  SOURCE_SUBDIR c)
FetchContent_MakeAvailable(capnweb_c)

add_subdirectory(components/core)
add_subdirectory(components/audio)
add_subdirectory(components/capabilities)
add_subdirectory(components/avatar)
# The host ESP-IDF, then the shared voice loop built against it. Every ESP
# board under targets/ runs that loop; on a laptop the tests drive it with a
# pinned clock and targets/mac runs it as a device.
add_subdirectory(platforms/host)
add_subdirectory(components/voice)

if(APPLE)
  add_subdirectory(platforms/darwin)
  add_subdirectory(targets/mac)
endif()

add_subdirectory(tests)
