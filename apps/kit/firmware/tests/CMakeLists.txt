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
iterate_kit_add_core_test(iterate-kit-configuration-test configuration_test.c)
iterate_kit_add_core_test(
  iterate-kit-conversation-launch-test conversation_launch_test.c)
iterate_kit_add_core_test(
  iterate-kit-conversation-lights-test conversation_lights_test.c)
iterate_kit_add_core_test(
  iterate-kit-conversation-overlay-test conversation_overlay_test.c)
iterate_kit_add_core_test(iterate-kit-device-events-test device_events_test.c)
iterate_kit_add_core_test(iterate-kit-itx-connection-test itx_connection_test.c)
iterate_kit_add_core_test(iterate-kit-itx-mount-test itx_mount_test.c)
iterate_kit_add_core_test(iterate-kit-mount-watchdog-test mount_watchdog_test.c)
iterate_kit_add_core_test(iterate-kit-retry-gate-test retry_gate_test.c)
iterate_kit_add_core_test(iterate-kit-spsc-ring-test spsc_ring_test.c)
iterate_kit_add_core_test(iterate-kit-touch-tap-test touch_tap_test.c)
iterate_kit_add_core_test(
  iterate-kit-voice-playback-clock-test voice_playback_clock_test.c)
iterate_kit_add_core_test(iterate-kit-voicelab-stream-test voicelab_stream_test.c)
iterate_kit_add_core_test(
  iterate-kit-websocket-frame-writer-test websocket_frame_writer_test.c)
iterate_kit_add_core_test(iterate-kit-websocket-rx-test websocket_rx_test.c)
iterate_kit_add_core_test(iterate-kit-websocket-text-test websocket_text_test.c)
iterate_kit_add_core_test(iterate-kit-websocket-tx-test websocket_tx_test.c)

# THE SHARED LOOP, ON A LAPTOP. Four boards run components/voice and nothing
# outside a flash had ever compiled it, so the mapping from a press to an
# intent was verified only by diffing against the device files it replaced.
# The pretend ESP-IDF it links is tests/fakes/esp_idf; see the README there.
add_executable(iterate-kit-voice-loop-intent-test voice_loop_intent_test.c)
target_compile_features(iterate-kit-voice-loop-intent-test PRIVATE c_std_11)
target_compile_options(iterate-kit-voice-loop-intent-test PRIVATE
  -UNDEBUG
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-voice-loop-intent-test PRIVATE
  iterate-kit-voice
  iterate-kit-esp-idf-fakes)
add_test(
  NAME iterate-kit-voice-loop-intent-test
  COMMAND iterate-kit-voice-loop-intent-test)

# THE SAME LOOP, DRIVEN FROM THE AUDIO SIDE. A separate executable rather than
# more scenarios in the file above, because the loop is a PROGRAM: its state is
# one file-static and it brings itself up once, so a board that takes turns
# differently is a different process. `on_control` is reachable only by
# delivering a spk-frame batch, which is why the bug in it was in no host build.
add_executable(
  iterate-kit-voice-loop-answer-clock-test voice_loop_answer_clock_test.c)
target_compile_features(
  iterate-kit-voice-loop-answer-clock-test PRIVATE c_std_11)
target_compile_options(iterate-kit-voice-loop-answer-clock-test PRIVATE
  -UNDEBUG
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-voice-loop-answer-clock-test PRIVATE
  iterate-kit-voice
  iterate-kit-esp-idf-fakes)
add_test(
  NAME iterate-kit-voice-loop-answer-clock-test
  COMMAND iterate-kit-voice-loop-answer-clock-test)

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

add_executable(iterate-kit-camera-test camera_test.c)
target_compile_features(iterate-kit-camera-test PRIVATE c_std_99)
target_compile_options(iterate-kit-camera-test PRIVATE
  -UNDEBUG
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-camera-test PRIVATE iterate-kit-capabilities)
add_test(NAME iterate-kit-camera-test COMMAND iterate-kit-camera-test)

add_executable(iterate-kit-health-test health_test.c)
target_compile_features(iterate-kit-health-test PRIVATE c_std_99)
target_compile_options(iterate-kit-health-test PRIVATE
  -UNDEBUG
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-health-test PRIVATE iterate-kit-capabilities)
add_test(NAME iterate-kit-health-test COMMAND iterate-kit-health-test)

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

function(iterate_kit_add_avatar_test NAME SOURCE)
  add_executable(${NAME} ${SOURCE})
  target_compile_features(${NAME} PRIVATE c_std_99)
  target_compile_options(${NAME} PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic)
  target_link_libraries(${NAME} PRIVATE iterate-kit-avatar)
  add_test(NAME ${NAME} COMMAND ${NAME})
endfunction()

iterate_kit_add_avatar_test(
  iterate-kit-face-animator-test
  ../components/avatar/tests/face_animator_test.c)
iterate_kit_add_avatar_test(
  iterate-kit-face-avatar-registry-test
  ../components/avatar/tests/face_avatar_registry_test.c)
iterate_kit_add_avatar_test(
  iterate-kit-face-doze-test
  ../components/avatar/tests/face_doze_test.c)
iterate_kit_add_avatar_test(
  iterate-kit-face-keyframe-test
  ../components/avatar/tests/face_keyframe_test.c)
iterate_kit_add_avatar_test(
  iterate-kit-face-performance-test
  ../components/avatar/tests/face_performance_test.c)
