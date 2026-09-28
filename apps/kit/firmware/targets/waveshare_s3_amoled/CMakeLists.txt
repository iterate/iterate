cmake_minimum_required(VERSION 3.16)
include(../common/components.cmake)
list(APPEND EXTRA_COMPONENT_DIRS
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/avatar"
  "${ITERATE_KIT_FIRMWARE_ROOT}/devices/waveshare_s3_amoled")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(iterate-kit-waveshare-s3-amoled)
