# The voice loop is one program, shared by every board. It depends on the
# portable components and on the ESP platform it runs on — never on a device.
# tests/verify_core_boundary.cmake enforces that direction, so a board symbol
# reaching in here fails the fast host build rather than a flash.
set(ITERATE_KIT_VOICE_SOURCES src/voice_loop.c)

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
