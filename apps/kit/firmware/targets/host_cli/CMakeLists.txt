add_executable(iterate-kit-cli
  cli_capabilities.c
  cli_conversation.c
  cli_device_controls.c
  cli_delivery_fault.c
  cli_device_profile.c
  cli_fault_schedule.c
  cli_keyboard.c
  cli_microphone.c
  cli_options.c
  cli_paced_sink.c
  cli_report.c
  cli_speaker.c
  cli_virtual_clock.c
  cli_wav.c
  main.c)

# The voicelab launcher has always found the rig at <build>/iterate-kit-cli.
# Keep that stable while the sources themselves live in this target module.
set_target_properties(iterate-kit-cli PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

target_include_directories(iterate-kit-cli PRIVATE .)
target_compile_features(iterate-kit-cli PRIVATE c_std_11)
target_compile_options(iterate-kit-cli PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
  -Wconversion
  -Wshadow)
target_link_libraries(iterate-kit-cli PRIVATE
  iterate-kit-capabilities
  iterate-kit-darwin)
