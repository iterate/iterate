cmake_minimum_required(VERSION 3.16)

# HAVPE is an ESP32-S3 host around two XMOS-clocked I2S buses. Keep the
# reusable protocol/profile/audio components explicit: this target is only the
# board composition, and cannot silently acquire another board's BSP or DSP.
list(APPEND EXTRA_COMPONENT_DIRS
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf/idf_overrides/tcp_transport"
  "${CMAKE_CURRENT_LIST_DIR}/../../idf-components/capnweb"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/core"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/capabilities"
  "${CMAKE_CURRENT_LIST_DIR}/../../devices/voice_satellite"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_voice_pe_audio"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(iterate-kit-home-assistant-voice-preview-edition)

