idf_component_register(
  SRCS
    m5sticks3_device.c
    m5sticks3_audio.cpp
    m5sticks3_board.cpp
  PRIV_INCLUDE_DIRS .
  REQUIRES
    board
    audio
    avatar
    capnweb
    capabilities
    core
    voice
    iterate_esp_idf
    esp_timer
    esp_wifi
    esp_netif
    esp_driver_i2s
    esp_driver_gpio
    mbedtls
    nvs_flash
    m5stack__m5unified)

include(${CMAKE_CURRENT_LIST_DIR}/../../tools/baked-sounds.cmake)
iterate_kit_add_baked_sounds(GAIN 5/2)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
