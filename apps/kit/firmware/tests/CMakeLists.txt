set(ITERATE_KIT_BOUNDARY_CHECK
    "${CMAKE_CURRENT_SOURCE_DIR}/verify_core_boundary.cmake")

# Keep both entry points: ordinary builds must enforce the boundary, while the
# named CTest gives CI and developers a focused, independently runnable check.
add_custom_target(
  iterate-kit-architecture-check ALL
  COMMAND
    "${CMAKE_COMMAND}"
    "-DITERATE_KIT_FIRMWARE_ROOT=${CMAKE_CURRENT_SOURCE_DIR}/.."
    -P "${ITERATE_KIT_BOUNDARY_CHECK}"
  COMMENT "Checking the firmware component boundary"
  VERBATIM)

add_test(
  NAME iterate-kit-core-boundary
  COMMAND
    "${CMAKE_COMMAND}"
    "-DITERATE_KIT_FIRMWARE_ROOT=${CMAKE_CURRENT_SOURCE_DIR}/.."
    -P "${ITERATE_KIT_BOUNDARY_CHECK}")

function(iterate_kit_add_core_test NAME SOURCE)
  add_executable(${NAME} ${SOURCE})
  target_compile_features(${NAME} PRIVATE c_std_99)
  target_compile_options(${NAME} PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic)
  target_link_libraries(${NAME} PRIVATE iterate-kit-core)
  add_test(NAME ${NAME} COMMAND ${NAME})
endfunction()

iterate_kit_add_core_test(iterate-kit-atomic-test atomic_test.c)
iterate_kit_add_core_test(iterate-kit-audio-playout-test audio_playout_test.c)
iterate_kit_add_core_test(iterate-kit-configuration-test configuration_test.c)
iterate_kit_add_core_test(iterate-kit-device-events-test device_events_test.c)
iterate_kit_add_core_test(iterate-kit-itx-connection-test itx_connection_test.c)
iterate_kit_add_core_test(iterate-kit-itx-mount-test itx_mount_test.c)
iterate_kit_add_core_test(iterate-kit-retry-gate-test retry_gate_test.c)
iterate_kit_add_core_test(iterate-kit-spsc-ring-test spsc_ring_test.c)
iterate_kit_add_core_test(iterate-kit-talk-button-test talk_button_test.c)
iterate_kit_add_core_test(
  iterate-kit-voice-playback-clock-test voice_playback_clock_test.c)
iterate_kit_add_core_test(iterate-kit-voicelab-stream-test voicelab_stream_test.c)
iterate_kit_add_core_test(
  iterate-kit-websocket-frame-writer-test websocket_frame_writer_test.c)
iterate_kit_add_core_test(iterate-kit-websocket-rx-test websocket_rx_test.c)
iterate_kit_add_core_test(iterate-kit-websocket-text-test websocket_text_test.c)
iterate_kit_add_core_test(iterate-kit-websocket-tx-test websocket_tx_test.c)

add_executable(iterate-kit-audio-seams-test audio_seams_test.c)
target_compile_features(iterate-kit-audio-seams-test PRIVATE c_std_99)
target_compile_options(iterate-kit-audio-seams-test PRIVATE
  -UNDEBUG
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-audio-seams-test PRIVATE iterate-kit-audio)
add_test(NAME iterate-kit-audio-seams-test COMMAND iterate-kit-audio-seams-test)

