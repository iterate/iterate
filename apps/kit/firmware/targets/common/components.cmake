# CI passes -D PROJECT_VER=<release version> (apps/kit/scripts/firmware-release.ts); hand builds say "dev"
# instead of ESP-IDF's `git describe` fallback, which now sees kit-firmware/* tags.
# https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/system/misc_system_api.html#app-version
if(NOT DEFINED PROJECT_VER)
  set(PROJECT_VER "dev")
endif()
set(ITERATE_KIT_FIRMWARE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../..")
list(APPEND EXTRA_COMPONENT_DIRS
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf/components/board"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf/components/lcd_transfer"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf/idf_overrides/tcp_transport"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/audio"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/capabilities"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/voice"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/iterate_esp_idf")
