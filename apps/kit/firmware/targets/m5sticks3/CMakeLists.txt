cmake_minimum_required(VERSION 3.16)

list(APPEND EXTRA_COMPONENT_DIRS
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf/idf_overrides"
  "${CMAKE_CURRENT_LIST_DIR}/../../idf-components/capnweb"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/core"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/capabilities"
  "${CMAKE_CURRENT_LIST_DIR}/../../devices/m5sticks3"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_m5unified"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(iterate-kit-m5sticks3)

# CONFIG_I2S_ISR_IRAM_SAFE is only a driver-side promise. Our callback,
# indirect backend thunk, atomics, timer read, and FreeRTOS wake must all stay
# callable while flash cache is disabled too. Make that a post-link property of
# every firmware build rather than a manual objdump observation which can
# silently expire after a compiler or configuration change.
add_custom_target(iterate-kit-m5sticks3-realtime-elf-audit ALL
  COMMAND "${CMAKE_COMMAND}"
    "-DOBJDUMP=${CMAKE_OBJDUMP}"
    "-DELF=$<TARGET_FILE:${CMAKE_PROJECT_NAME}.elf>"
    "-DCONFIG_FILE=${SDKCONFIG}"
    -P "${CMAKE_CURRENT_LIST_DIR}/../../cmake/audit_m5sticks3_realtime_elf.cmake"
  DEPENDS ${CMAKE_PROJECT_NAME}.elf
  COMMENT "Auditing M5StickS3 realtime ISR placement"
  VERBATIM
)
