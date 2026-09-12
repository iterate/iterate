cmake_minimum_required(VERSION 3.16)
set(SDKCONFIG_DEFAULTS "../common/sdkconfig.defaults;sdkconfig.defaults")
include(../common/components.cmake)
list(APPEND EXTRA_COMPONENT_DIRS
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/avatar"
  "${ITERATE_KIT_FIRMWARE_ROOT}/devices/m5sticks3")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(iterate-kit-m5sticks3)
