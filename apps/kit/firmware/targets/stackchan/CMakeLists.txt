cmake_minimum_required(VERSION 3.16)

# Keep platform overrides discoverable for IDF components that do not use the
# Component Manager. CoreS3 itself is selected explicitly by override_path in
# main/idf_component.yml; discovery order must never choose its audio contract.
list(APPEND EXTRA_COMPONENT_DIRS
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf/idf_overrides"
  "${CMAKE_CURRENT_LIST_DIR}/../../idf-components/capnweb"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/core"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/capabilities"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/avatar"
  "${CMAKE_CURRENT_LIST_DIR}/../../devices/stackchan"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_core_s3_audio"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_stackchan_avatar"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_stackchan_body"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_stackchan_hardware"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# StackChan's avatar owns the LCD directly. Compile the audited CoreS3 BSP
# without its optional LVGL task/surface. The avatar adapter owns the raw panel
# and FT5x06 directly, so whole-screen call taps cost no generic UI task or
# framebuffer. The explicit switch prevents a transitive dependency from
# silently restoring LVGL's SRAM cost while keeping the direct BSP APIs.
idf_build_set_property(
  COMPILE_DEFINITIONS "BSP_CONFIG_NO_GRAPHIC_LIB=1" APPEND)
project(iterate-kit-stackchan)

# project_description.json is the public, machine-readable account of which
# component and translation units ESP-IDF actually selected. Checking source
# files in the tree is insufficient: the original regression had a correct
# local wrapper which the clean build silently superseded with managed source.
# Keep this target in ALL so an ordinary `idf.py build` cannot be reported
# green without also proving the resolved component and patched source list.
add_custom_target(verify-bsp-source-selection ALL
  COMMAND
    "${PYTHON}"
    "${CMAKE_CURRENT_LIST_DIR}/tests/verify_bsp_source_selection.py"
    "${CMAKE_BINARY_DIR}/project_description.json"
    "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf/idf_overrides/espressif__m5stack_core_s3"
  DEPENDS "${PROJECT_NAME}.elf"
  VERBATIM
)

# I2S_ISR_IRAM_SAFE covers ESP-IDF's driver but cannot prove the application
# callback, BSP seam, atomics, copy routine, or static context placement. Make
# the linked-ELF proof part of every ordinary build so it cannot go stale after
# a compiler, SDK, or innocent-looking diagnostics change.
add_custom_target(iterate-kit-core-s3-realtime-elf-audit ALL
  COMMAND "${CMAKE_COMMAND}"
    "-DOBJDUMP=${CMAKE_OBJDUMP}"
    "-DELF=$<TARGET_FILE:${CMAKE_PROJECT_NAME}.elf>"
    "-DCONFIG_FILE=${SDKCONFIG}"
    -P "${CMAKE_CURRENT_LIST_DIR}/../../cmake/audit_core_s3_realtime_elf.cmake"
  DEPENDS ${CMAKE_PROJECT_NAME}.elf
  COMMENT "Auditing CoreS3 realtime ISR placement"
  VERBATIM
)
