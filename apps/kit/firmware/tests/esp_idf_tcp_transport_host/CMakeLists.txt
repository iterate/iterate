cmake_minimum_required(VERSION 3.16)

#
# This is intentionally an ESP-IDF Linux test project rather than another fake
# of our portable classifier. It reuses Espressif's real tcp_transport host
# suite and CMock parent transport, then adds the two failure sequences that
# force our guarded component override. The production and test builds select
# the same override directory, so a green result exercises the generated
# transport_ws.c rather than a friendlier reimplementation.
#
set(COMPONENTS esp_timer lwip tcp_transport main)

list(APPEND EXTRA_COMPONENT_DIRS
  "$ENV{IDF_PATH}/tools/mocks/lwip/"
  "$ENV{IDF_PATH}/tools/mocks/freertos/"
  "$ENV{IDF_PATH}/tools/mocks/esp_timer/"
  "$ENV{IDF_PATH}/tools/mocks/esp-tls/"
  "$ENV{IDF_PATH}/components/tcp_transport/host_test/components"
)

# The default must exercise exactly what ships. This opt-out exists solely to
# make the regressions falsifiable: a separate stock-IDF build should fail the
# incident cases while continuing to run the same Espressif runner and mocks.
# Keeping that control experiment one CMake flag away guards against a test
# that accidentally proves only its own fixture.
option(
  ITERATE_KIT_TEST_STOCK_TCP_TRANSPORT
  "Deliberately omit Iterate's tcp_transport override for a red control run"
  OFF
)
if(NOT ITERATE_KIT_TEST_STOCK_TCP_TRANSPORT)
  list(APPEND EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf/idf_overrides"
  )
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(iterate_kit_tcp_transport_host_test)
