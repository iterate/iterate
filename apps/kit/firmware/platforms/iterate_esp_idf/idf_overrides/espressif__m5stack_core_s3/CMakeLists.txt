#
# CoreS3's published BSP exposes ordinary duplex I2S only, while the board's
# useful echo reference is ES7210 MIC3 on a four-slot TDM receive stream. The
# target selects this component through Component Manager's explicit
# override_path seam. The audited 3.0.2 inputs live beside this file so a
# clean/offline build never depends on discovery order, a generated
# managed_components path, or whatever happens to be in a developer cache.
#
# patch_core_s3.cmake performs exact-once rewrites into this build directory.
# The hashes below cover every compiled/header/config input plus the upstream
# Apache-2.0 license. An upstream or accidental local edit therefore stops
# configuration and demands a deliberate hardware/audio re-audit; it cannot
# silently revert to a 90 ms DMA queue or lose the reference channel.
#
set(audited_core_s3_dir "${CMAKE_CURRENT_LIST_DIR}")

function(iterate_kit_require_core_s3_input relative_path expected_sha256)
  set(input_path "${audited_core_s3_dir}/${relative_path}")
  if(NOT EXISTS "${input_path}")
    message(FATAL_ERROR
      "Iterate CoreS3 audited input is missing: ${relative_path}")
  endif()
  file(SHA256 "${input_path}" actual_sha256)
  if(NOT actual_sha256 STREQUAL expected_sha256)
    message(FATAL_ERROR
      "Iterate CoreS3 BSP 3.0.2 input changed without re-audit: "
      "${relative_path} (expected ${expected_sha256}, got ${actual_sha256})")
  endif()
endfunction()

iterate_kit_require_core_s3_input(
  "m5stack_core_s3.c"
  "aad53d84f33da583eeece4d5f6eef697b0249e1801dcc94d2277b431cab781a2")
iterate_kit_require_core_s3_input(
  "m5stack_core_s3_idf5.c"
  "bddf9d5f0610375a6f7cb5e445f0012be0ba965893cc8af4b731c30c0c563d09")
iterate_kit_require_core_s3_input(
  "Kconfig"
  "3e39d3937e00de0825e983550967f67a4857368659573f771005fb4a64b84dce")
iterate_kit_require_core_s3_input(
  "idf_component.yml"
  "dc83b04fe8e25c5aecf24da03717609f13c68ef21033e5b73ee3e5e996ccc855")
iterate_kit_require_core_s3_input(
  "LICENSE"
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30")
iterate_kit_require_core_s3_input(
  "include/bsp/config.h"
  "dfa1dd9ebc75bf38925424dec865680fa69aa415bf5b5817d756b82e0bc1f4ef")
iterate_kit_require_core_s3_input(
  "include/bsp/display.h"
  "ac03c81a0967a704e48de7da7ab182f5a82bbef40c900c7ef1e40056ce996de3")
iterate_kit_require_core_s3_input(
  "include/bsp/esp-bsp.h"
  "a7120cf6c96422772b6c46290a91b5e20c8e2accf087f6e7a878854c20e75feb")
iterate_kit_require_core_s3_input(
  "include/bsp/m5stack_core_s3.h"
  "b131d080a1a826cd6d897fa2237f69a8fac1c888bcde18a63503f322f4c5bd88")
iterate_kit_require_core_s3_input(
  "include/bsp/touch.h"
  "435d5c5f516516901174921da546606b84ad5a35bf346a612e78b5d3d97fee4d")
iterate_kit_require_core_s3_input(
  "priv_include/bsp_err_check.h"
  "1641bf04cb10e8ab64d4cf66972bb9648c2ac6fc92b7fd71e4391f0fd45d1995")

file(READ "${audited_core_s3_dir}/idf_component.yml" core_s3_manifest)
string(FIND "${core_s3_manifest}" "version: 3.0.2" version_offset)
if(version_offset EQUAL -1)
  message(FATAL_ERROR
    "Iterate CoreS3 audio patch is audited only for BSP 3.0.2")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/patch_core_s3.cmake")
set(iterate_generated_dir
  "${CMAKE_CURRENT_BINARY_DIR}/iterate_patched")
file(MAKE_DIRECTORY "${iterate_generated_dir}")

iterate_kit_patch_core_s3_audio_source(
  "${audited_core_s3_dir}/m5stack_core_s3_idf5.c"
  "${iterate_generated_dir}/m5stack_core_s3_idf5.c"
)
iterate_kit_patch_core_s3_codec_source(
  "${audited_core_s3_dir}/m5stack_core_s3.c"
  "${iterate_generated_dir}/m5stack_core_s3.c"
)

if("${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}" VERSION_GREATER_EQUAL "5.3")
  set(req
    esp_driver_gpio
    esp_driver_i2s
    esp_driver_sdmmc
    esp_driver_sdspi
    esp_driver_i2c
    espressif__esp_lcd_touch
  )
  set(priv_req esp_driver_spi esp_driver_ledc)
else()
  set(req driver espressif__esp_lcd_touch)
  set(priv_req "")
endif()

idf_component_register(
  SRCS
    "${iterate_generated_dir}/m5stack_core_s3.c"
    "${iterate_generated_dir}/m5stack_core_s3_idf5.c"
  INCLUDE_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/include"
  PRIV_INCLUDE_DIRS "${CMAKE_CURRENT_LIST_DIR}/priv_include"
  REQUIRES ${req} fatfs
  # The Iterate-only DMA tap timestamps completion with esp_timer_get_time().
  # Keep that dependency private: consumers see our timestamp value, not the
  # timer API, and should not acquire another transitive platform dependency.
  PRIV_REQUIRES ${priv_req} esp_lcd esp_timer spiffs esp_psram
)
