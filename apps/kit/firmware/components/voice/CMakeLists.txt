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
      tinyvoice
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
  # Every board depends on this file, so its intent mapping — whether a press
  # becomes a call — is tested on a laptop rather than on a flash.
  #
  # It compiles here because the ESP-IDF it names is the host one
  # (platforms/host/esp_idf), and the five platform interfaces it calls —
  # provisioning, reset reason, restart note, system update, the itx
  # transport — come from whichever platform a target links: tests/fakes for
  # a test, platforms/darwin for targets/mac. Nothing about the loop changes
  # for the host: no #ifdef, no second code path, the same -Werror as a device.
  #
  # This library is compiled against the ESP platform's copies of the five
  # headers, which is fine: a platform header declares the same names and the
  # same struct shape a caller may touch; only the definitions differ.
  #
  # Compiled once per platform it can link, because a platform header defines
  # the transport struct the loop keeps: against the ESP platform's headers for
  # the tests (their fake transport is the ESP-shaped one), and against the
  # darwin platform's for targets/mac.
  function(iterate_kit_add_voice_loop NAME PLATFORM_INCLUDE)
    add_library(${NAME} STATIC ${ITERATE_KIT_VOICE_SOURCES})
    target_include_directories(${NAME} PUBLIC include "${PLATFORM_INCLUDE}")
    target_link_libraries(${NAME} PUBLIC
      iterate-kit-audio
      iterate-kit-capabilities
      iterate-kit-core
      iterate-kit-host-esp-idf
      iterate-kit-tinyvoice)
    target_compile_features(${NAME} PUBLIC c_std_11)
    target_compile_options(${NAME} PRIVATE -Wall -Wextra -Werror)
  endfunction()
  iterate_kit_add_voice_loop(iterate-kit-voice
    "${CMAKE_CURRENT_SOURCE_DIR}/../../platforms/iterate_esp_idf/include")
  if(APPLE)
    iterate_kit_add_voice_loop(iterate-kit-voice-mac
      "${CMAKE_CURRENT_SOURCE_DIR}/../../platforms/darwin/include")
    # The darwin transport header reaches OpenSSL's; the platform carries it.
    target_link_libraries(iterate-kit-voice-mac PUBLIC iterate-kit-darwin)
  endif()
endif()
