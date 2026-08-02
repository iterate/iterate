cmake_minimum_required(VERSION 3.20)

project(iterate_kit_firmware LANGUAGES C CXX)

enable_testing()
find_package(Threads REQUIRED)

if(APPLE AND EXISTS "/opt/homebrew/opt/openssl@3")
  set(
    OPENSSL_ROOT_DIR "/opt/homebrew/opt/openssl@3"
    CACHE PATH "Homebrew OpenSSL 3 prefix")
endif()
find_package(OpenSSL 3 REQUIRED)

set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(CAPNWEB_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(CAPNWEB_BUILD_FUZZER OFF CACHE BOOL "" FORCE)
add_subdirectory(vendor/capnweb)

add_library(iterate-kit-core STATIC
  components/core/src/aec_capture_bridge.c
  components/core/src/aec_signal_window.c
  components/core/src/audio_intent_reconciler.c
  components/core/src/audio_playout.c
  components/core/src/audio.c
  components/core/src/configuration.c
  components/core/src/control_recovery.c
  components/core/src/cpu_usage.c
  components/core/src/device_events.c
  components/core/src/itx_connection.c
  components/core/src/itx_outbox_sender.c
  components/core/src/itx_mount.c
  components/core/src/pcm_clock_playback.c
  components/core/src/pcm_capture_turn.c
  components/core/src/pcm_generation_fence.c
  components/core/src/pcm_lane.c
  components/core/src/pcm_playback_interruption.c
  components/core/src/pcm_uplink_conductor.c
  components/core/src/pcm_uplink_sender.c
  components/core/src/pcm_websocket.c
  components/core/src/peer.c
  components/core/src/retry_gate.c
  components/core/src/runtime_diagnostics.c
  components/core/src/spsc_ring.c
  components/core/src/voicelab_stream.c
  components/core/src/voice_playback_clock.c
  components/core/src/websocket_frame_writer.c
  components/core/src/websocket_frame_reader.c
  components/core/src/websocket_rx.c
  components/core/src/websocket_tx.c
  components/core/src/websocket_text.c
)
target_include_directories(iterate-kit-core PUBLIC
  components/core/include
)
target_compile_features(iterate-kit-core PUBLIC c_std_99)
target_compile_options(iterate-kit-core PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(iterate-kit-core PUBLIC capnweb)

add_library(iterate-kit-posix STATIC
  platforms/iterate_posix/tls_stream.c
  platforms/iterate_posix/websocket_client.c
  platforms/iterate_posix/posix_itx_transport.c
)
target_include_directories(iterate-kit-posix PUBLIC
  platforms/iterate_posix/include
)
target_compile_features(iterate-kit-posix PUBLIC c_std_99)
target_compile_options(iterate-kit-posix PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-posix
  PUBLIC iterate-kit-core OpenSSL::SSL OpenSSL::Crypto
)

if(APPLE)
  find_library(ITERATE_KIT_AUDIO_TOOLBOX_FRAMEWORK AudioToolbox REQUIRED)
  find_library(ITERATE_KIT_CORE_FOUNDATION_FRAMEWORK CoreFoundation REQUIRED)
  add_executable(iterate-kit-cli
    targets/host_cli/main.cpp
  )
  target_compile_features(iterate-kit-cli PRIVATE cxx_std_17)
  target_compile_options(iterate-kit-cli PRIVATE
    -Wall
    -Wextra
    -Werror
    -Wpedantic
  )
  target_link_libraries(iterate-kit-cli PRIVATE
    iterate-kit-posix
    ${ITERATE_KIT_AUDIO_TOOLBOX_FRAMEWORK}
    ${ITERATE_KIT_CORE_FOUNDATION_FRAMEWORK}
  )
endif()

add_library(iterate-kit-capabilities STATIC
  components/capabilities/src/callback_budget.c
  components/capabilities/src/conversation.c
  components/capabilities/src/camera.c
  components/capabilities/src/device_event_stream.c
  components/capabilities/src/leds.c
  components/capabilities/src/metrics.c
  components/capabilities/src/push_to_talk.c
  components/capabilities/src/rpc_internal.c
  components/capabilities/src/screen.c
  components/capabilities/src/screen_capture.c
  components/capabilities/src/servos.c
)
target_include_directories(iterate-kit-capabilities PUBLIC
  components/capabilities/include
)
target_compile_features(iterate-kit-capabilities PUBLIC c_std_99)
target_compile_options(iterate-kit-capabilities PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(iterate-kit-capabilities PUBLIC iterate-kit-core)

add_library(iterate-kit-stackchan STATIC
  devices/stackchan/stackchan.c
)
target_include_directories(iterate-kit-stackchan PUBLIC
  devices/stackchan/include
)
target_compile_features(iterate-kit-stackchan PUBLIC c_std_99)
target_compile_options(iterate-kit-stackchan PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-stackchan
  PUBLIC iterate-kit-capabilities
)

add_library(iterate-kit-m5sticks3 STATIC
  devices/m5sticks3/m5sticks3.c
)
target_include_directories(iterate-kit-m5sticks3 PUBLIC
  devices/m5sticks3/include
)
target_compile_features(iterate-kit-m5sticks3 PUBLIC c_std_99)
target_compile_options(iterate-kit-m5sticks3 PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-m5sticks3
  PUBLIC iterate-kit-capabilities
)

add_library(iterate-kit-voice-satellite STATIC
  devices/voice_satellite/voice_satellite.c
)
target_include_directories(iterate-kit-voice-satellite PUBLIC
  devices/voice_satellite/include
)
target_compile_features(iterate-kit-voice-satellite PUBLIC c_std_99)
target_compile_options(iterate-kit-voice-satellite PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-voice-satellite
  PUBLIC iterate-kit-capabilities
)

add_library(iterate-kit-simulator STATIC
  simulator/src/hardware.cpp
  simulator/src/runner.cpp
)
target_include_directories(iterate-kit-simulator PUBLIC
  simulator/include
)
target_compile_features(iterate-kit-simulator PUBLIC cxx_std_17)
target_compile_options(iterate-kit-simulator PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-kit-simulator
  PUBLIC iterate-kit-capabilities
)

function(add_iterate_kit_simulator target source profile)
  add_executable(${target} ${source})
  target_compile_features(${target} PRIVATE cxx_std_17)
  target_compile_options(${target} PRIVATE
    -Wall
    -Wextra
    -Werror
    -Wpedantic
    -fno-exceptions
    -fno-rtti
  )
  target_link_libraries(
    ${target}
    PRIVATE iterate-kit-simulator ${profile}
  )
endfunction()

add_iterate_kit_simulator(
  iterate-stackchan-simulator
  simulator/devices/stackchan.cpp
  iterate-kit-stackchan
)

add_iterate_kit_simulator(
  iterate-m5sticks3-simulator
  simulator/devices/m5sticks3.cpp
  iterate-kit-m5sticks3
)

add_executable(iterate-stackchan-resource-profile
  simulator/resource_profile.cpp
)
target_include_directories(iterate-stackchan-resource-profile PRIVATE
  platforms/common/include
  platforms/iterate_esp_idf/include
  platforms/iterate_m5unified/include
)
target_compile_features(iterate-stackchan-resource-profile PRIVATE cxx_std_17)
target_compile_options(iterate-stackchan-resource-profile PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-stackchan-resource-profile
  PRIVATE iterate-kit-stackchan iterate-kit-m5sticks3
)

# The host profile uses MinSizeRel to measure optimized code, whose default
# NDEBUG would otherwise compile every assert-based native test out.
add_compile_options(-UNDEBUG)

add_executable(iterate-kit-audio-test
  tests/audio_controller_test.c
)
target_compile_features(iterate-kit-audio-test PRIVATE c_std_99)
target_compile_options(iterate-kit-audio-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(iterate-kit-audio-test PRIVATE iterate-kit-core)
add_test(NAME iterate-kit-audio-test COMMAND iterate-kit-audio-test)

add_executable(iterate-kit-aec-capture-bridge-test
  tests/aec_capture_bridge_test.c
)
target_compile_features(
  iterate-kit-aec-capture-bridge-test PRIVATE c_std_99)
target_compile_options(iterate-kit-aec-capture-bridge-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-aec-capture-bridge-test PRIVATE iterate-kit-core)
add_test(
  NAME iterate-kit-aec-capture-bridge-test
  COMMAND iterate-kit-aec-capture-bridge-test)

add_executable(iterate-kit-aec-signal-window-test
  tests/aec_signal_window_test.c
)
target_compile_features(
  iterate-kit-aec-signal-window-test PRIVATE c_std_99)
target_compile_options(iterate-kit-aec-signal-window-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-aec-signal-window-test PRIVATE iterate-kit-core)
add_test(
  NAME iterate-kit-aec-signal-window-test
  COMMAND iterate-kit-aec-signal-window-test)

add_executable(iterate-kit-pcm-clock-playback-test
  tests/pcm_clock_playback_test.c
)
target_compile_features(
  iterate-kit-pcm-clock-playback-test PRIVATE c_std_99)
target_compile_options(iterate-kit-pcm-clock-playback-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_include_directories(
  iterate-kit-pcm-clock-playback-test PRIVATE
  targets/stackchan/main
)
target_link_libraries(
  iterate-kit-pcm-clock-playback-test PRIVATE iterate-kit-core)
add_test(
  NAME iterate-kit-pcm-clock-playback-test
  COMMAND iterate-kit-pcm-clock-playback-test)

add_executable(iterate-kit-core-s3-capture-reserve-test
  tests/core_s3_capture_reserve_test.c
  platforms/iterate_core_s3_audio/core_s3_capture_reserve.c
)
target_include_directories(
  iterate-kit-core-s3-capture-reserve-test PRIVATE
  platforms/iterate_core_s3_audio/include
  components/core/include
)
target_compile_features(
  iterate-kit-core-s3-capture-reserve-test PRIVATE c_std_99)
target_compile_options(iterate-kit-core-s3-capture-reserve-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
add_test(
  NAME iterate-kit-core-s3-capture-reserve-test
  COMMAND iterate-kit-core-s3-capture-reserve-test)

add_executable(iterate-kit-voice-pe-pcm-format-test
  tests/voice_pe_pcm_format_test.c
  platforms/iterate_voice_pe_audio/voice_pe_pcm_format.c
)
target_include_directories(
  iterate-kit-voice-pe-pcm-format-test PRIVATE
  platforms/iterate_voice_pe_audio/include
  components/core/include
)
target_compile_features(
  iterate-kit-voice-pe-pcm-format-test PRIVATE c_std_99)
target_compile_options(iterate-kit-voice-pe-pcm-format-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
add_test(
  NAME iterate-kit-voice-pe-pcm-format-test
  COMMAND iterate-kit-voice-pe-pcm-format-test)

add_executable(iterate-kit-voice-pe-hardware-config-test
  tests/voice_pe_hardware_config_test.c
  platforms/iterate_voice_pe_audio/voice_pe_hardware_config.c
)
target_include_directories(
  iterate-kit-voice-pe-hardware-config-test PRIVATE
  platforms/iterate_voice_pe_audio/include
  components/core/include
)
target_compile_features(
  iterate-kit-voice-pe-hardware-config-test PRIVATE c_std_99)
target_compile_options(iterate-kit-voice-pe-hardware-config-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
add_test(
  NAME iterate-kit-voice-pe-hardware-config-test
  COMMAND iterate-kit-voice-pe-hardware-config-test)

add_executable(iterate-kit-voice-satellite-test
  tests/voice_satellite_test.c
)
target_compile_features(iterate-kit-voice-satellite-test PRIVATE c_std_99)
target_compile_options(iterate-kit-voice-satellite-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-voice-satellite-test PRIVATE iterate-kit-voice-satellite)
add_test(
  NAME iterate-kit-voice-satellite-test
  COMMAND iterate-kit-voice-satellite-test)

add_executable(iterate-kit-device-events-test
  tests/device_events_test.c
)
target_compile_features(
  iterate-kit-device-events-test PRIVATE c_std_99)
target_compile_options(iterate-kit-device-events-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-device-events-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-device-events-test
  COMMAND iterate-kit-device-events-test
)

add_executable(iterate-kit-retry-gate-test
  tests/retry_gate_test.c
)
target_compile_features(
  iterate-kit-retry-gate-test PRIVATE c_std_99)
target_compile_options(iterate-kit-retry-gate-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-retry-gate-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-retry-gate-test
  COMMAND iterate-kit-retry-gate-test
)

add_executable(iterate-kit-cpu-usage-test
  tests/cpu_usage_test.c
)
target_compile_features(
  iterate-kit-cpu-usage-test PRIVATE c_std_99)
target_compile_options(iterate-kit-cpu-usage-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-cpu-usage-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-cpu-usage-test
  COMMAND iterate-kit-cpu-usage-test
)

add_executable(iterate-kit-runtime-diagnostics-test
  tests/runtime_diagnostics_test.c
)
target_compile_features(
  iterate-kit-runtime-diagnostics-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-runtime-diagnostics-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-runtime-diagnostics-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-runtime-diagnostics-test
  COMMAND iterate-kit-runtime-diagnostics-test
)

add_executable(iterate-kit-control-recovery-test
  tests/control_recovery_test.c
)
target_compile_features(
  iterate-kit-control-recovery-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-control-recovery-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-control-recovery-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-control-recovery-test
  COMMAND iterate-kit-control-recovery-test
)

add_executable(iterate-kit-runtime-diagnostics-fixture
  tests/runtime_diagnostics_fixture.c
)
target_compile_features(
  iterate-kit-runtime-diagnostics-fixture PRIVATE c_std_99)
target_compile_options(
  iterate-kit-runtime-diagnostics-fixture PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-runtime-diagnostics-fixture PRIVATE iterate-kit-core
)

add_executable(iterate-kit-bounded-capture-test
  tests/bounded_capture_test.cpp
)
target_include_directories(iterate-kit-bounded-capture-test PRIVATE
  platforms/common/include
)
target_compile_features(
  iterate-kit-bounded-capture-test PRIVATE cxx_std_17)
target_compile_options(iterate-kit-bounded-capture-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-kit-bounded-capture-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-bounded-capture-test
  COMMAND iterate-kit-bounded-capture-test
)

add_executable(iterate-kit-bounded-playback-test
  tests/bounded_playback_test.cpp
)
target_include_directories(iterate-kit-bounded-playback-test PRIVATE
  platforms/common/include
)
target_compile_features(
  iterate-kit-bounded-playback-test PRIVATE cxx_std_17)
target_compile_options(iterate-kit-bounded-playback-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-kit-bounded-playback-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-bounded-playback-test
  COMMAND iterate-kit-bounded-playback-test
)

add_executable(iterate-kit-realtime-playback-test
  tests/realtime_playback_test.cpp
)
target_include_directories(iterate-kit-realtime-playback-test PRIVATE
  platforms/common/include
  platforms/iterate_m5unified/include
)
target_compile_features(
  iterate-kit-realtime-playback-test PRIVATE cxx_std_17)
target_compile_options(iterate-kit-realtime-playback-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-kit-realtime-playback-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-realtime-playback-test
  COMMAND iterate-kit-realtime-playback-test
)

add_executable(iterate-kit-direct-i2s-stereo-output-test
  tests/direct_i2s_stereo_output_test.cpp
)
target_include_directories(
  iterate-kit-direct-i2s-stereo-output-test PRIVATE
  platforms/common/include
)
target_compile_features(
  iterate-kit-direct-i2s-stereo-output-test PRIVATE cxx_std_17)
target_compile_options(
  iterate-kit-direct-i2s-stereo-output-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-kit-direct-i2s-stereo-output-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-direct-i2s-stereo-output-test
  COMMAND iterate-kit-direct-i2s-stereo-output-test
)

add_executable(iterate-kit-esp-idf-direct-i2s-backend-test
  tests/esp_idf_direct_i2s_backend_test.cpp
)
target_include_directories(
  iterate-kit-esp-idf-direct-i2s-backend-test PRIVATE
  platforms/common/include
  platforms/iterate_esp_idf/include
)
target_compile_features(
  iterate-kit-esp-idf-direct-i2s-backend-test PRIVATE cxx_std_17)
target_compile_options(
  iterate-kit-esp-idf-direct-i2s-backend-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-kit-esp-idf-direct-i2s-backend-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-esp-idf-direct-i2s-backend-test
  COMMAND iterate-kit-esp-idf-direct-i2s-backend-test
)

add_executable(iterate-kit-realtime-owner-control-test
  tests/realtime_owner_control_test.cpp
)
target_include_directories(
  iterate-kit-realtime-owner-control-test PRIVATE
  platforms/common/include
)
target_compile_features(
  iterate-kit-realtime-owner-control-test PRIVATE cxx_std_17)
target_compile_options(
  iterate-kit-realtime-owner-control-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-kit-realtime-owner-control-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-realtime-owner-control-test
  COMMAND iterate-kit-realtime-owner-control-test
)

add_executable(iterate-kit-release-owned-handle-test
  tests/release_owned_handle_test.cpp
)
target_include_directories(
  iterate-kit-release-owned-handle-test PRIVATE
  platforms/common/include
)
target_compile_features(
  iterate-kit-release-owned-handle-test PRIVATE cxx_std_17)
target_compile_options(
  iterate-kit-release-owned-handle-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
target_link_libraries(
  iterate-kit-release-owned-handle-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-release-owned-handle-test
  COMMAND iterate-kit-release-owned-handle-test
)

add_executable(iterate-kit-display-refresh-gate-test
  tests/display_refresh_gate_test.cpp
)
target_include_directories(iterate-kit-display-refresh-gate-test PRIVATE
  platforms/common/include
)
target_compile_features(
  iterate-kit-display-refresh-gate-test PRIVATE cxx_std_17)
target_compile_options(iterate-kit-display-refresh-gate-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -fno-exceptions
  -fno-rtti
)
add_test(
  NAME iterate-kit-display-refresh-gate-test
  COMMAND iterate-kit-display-refresh-gate-test
)

add_executable(iterate-kit-configuration-test
  tests/configuration_test.c
)
target_compile_features(
  iterate-kit-configuration-test PRIVATE c_std_99)
target_compile_options(iterate-kit-configuration-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-configuration-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-configuration-test
  COMMAND iterate-kit-configuration-test
)

add_executable(iterate-kit-cli-wav-test
  targets/host_cli/cli_wav.c
  tests/cli_wav_test.c
)
target_include_directories(
  iterate-kit-cli-wav-test PRIVATE targets/host_cli)
target_compile_features(
  iterate-kit-cli-wav-test PRIVATE c_std_11)
target_compile_options(iterate-kit-cli-wav-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -Wconversion
  -Wshadow
)
add_test(
  NAME iterate-kit-cli-wav-test
  COMMAND iterate-kit-cli-wav-test
)

add_executable(iterate-kit-audio-playout-test
  tests/audio_playout_test.c
)
target_compile_features(
  iterate-kit-audio-playout-test PRIVATE c_std_99)
target_compile_options(iterate-kit-audio-playout-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-audio-playout-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-audio-playout-test
  COMMAND iterate-kit-audio-playout-test
)

add_executable(iterate-kit-voice-playback-clock-test
  tests/voice_playback_clock_test.c
)
target_compile_features(
  iterate-kit-voice-playback-clock-test PRIVATE c_std_99)
target_compile_options(iterate-kit-voice-playback-clock-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-voice-playback-clock-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-voice-playback-clock-test
  COMMAND iterate-kit-voice-playback-clock-test
)

add_executable(iterate-kit-voicelab-stream-test
  tests/voicelab_stream_test.c
)
target_compile_features(
  iterate-kit-voicelab-stream-test PRIVATE c_std_99)
target_compile_options(iterate-kit-voicelab-stream-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-voicelab-stream-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-voicelab-stream-test
  COMMAND iterate-kit-voicelab-stream-test
)

add_executable(iterate-kit-capnweb-oneway-call-test
  tests/capnweb_oneway_call_test.c
)
target_compile_features(
  iterate-kit-capnweb-oneway-call-test PRIVATE c_std_99)
target_compile_options(iterate-kit-capnweb-oneway-call-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-capnweb-oneway-call-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-capnweb-oneway-call-test
  COMMAND iterate-kit-capnweb-oneway-call-test
)

add_executable(iterate-kit-itx-mount-test
  tests/itx_mount_test.c
)
target_compile_features(
  iterate-kit-itx-mount-test PRIVATE c_std_99)
target_compile_options(iterate-kit-itx-mount-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-itx-mount-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-itx-mount-test
  COMMAND iterate-kit-itx-mount-test
)

add_executable(iterate-kit-itx-connection-test
  tests/itx_connection_test.c
)
target_compile_features(
  iterate-kit-itx-connection-test PRIVATE c_std_99)
target_compile_options(iterate-kit-itx-connection-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-itx-connection-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-itx-connection-test
  COMMAND iterate-kit-itx-connection-test
)

add_executable(iterate-kit-spsc-ring-test
  tests/spsc_ring_test.c
)
target_compile_features(
  iterate-kit-spsc-ring-test PRIVATE c_std_99)
target_compile_options(iterate-kit-spsc-ring-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-spsc-ring-test
  PRIVATE iterate-kit-core Threads::Threads
)
add_test(
  NAME iterate-kit-spsc-ring-test
  COMMAND iterate-kit-spsc-ring-test
)

add_executable(iterate-kit-atomic-test
  tests/atomic_test.c
)
target_compile_features(
  iterate-kit-atomic-test PRIVATE c_std_99)
target_compile_options(iterate-kit-atomic-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-atomic-test
  PRIVATE iterate-kit-core Threads::Threads
)
add_test(
  NAME iterate-kit-atomic-test
  COMMAND iterate-kit-atomic-test
)

add_executable(iterate-kit-websocket-text-test
  tests/websocket_text_test.c
)
target_compile_features(
  iterate-kit-websocket-text-test PRIVATE c_std_99)
target_compile_options(iterate-kit-websocket-text-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-websocket-text-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-websocket-text-test
  COMMAND iterate-kit-websocket-text-test
)

add_executable(iterate-kit-websocket-mailbox-test
  tests/websocket_mailbox_test.c
)
target_compile_features(
  iterate-kit-websocket-mailbox-test PRIVATE c_std_99)
target_compile_options(iterate-kit-websocket-mailbox-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-websocket-mailbox-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-websocket-mailbox-test
  COMMAND iterate-kit-websocket-mailbox-test
)

add_executable(iterate-kit-pcm-websocket-test
  tests/pcm_websocket_test.c
)
target_compile_features(
  iterate-kit-pcm-websocket-test PRIVATE c_std_99)
target_compile_options(iterate-kit-pcm-websocket-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-pcm-websocket-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-pcm-websocket-test
  COMMAND iterate-kit-pcm-websocket-test
)

add_executable(iterate-kit-pcm-lane-test
  tests/pcm_lane_test.c
)
target_compile_features(
  iterate-kit-pcm-lane-test PRIVATE c_std_99)
target_compile_options(iterate-kit-pcm-lane-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-pcm-lane-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-pcm-lane-test
  COMMAND iterate-kit-pcm-lane-test
)

add_executable(iterate-kit-pcm-capture-turn-test
  tests/pcm_capture_turn_test.c
)
target_compile_features(
  iterate-kit-pcm-capture-turn-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-pcm-capture-turn-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-pcm-capture-turn-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-pcm-capture-turn-test
  COMMAND iterate-kit-pcm-capture-turn-test
)

add_executable(iterate-kit-pcm-generation-fence-test
  tests/pcm_generation_fence_test.c
)
target_compile_features(
  iterate-kit-pcm-generation-fence-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-pcm-generation-fence-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-pcm-generation-fence-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-pcm-generation-fence-test
  COMMAND iterate-kit-pcm-generation-fence-test
)

add_executable(iterate-kit-pcm-playback-interruption-test
  tests/pcm_playback_interruption_test.c
)
target_compile_features(
  iterate-kit-pcm-playback-interruption-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-pcm-playback-interruption-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-pcm-playback-interruption-test PRIVATE iterate-kit-core)
add_test(
  NAME iterate-kit-pcm-playback-interruption-test
  COMMAND iterate-kit-pcm-playback-interruption-test)

add_executable(iterate-kit-pcm-uplink-sender-test
  tests/pcm_uplink_sender_test.c
)
target_compile_features(
  iterate-kit-pcm-uplink-sender-test PRIVATE c_std_99)
target_compile_options(iterate-kit-pcm-uplink-sender-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-pcm-uplink-sender-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-pcm-uplink-sender-test
  COMMAND iterate-kit-pcm-uplink-sender-test
)

add_executable(iterate-kit-pcm-uplink-conductor-test
  tests/pcm_uplink_conductor_test.c
)
target_compile_features(
  iterate-kit-pcm-uplink-conductor-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-pcm-uplink-conductor-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-pcm-uplink-conductor-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-pcm-uplink-conductor-test
  COMMAND iterate-kit-pcm-uplink-conductor-test
)

add_executable(iterate-kit-pcm-realtime-fault-harness-test
  tests/pcm_realtime_fault_harness_test.c
)
target_compile_features(
  iterate-kit-pcm-realtime-fault-harness-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-pcm-realtime-fault-harness-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-pcm-realtime-fault-harness-test
  PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-pcm-realtime-fault-harness-test
  COMMAND iterate-kit-pcm-realtime-fault-harness-test
)

add_executable(iterate-kit-websocket-frame-writer-test
  tests/websocket_frame_writer_test.c
)
target_compile_features(
  iterate-kit-websocket-frame-writer-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-websocket-frame-writer-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-websocket-frame-writer-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-websocket-frame-writer-test
  COMMAND iterate-kit-websocket-frame-writer-test
)

add_executable(iterate-kit-websocket-tx-test
  tests/websocket_tx_test.c
)
target_compile_features(
  iterate-kit-websocket-tx-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-websocket-tx-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-websocket-tx-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-websocket-tx-test
  COMMAND iterate-kit-websocket-tx-test
)

add_executable(iterate-kit-websocket-rx-test
  tests/websocket_rx_test.c
)
target_compile_features(
  iterate-kit-websocket-rx-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-websocket-rx-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-websocket-rx-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-websocket-rx-test
  COMMAND iterate-kit-websocket-rx-test
)

add_executable(iterate-kit-esp-idf-configuration-test
  tests/esp_idf_configuration_test.c
  platforms/iterate_esp_idf/configuration.c
)
target_include_directories(
  iterate-kit-esp-idf-configuration-test PRIVATE
  tests
  tests/fakes
  platforms/iterate_esp_idf/include
)
target_compile_features(
  iterate-kit-esp-idf-configuration-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-esp-idf-configuration-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-esp-idf-configuration-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-esp-idf-configuration-test
  COMMAND iterate-kit-esp-idf-configuration-test
)

add_executable(iterate-kit-esp-idf-websocket-policy-test
  tests/esp_idf_websocket_policy_test.c
)
target_include_directories(
  iterate-kit-esp-idf-websocket-policy-test PRIVATE
  components/core/include
  platforms/iterate_esp_idf/include
)
target_compile_features(
  iterate-kit-esp-idf-websocket-policy-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-esp-idf-websocket-policy-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
add_test(
  NAME iterate-kit-esp-idf-websocket-policy-test
  COMMAND iterate-kit-esp-idf-websocket-policy-test
)

add_executable(iterate-kit-esp-idf-itx-transport-test
  tests/esp_idf_itx_transport_test.c
  tests/fakes/fake_esp_idf_control_websocket.c
  tests/fakes/fake_esp_idf_platform.c
  platforms/iterate_esp_idf/itx_transport.c
)
target_include_directories(
  iterate-kit-esp-idf-itx-transport-test PRIVATE
  tests/fakes
  platforms/iterate_esp_idf/include
)
target_compile_features(
  iterate-kit-esp-idf-itx-transport-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-esp-idf-itx-transport-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-esp-idf-itx-transport-test
  PRIVATE iterate-kit-core Threads::Threads
)
add_test(
  NAME iterate-kit-esp-idf-itx-transport-test
  COMMAND iterate-kit-esp-idf-itx-transport-test
)

add_executable(iterate-kit-posix-websocket-test
  tests/posix_websocket_test.c
)
target_compile_features(
  iterate-kit-posix-websocket-test PRIVATE c_std_99)
target_compile_options(iterate-kit-posix-websocket-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-posix-websocket-test PRIVATE iterate-kit-posix)
add_test(
  NAME iterate-kit-posix-websocket-test
  COMMAND iterate-kit-posix-websocket-test)

add_executable(iterate-kit-posix-itx-transport-test
  tests/posix_itx_transport_test.c
  tests/fakes/fake_posix_websocket.c
  platforms/iterate_posix/posix_itx_transport.c
)
target_include_directories(
  iterate-kit-posix-itx-transport-test PRIVATE
  tests/fakes
  platforms/iterate_posix/include
)
target_compile_features(
  iterate-kit-posix-itx-transport-test PRIVATE c_std_99)
target_compile_options(iterate-kit-posix-itx-transport-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-posix-itx-transport-test
  PRIVATE iterate-kit-core OpenSSL::SSL OpenSSL::Crypto)
add_test(
  NAME iterate-kit-posix-itx-transport-test
  COMMAND iterate-kit-posix-itx-transport-test)

add_executable(iterate-kit-esp-idf-pcm-transport-test
  tests/esp_idf_pcm_transport_test.c
  tests/fakes/fake_esp_idf_platform.c
  tests/fakes/fake_esp_idf_pcm_websocket.c
  platforms/iterate_esp_idf/pcm_transport.c
)
target_include_directories(
  iterate-kit-esp-idf-pcm-transport-test PRIVATE
  tests/fakes
  platforms/iterate_esp_idf/include
)
target_compile_features(
  iterate-kit-esp-idf-pcm-transport-test PRIVATE c_std_99)
target_compile_options(
  iterate-kit-esp-idf-pcm-transport-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-esp-idf-pcm-transport-test
  PRIVATE iterate-kit-core Threads::Threads
)
add_test(
  NAME iterate-kit-esp-idf-pcm-transport-test
  COMMAND iterate-kit-esp-idf-pcm-transport-test
)

add_executable(iterate-kit-configuration-decoder-fixture
  tests/configuration_decoder_fixture.c
)
target_compile_features(
  iterate-kit-configuration-decoder-fixture PRIVATE c_std_99)
target_compile_options(
  iterate-kit-configuration-decoder-fixture PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-configuration-decoder-fixture PRIVATE iterate-kit-core
)

add_executable(iterate-kit-metrics-subscription-test
  tests/metrics_subscription_test.c
)
target_compile_features(
  iterate-kit-metrics-subscription-test PRIVATE c_std_99)
target_compile_options(iterate-kit-metrics-subscription-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-metrics-subscription-test
  PRIVATE iterate-kit-capabilities
)
add_test(
  NAME iterate-kit-metrics-subscription-test
  COMMAND iterate-kit-metrics-subscription-test
)

add_executable(iterate-kit-m5sticks3-events-test
  tests/m5sticks3_events_test.c
)
target_compile_features(
  iterate-kit-m5sticks3-events-test PRIVATE c_std_99)
target_compile_options(iterate-kit-m5sticks3-events-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-m5sticks3-events-test PRIVATE iterate-kit-m5sticks3
)
add_test(
  NAME iterate-kit-m5sticks3-events-test
  COMMAND iterate-kit-m5sticks3-events-test
)

add_executable(iterate-kit-stackchan-control-test
  tests/stackchan_control_test.c
)
target_compile_features(
  iterate-kit-stackchan-control-test PRIVATE c_std_99)
target_compile_options(iterate-kit-stackchan-control-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-stackchan-control-test PRIVATE iterate-kit-stackchan
)
add_test(
  NAME iterate-kit-stackchan-control-test
  COMMAND iterate-kit-stackchan-control-test
)

add_executable(iterate-kit-audio-intent-reconciler-test
  tests/audio_intent_reconciler_test.c
)
target_compile_features(
  iterate-kit-audio-intent-reconciler-test PRIVATE c_std_99)
target_compile_options(iterate-kit-audio-intent-reconciler-test PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
target_link_libraries(
  iterate-kit-audio-intent-reconciler-test PRIVATE iterate-kit-core
)
add_test(
  NAME iterate-kit-audio-intent-reconciler-test
  COMMAND iterate-kit-audio-intent-reconciler-test
)

# Source annotations do not prove where an ESP-IDF linker ultimately places an
# ISR callback graph. Exercise the same post-link audit used by the real target
# with tiny fixtures so its fail-closed behavior remains deterministic on host
# CI, including the `.ext_ram.bss` versus internal `.dram0.bss` distinction.
set(ITERATE_KIT_REALTIME_ELF_AUDIT
  "${CMAKE_CURRENT_SOURCE_DIR}/cmake/audit_m5sticks3_realtime_elf.cmake")
set(ITERATE_KIT_REALTIME_ELF_AUDIT_FIXTURES
  "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/realtime_elf_audit")

add_test(
  NAME iterate-kit-realtime-elf-audit-good-test
  COMMAND "${CMAKE_COMMAND}"
    "-DSYMBOL_TABLE_FILE=${ITERATE_KIT_REALTIME_ELF_AUDIT_FIXTURES}/symbols.good"
    "-DCONFIG_FILE=${ITERATE_KIT_REALTIME_ELF_AUDIT_FIXTURES}/sdkconfig.good"
    -P "${ITERATE_KIT_REALTIME_ELF_AUDIT}"
)

add_test(
  NAME iterate-kit-realtime-elf-audit-rejects-flash-callback-test
  COMMAND "${CMAKE_COMMAND}"
    "-DSYMBOL_TABLE_FILE=${ITERATE_KIT_REALTIME_ELF_AUDIT_FIXTURES}/symbols.callback_in_flash"
    "-DCONFIG_FILE=${ITERATE_KIT_REALTIME_ELF_AUDIT_FIXTURES}/sdkconfig.good"
    -P "${ITERATE_KIT_REALTIME_ELF_AUDIT}"
)
set_tests_properties(
  iterate-kit-realtime-elf-audit-rejects-flash-callback-test
  PROPERTIES WILL_FAIL TRUE
)

add_test(
  NAME iterate-kit-realtime-elf-audit-rejects-psram-runtime-test
  COMMAND "${CMAKE_COMMAND}"
    "-DSYMBOL_TABLE_FILE=${ITERATE_KIT_REALTIME_ELF_AUDIT_FIXTURES}/symbols.runtime_in_psram"
    "-DCONFIG_FILE=${ITERATE_KIT_REALTIME_ELF_AUDIT_FIXTURES}/sdkconfig.good"
    -P "${ITERATE_KIT_REALTIME_ELF_AUDIT}"
)
set_tests_properties(
  iterate-kit-realtime-elf-audit-rejects-psram-runtime-test
  PROPERTIES WILL_FAIL TRUE
)
