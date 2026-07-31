cmake_minimum_required(VERSION 3.16)

# Keep platform overrides discoverable for IDF components that do not use the
# Component Manager. CoreS3 itself is selected explicitly by override_path in
# main/idf_component.yml; discovery order must never choose its audio contract.
list(APPEND EXTRA_COMPONENT_DIRS
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf/idf_overrides"
  "${CMAKE_CURRENT_LIST_DIR}/../../idf-components/capnweb"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/core"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/capabilities"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
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
