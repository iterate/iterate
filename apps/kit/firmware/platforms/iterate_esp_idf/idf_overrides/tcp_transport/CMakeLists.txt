#
# ESP-IDF explicitly supports project components overriding components of the
# same name. We use that seam because tcp_transport's WebSocket reader treats a
# normal nonblocking payload stall as end-of-frame and destroys its own offset.
# Tuning our reconnect policy around that behavior would merely make ordinary
# Wi-Fi loss look less noisy while still discarding live conversations.
#
# Do not fork the whole component here. Three unmodified sources and all public
# headers continue to come from the selected IDF checkout; patch_transport.cmake
# performs exact-once guarded rewrites into the build directory. An IDF upgrade
# whose source no longer matches therefore fails at configure time and demands
# a conscious re-audit instead of silently dropping the fix.
#
idf_component_get_property(
  original_tcp_transport_dir
  tcp_transport
  COMPONENT_OVERRIDEN_DIR
)

if(NOT original_tcp_transport_dir)
  message(FATAL_ERROR
    "Iterate tcp_transport override could not locate the ESP-IDF component")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/patch_transport.cmake")

set(iterate_generated_dir
  "${CMAKE_CURRENT_BINARY_DIR}/iterate_patched")
file(MAKE_DIRECTORY "${iterate_generated_dir}")

iterate_kit_patch_transport_ws(
  "${original_tcp_transport_dir}/transport_ws.c"
  "${iterate_generated_dir}/transport_ws.c"
)
iterate_kit_patch_transport_ssl(
  "${original_tcp_transport_dir}/transport_ssl.c"
  "${iterate_generated_dir}/transport_ssl.c"
)

set(srcs
  "${original_tcp_transport_dir}/transport.c"
  "${iterate_generated_dir}/transport_ssl.c"
  "${original_tcp_transport_dir}/transport_internal.c"
)

if(CONFIG_LWIP_IPV4)
  list(APPEND srcs
    "${original_tcp_transport_dir}/transport_socks_proxy.c")
endif()

if(CONFIG_WS_TRANSPORT)
  list(APPEND srcs
    "${iterate_generated_dir}/transport_ws.c")
endif()

set(req esp-tls)
if(NOT ${IDF_TARGET} STREQUAL "linux")
  list(APPEND req lwip esp_timer)
endif()

idf_component_register(
  SRCS "${srcs}"
  INCLUDE_DIRS "${original_tcp_transport_dir}/include"
  PRIV_INCLUDE_DIRS "${original_tcp_transport_dir}/private_include"
  REQUIRES ${req}
  KCONFIG "${original_tcp_transport_dir}/Kconfig"
)

if(${IDF_TARGET} STREQUAL "linux")
  idf_build_get_property(build_components BUILD_COMPONENTS)
  if("lwip" IN_LIST build_components)
    idf_component_get_property(esp_timer esp_timer COMPONENT_LIB)
    target_link_libraries(${COMPONENT_LIB} PUBLIC ${esp_timer})
  endif()
endif()
