cmake_minimum_required(VERSION 3.16)

# Keep the CoreS3 divergence in the ordinary ESP-IDF component override seam.
# The target selects the audited managed BSP version in main/idf_component.yml;
# the override then fails configuration if that source no longer matches.
list(APPEND EXTRA_COMPONENT_DIRS
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf/idf_overrides"
  "${CMAKE_CURRENT_LIST_DIR}/../../idf-components/capnweb"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/core"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/capabilities"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(iterate-kit-stackchan)
