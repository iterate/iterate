cmake_minimum_required(VERSION 3.16)
set(SDKCONFIG_DEFAULTS "../common/sdkconfig.defaults;sdkconfig.defaults")
include(../common/components.cmake)
list(APPEND EXTRA_COMPONENT_DIRS
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/avatar"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf/components/core_s3_board"
  "${ITERATE_KIT_FIRMWARE_ROOT}/devices/stackchan")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(iterate-kit-stackchan)
