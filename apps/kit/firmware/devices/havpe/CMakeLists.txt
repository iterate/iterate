idf_component_register(
  SRCS
    havpe_device.c
    havpe_dial.c
    havpe_ui.c
  PRIV_INCLUDE_DIRS .
  REQUIRES
    board
    audio
    capnweb
    capabilities
    core
    voice
    iterate_esp_idf
    esp_timer
    esp_wifi
    esp_netif
    esp_driver_i2s
    esp_driver_i2c
    esp_driver_gpio
    mbedtls
    espressif__led_strip)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
