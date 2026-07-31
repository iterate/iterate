#
# CoreS3's published BSP exposes ordinary duplex I2S only, while the board's
# useful echo reference is ES7210 MIC3 on a four-slot TDM receive stream. A
# project-level component override is the narrowest supported seam: every
# unrelated BSP source/header/dependency still comes from the exact managed
# 3.0.2 component selected by the target.
#
# patch_core_s3.cmake performs exact-once rewrites into this build directory.
# An upstream version/source change therefore stops configuration and demands a
# deliberate hardware/audio re-audit; it cannot silently revert to a 90 ms DMA
# queue or lose the reference channel.
#
idf_component_get_property(
  original_core_s3_dir
  espressif__m5stack_core_s3
  COMPONENT_OVERRIDEN_DIR
)

if(NOT original_core_s3_dir)
  message(FATAL_ERROR
    "Iterate CoreS3 override could not locate managed m5stack_core_s3")
endif()

file(READ "${original_core_s3_dir}/idf_component.yml" core_s3_manifest)
string(FIND "${core_s3_manifest}" "version: \"3.0.2\"" version_offset)
if(version_offset EQUAL -1)
  message(FATAL_ERROR
    "Iterate CoreS3 audio patch is audited only for BSP 3.0.2")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/patch_core_s3.cmake")
set(iterate_generated_dir
  "${CMAKE_CURRENT_BINARY_DIR}/iterate_patched")
file(MAKE_DIRECTORY "${iterate_generated_dir}")

iterate_kit_patch_core_s3_audio_source(
  "${original_core_s3_dir}/m5stack_core_s3_idf5.c"
  "${iterate_generated_dir}/m5stack_core_s3_idf5.c"
)
iterate_kit_patch_core_s3_codec_source(
  "${original_core_s3_dir}/m5stack_core_s3.c"
  "${iterate_generated_dir}/m5stack_core_s3.c"
)

if("${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}" VERSION_GREATER_EQUAL "5.3")
  set(req
    esp_driver_gpio
    esp_driver_i2s
    esp_driver_sdmmc
    esp_driver_sdspi
    esp_driver_i2c
  )
  set(priv_req esp_driver_spi esp_driver_ledc)
else()
  set(req driver)
  set(priv_req "")
endif()

idf_component_register(
  SRCS
    "${iterate_generated_dir}/m5stack_core_s3.c"
    "${iterate_generated_dir}/m5stack_core_s3_idf5.c"
  INCLUDE_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/include"
    "${original_core_s3_dir}/include"
  PRIV_INCLUDE_DIRS "${original_core_s3_dir}/priv_include"
  REQUIRES ${req} fatfs
  # The Iterate-only DMA tap timestamps completion with esp_timer_get_time().
  # Keep that dependency private: consumers see our timestamp value, not the
  # timer API, and should not acquire another transitive platform dependency.
  PRIV_REQUIRES ${priv_req} esp_lcd esp_timer spiffs esp_psram
)