add_executable(iterate-kit-push-to-talk-test push_to_talk_test.c)
target_compile_features(iterate-kit-push-to-talk-test PRIVATE c_std_99)
target_compile_options(iterate-kit-push-to-talk-test PRIVATE
  -UNDEBUG
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(
  iterate-kit-push-to-talk-test PRIVATE iterate-kit-capabilities)
add_test(NAME iterate-kit-push-to-talk-test COMMAND iterate-kit-push-to-talk-test)

if(APPLE)
  function(iterate_kit_add_cli_test NAME)
    add_executable(${NAME} ${ARGN})
    target_include_directories(
      ${NAME} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../targets/host_cli")
    target_compile_features(${NAME} PRIVATE c_std_11)
    target_compile_options(${NAME} PRIVATE
      -UNDEBUG
      -Wall
      -Wextra
      -Werror
      -Wpedantic
      -Wconversion
      -Wshadow)
    target_link_libraries(${NAME} PRIVATE iterate-kit-core)
    add_test(NAME ${NAME} COMMAND ${NAME})
  endfunction()

  iterate_kit_add_cli_test(
    iterate-kit-cli-delivery-fault-test
    ../targets/host_cli/cli_delivery_fault.c
    ../targets/host_cli/cli_fault_schedule.c
    cli_delivery_fault_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-device-profile-test
    ../targets/host_cli/cli_device_profile.c
    cli_device_profile_test.c)
  target_include_directories(
    iterate-kit-cli-device-profile-test
    PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../platforms/darwin/include")
  add_executable(
    iterate-kit-darwin-audio-codec-test
    darwin_audio_codec_test.c)
  target_compile_features(iterate-kit-darwin-audio-codec-test PRIVATE c_std_11)
  target_compile_options(iterate-kit-darwin-audio-codec-test PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic
    -Wconversion
    -Wshadow)
  target_link_libraries(
    iterate-kit-darwin-audio-codec-test PRIVATE iterate-kit-darwin)
  add_test(
    NAME iterate-kit-darwin-audio-codec-test
    COMMAND iterate-kit-darwin-audio-codec-test)

  add_executable(
    iterate-kit-cli-device-controls-test
    ../targets/host_cli/cli_device_controls.c
    cli_device_controls_test.c)
  target_include_directories(
    iterate-kit-cli-device-controls-test
    PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../targets/host_cli")
  target_compile_features(
    iterate-kit-cli-device-controls-test PRIVATE c_std_11)
  target_compile_options(iterate-kit-cli-device-controls-test PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic
    -Wconversion
    -Wshadow)
  target_link_libraries(
    iterate-kit-cli-device-controls-test PRIVATE
    iterate-kit-capabilities
    iterate-kit-darwin)
  add_test(
    NAME iterate-kit-cli-device-controls-test
    COMMAND iterate-kit-cli-device-controls-test)
  iterate_kit_add_cli_test(
    iterate-kit-cli-fault-schedule-test
    ../targets/host_cli/cli_fault_schedule.c
    cli_fault_schedule_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-keyboard-test
    ../targets/host_cli/cli_keyboard.c
    cli_keyboard_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-microphone-test
    ../targets/host_cli/cli_microphone.c
    cli_microphone_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-options-test
    ../targets/host_cli/cli_options.c
    cli_options_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-paced-sink-test
    ../targets/host_cli/cli_paced_sink.c
    ../targets/host_cli/cli_speaker.c
    cli_paced_sink_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-report-test
    ../targets/host_cli/cli_report.c
    cli_report_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-speaker-test
    ../targets/host_cli/cli_speaker.c
    cli_speaker_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-virtual-clock-test
    ../targets/host_cli/cli_fault_schedule.c
    ../targets/host_cli/cli_virtual_clock.c
    cli_virtual_clock_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-wav-test
    ../targets/host_cli/cli_wav.c
    cli_wav_test.c)

  add_executable(
    iterate-kit-darwin-audio-input-test
    darwin_audio_input_test.c)
  target_compile_features(iterate-kit-darwin-audio-input-test PRIVATE c_std_11)
  target_compile_options(iterate-kit-darwin-audio-input-test PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic
    -Wconversion
    -Wshadow)
  target_link_libraries(
    iterate-kit-darwin-audio-input-test
    PRIVATE iterate-kit-darwin)
  add_test(
    NAME iterate-kit-darwin-audio-input-test
    COMMAND iterate-kit-darwin-audio-input-test)

  add_executable(
    iterate-kit-darwin-audio-output-test
    darwin_audio_output_test.c)
  target_compile_features(iterate-kit-darwin-audio-output-test PRIVATE c_std_11)
  target_compile_options(iterate-kit-darwin-audio-output-test PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic
    -Wconversion
    -Wshadow)
  target_link_libraries(
    iterate-kit-darwin-audio-output-test
    PRIVATE iterate-kit-darwin)
  add_test(
    NAME iterate-kit-darwin-audio-output-test
    COMMAND iterate-kit-darwin-audio-output-test)

  add_executable(
    iterate-kit-posix-websocket-test
    posix_websocket_test.c)
  target_compile_features(iterate-kit-posix-websocket-test PRIVATE c_std_99)
  target_compile_options(iterate-kit-posix-websocket-test PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic)
  target_link_libraries(
    iterate-kit-posix-websocket-test PRIVATE iterate-kit-darwin)
  add_test(
    NAME iterate-kit-posix-websocket-test
    COMMAND iterate-kit-posix-websocket-test)

  add_executable(
    iterate-kit-posix-itx-transport-test
    posix_itx_transport_test.c
    fakes/fake_posix_websocket.c
    ../platforms/darwin/posix_itx_transport.c)
  target_include_directories(iterate-kit-posix-itx-transport-test PRIVATE
    fakes
    ../platforms/darwin/include)
  target_compile_features(iterate-kit-posix-itx-transport-test PRIVATE c_std_99)
  target_compile_options(iterate-kit-posix-itx-transport-test PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic)
  target_link_libraries(
    iterate-kit-posix-itx-transport-test PRIVATE iterate-kit-darwin)
  add_test(
    NAME iterate-kit-posix-itx-transport-test
    COMMAND iterate-kit-posix-itx-transport-test)
endif()
