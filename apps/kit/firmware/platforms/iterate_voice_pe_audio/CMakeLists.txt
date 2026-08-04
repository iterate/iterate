idf_component_register(
  SRCS
    "voice_pe_audio_owner.c"
    "voice_pe_hardware_config.c"
    "voice_pe_pcm_format.c"
  INCLUDE_DIRS "include"
  REQUIRES
    core
    esp_driver_gpio
    esp_driver_i2c
    esp_driver_i2s
    esp_timer
    freertos
    heap
)

# A separate build directory may pin an experimental cumulative XMOS output
# tap for a deterministic physical A/B. Keep the default here aligned with the
# production policy in voice_pe_hardware_config.c; requiring an explicit cache
# value for experiments prevents a diagnostic flash from silently changing an
# ordinary firmware build.
set(
  ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE
  "3"
  CACHE STRING
  "XMOS uplink tap: 0=raw, 1=AEC, 2=IC, 3=NS, 4=AGC"
)
if(NOT ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE MATCHES "^[0-4]$")
  message(FATAL_ERROR
    "ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE must be one digit from 0 through 4")
endif()
target_compile_definitions(${COMPONENT_LIB} PRIVATE
  ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE=${ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE}
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  # ESP-IDF public headers intentionally expose GCC extensions.
  -Wno-pedantic
)
