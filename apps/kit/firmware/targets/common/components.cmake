set(ITERATE_KIT_FIRMWARE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../..")
list(APPEND EXTRA_COMPONENT_DIRS
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf/components/board"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf/idf_overrides/tcp_transport"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/audio"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/capabilities"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/voice"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf")
