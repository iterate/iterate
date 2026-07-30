idf_component_register(
  SRCS
    "$ENV{IDF_PATH}/components/tcp_transport/host_test/main/test_socks_transport.cpp"
    "$ENV{IDF_PATH}/components/tcp_transport/host_test/main/test_websocket_transport.cpp"
    "../../../components/core/src/websocket_rx.c"
    "test_iterate_websocket_transport.cpp"
  REQUIRES tcp_transport mocked_transport
  INCLUDE_DIRS
    "$ENV{IDF_PATH}/tools"
    "../../../components/core/include"
  WHOLE_ARCHIVE
)

#
# These links mirror Espressif's own host test runner. Keeping its original
# sources in this executable is deliberate: our narrow override must continue
# to satisfy the upstream suite as well as our loss/reconnect regressions.
#
idf_component_get_property(lwip_component lwip COMPONENT_LIB)
idf_component_get_property(esp_timer_component esp_timer COMPONENT_LIB)
idf_component_get_property(
  tcp_transport_component tcp_transport COMPONENT_LIB)
target_link_libraries(
  ${tcp_transport_component} PUBLIC
  ${lwip_component}
  ${esp_timer_component}
)

# Espressif runs this host suite on Linux. On Darwin, <errno.h> defines
# `errno` as a function-like macro before lwIP expands its
# `LWIP_ERRNO_INCLUDE <errno.h>` macro. The expansion becomes an impossible
# header such as `<(*__error()).h>`, so the unchanged upstream suite cannot
# even compile on the Mac beside the physical devices. lwIP already has a
# second, semantically identical path that spells `#include <errno.h>`
# directly. Select that path only for the host compiler; this is test-runner
# portability and deliberately does not alter either production firmware or
# the WebSocket behavior under test.
if(APPLE)
  target_compile_definitions(
    ${tcp_transport_component}
    PRIVATE LWIP_ERRNO_STDINCLUDE=1
  )
  target_compile_definitions(
    ${COMPONENT_LIB}
    PRIVATE LWIP_ERRNO_STDINCLUDE=1
  )
endif()

# Upstream adds GCC's `-fconcepts`. Apple Clang already enables the language
# feature through ESP-IDF's selected C++ standard and rejects that GCC-only
# switch. Keep AddressSanitizer on both hosts, while retaining the upstream
# option wherever the compiler actually accepts it.
target_compile_options(${COMPONENT_LIB} PUBLIC -fsanitize=address)
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  target_compile_options(${COMPONENT_LIB} PUBLIC -fconcepts)
endif()
target_link_options(${COMPONENT_LIB} PUBLIC -fsanitize=address)
target_link_libraries(${COMPONENT_LIB} PRIVATE Catch2WithMain)