iterate_kit_add_avatar_test(
  iterate-kit-face-scale-test
  ../components/avatar/tests/face_scale_test.c)
iterate_kit_add_avatar_test(
  iterate-kit-face-sprite-sheet-test
  ../components/avatar/tests/face_sprite_sheet_test.c)
iterate_kit_add_avatar_test(
  iterate-kit-face-stage-test
  ../components/avatar/tests/face_stage_test.c)
iterate_kit_add_avatar_test(
  iterate-kit-face-viseme-queue-test
  ../components/avatar/tests/face_viseme_queue_test.c)

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
    iterate-kit-cli-screen-test
    ../targets/host_cli/cli_screen.c
    cli_screen_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-report-test
    ../targets/host_cli/cli_report.c
    cli_report_test.c)
  iterate_kit_add_cli_test(
    iterate-kit-cli-speaker-test
    ../targets/host_cli/cli_speaker.c
    cli_speaker_test.c)
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

# HAVPE's adopted pure hardware policy: byte-exact register/wire vectors and
# the deliberately compiler-visible XMOS uplink-stage selector. These build
# the device sources directly because devices/ are ESP-IDF components, not
# host libraries; the two files under test are pure C99 by construction.
function(iterate_kit_add_havpe_pure_test NAME)
  add_executable(${NAME} ${ARGN})
  target_include_directories(${NAME} PRIVATE
    ../devices/havpe
    ../components/core/include)
  target_compile_features(${NAME} PRIVATE c_std_99)
  target_compile_options(${NAME} PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic)
  add_test(NAME ${NAME} COMMAND ${NAME})
endfunction()

iterate_kit_add_havpe_pure_test(
  iterate-kit-havpe-hardware-config-test
  havpe_hardware_config_test.c
  ../devices/havpe/voice_pe_hardware_config.c)

iterate_kit_add_havpe_pure_test(
  iterate-kit-havpe-hardware-config-aec-override-test
  havpe_hardware_config_aec_override_test.c
  ../devices/havpe/voice_pe_hardware_config.c)
target_compile_definitions(
  iterate-kit-havpe-hardware-config-aec-override-test PRIVATE
  ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE=1)

iterate_kit_add_havpe_pure_test(
  iterate-kit-havpe-pcm-format-test
  havpe_pcm_format_test.c
  ../devices/havpe/voice_pe_pcm_format.c)

# The dial and the button: mode table (a wire contract with four provisioned
# streams), the polled quadrature decoder, the spin-then-settle wheel policy,
# and the wake/converse/idle session grammar.
iterate_kit_add_havpe_pure_test(
  iterate-kit-havpe-modes-test
  havpe_modes_test.c
  ../devices/havpe/havpe_modes.c)

# StackChan's menu and side button: the two-stream mode table (a wire
# contract like the HAVPE's), the face-tap provider menu, and the same
# wake/converse/idle session grammar with its single end-chime edge.
function(iterate_kit_add_stackchan_pure_test NAME)
  add_executable(${NAME} ${ARGN})
  target_include_directories(${NAME} PRIVATE
    ../devices/stackchan
    ../components/core/include)
  target_compile_features(${NAME} PRIVATE c_std_99)
  target_compile_options(${NAME} PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic)
  add_test(NAME ${NAME} COMMAND ${NAME})
endfunction()

iterate_kit_add_stackchan_pure_test(
  iterate-kit-stackchan-modes-test
  stackchan_modes_test.c
  ../devices/stackchan/stackchan_modes.c)

# StackChan's adopted pure DSP primitives (components/audio): the AEC cadence
# bridge, reference scaler, uplink selector, and near high-pass, each with the
# donor's host tests. They link the audio component, not core.
function(iterate_kit_add_audio_test NAME SOURCE)
  add_executable(${NAME} ${SOURCE})
  target_compile_features(${NAME} PRIVATE c_std_99)
  target_compile_options(${NAME} PRIVATE
    -UNDEBUG
    -Wall
    -Wextra
    -Werror
    -Wpedantic)
  target_link_libraries(${NAME} PRIVATE iterate-kit-audio)
  add_test(NAME ${NAME} COMMAND ${NAME})
endfunction()

iterate_kit_add_audio_test(
  iterate-kit-aec-capture-bridge-test aec_capture_bridge_test.c)
iterate_kit_add_audio_test(
  iterate-kit-aec-uplink-selector-test aec_uplink_selector_test.c)
iterate_kit_add_audio_test(
  iterate-kit-aec-reference-scaler-test aec_reference_scaler_test.c)
iterate_kit_add_audio_test(
  iterate-kit-pcm-high-pass-test pcm_high_pass_test.c)

# The capture reserve is StackChan's ISR-side raw ring; pure C outside
# ESP_PLATFORM, built from the device sources like the HAVPE modules.
add_executable(
  iterate-kit-core-s3-capture-reserve-test
  core_s3_capture_reserve_test.c
  ../devices/stackchan/core_s3_capture_reserve.c)
target_include_directories(iterate-kit-core-s3-capture-reserve-test PRIVATE
  ../devices/stackchan
  ../components/core/include)
target_compile_features(
  iterate-kit-core-s3-capture-reserve-test PRIVATE c_std_99)
target_compile_options(iterate-kit-core-s3-capture-reserve-test PRIVATE
  -UNDEBUG
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
add_test(
  NAME iterate-kit-core-s3-capture-reserve-test
  COMMAND iterate-kit-core-s3-capture-reserve-test)
