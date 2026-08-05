cmake_minimum_required(VERSION 3.16)

set(ITERATE_KIT_FIRMWARE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../..")
list(APPEND EXTRA_COMPONENT_DIRS
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf/idf_overrides/tcp_transport"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/audio"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/capabilities"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/avatar"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf"
  "${ITERATE_KIT_FIRMWARE_ROOT}/devices/m5sticks3")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(iterate-kit-m5sticks3)
