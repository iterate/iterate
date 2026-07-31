cmake_minimum_required(VERSION 3.16)

# Waveshare ESP32-S3 Touch AMOLED voicelab probe target.
#
# DELIBERATE DEPARTURE from the standing dual-WebSocket decision
# (apps/kit/docs/fable-v2-plan/DECISIONS.md): this target exists to measure
# whether realtime PCM can ride the SINGLE Cap'n Web /api socket as ephemeral
# stream events (JSON + base64), the same protocol the TypeScript voicelab
# client speaks. It is an experiment harness, not the product transport.
list(APPEND EXTRA_COMPONENT_DIRS
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf/idf_overrides/tcp_transport"
  "${CMAKE_CURRENT_LIST_DIR}/../../idf-components/capnweb"
  "${CMAKE_CURRENT_LIST_DIR}/../../components/core"
  "${CMAKE_CURRENT_LIST_DIR}/../../platforms/iterate_esp_idf"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(iterate-kit-waveshare-s3-amoled)
