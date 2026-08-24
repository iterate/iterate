# The voice loop is one program, shared by every board. It depends on the
# portable components and on the ESP platform it runs on — never on a device.
# tests/verify_core_boundary.cmake enforces that direction, so a board symbol
# reaching in here fails the fast host build rather than a flash.
set(ITERATE_KIT_VOICE_SOURCES src/voice_loop.c)

if(COMMAND idf_component_register)
  idf_component_register(
    SRCS ${ITERATE_KIT_VOICE_SOURCES}
    INCLUDE_DIRS include
    REQUIRES
      audio
      capnweb
      capabilities
      core
      iterate_esp_idf
      esp_timer
      esp_netif
      esp_wifi
      mbedtls
      nvs_flash)

  target_compile_features(${COMPONENT_LIB} PUBLIC c_std_11)
  target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
else()
  # THE SAME SOURCE, ON A LAPTOP.
  #
  # Four boards depend on this file and it was in no host build at all, so its
  # intent mapping — whether a press becomes a call — was verified only by
  # diffing it against the four device files it replaced. That is exactly where
  # the bug lived that cost an afternoon.
  #
  # It compiles here because the ESP-IDF it names is supplied by
  # tests/fakes/esp_idf, and the platform modules it calls are supplied by the
  # fakes beside them. Nothing about the loop changes for the host: no #ifdef,
  # no second code path, and the same -Werror it is built with on a device.
  # The include ORDER matters — the fakes must precede nothing real, because
  # there is nothing real here to shadow.
  add_library(iterate-kit-voice STATIC ${ITERATE_KIT_VOICE_SOURCES})
  target_include_directories(iterate-kit-voice PUBLIC
    include
    "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/fakes/esp_idf"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../platforms/iterate_esp_idf/include")
  target_link_libraries(iterate-kit-voice PUBLIC
    iterate-kit-audio
    iterate-kit-capabilities
    iterate-kit-core)
  target_compile_features(iterate-kit-voice PUBLIC c_std_11)
  target_compile_options(iterate-kit-voice PRIVATE -Wall -Wextra -Werror)

  # The fakes are their own target so a test links them explicitly and nothing
  # can pull a pretend ESP-IDF into a build that did not ask for one.
  add_library(iterate-kit-esp-idf-fakes STATIC
    "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/fakes/esp_idf/fake_esp_idf.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/fakes/esp_idf/fake_esp_idf_platform.c")
  target_include_directories(iterate-kit-esp-idf-fakes PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/fakes/esp_idf"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../platforms/iterate_esp_idf/include")
  target_link_libraries(iterate-kit-esp-idf-fakes PUBLIC iterate-kit-core)
  target_compile_features(iterate-kit-esp-idf-fakes PUBLIC c_std_11)
  target_compile_options(iterate-kit-esp-idf-fakes PRIVATE -Wall -Wextra -Werror)
endif()
