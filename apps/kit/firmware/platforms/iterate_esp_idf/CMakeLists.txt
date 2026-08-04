idf_component_register(
  SRCS
    "configuration.c"
    "itx_transport.c"
    "pcm_session.c"
    "pcm_transport.c"
    "websocket_connection.c"
  INCLUDE_DIRS "include"
  REQUIRES
    core
    esp_event
    esp_netif
    esp_partition
    esp-tls
    esp_timer
    esp_wifi
    http_parser
    lwip
    mbedtls
    nvs_flash
    tcp_transport
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  # ESP-IDF's public headers intentionally use GCC extensions such as
  # zero-length arrays and include_next.
  -Wno-pedantic
)
