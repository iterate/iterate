# The Mac as a board: the shared voice loop (components/voice), compiled against
# the darwin platform, with CoreAudio providing audio and the
# keyboard as the button. `iterate-kit-mac --config <image>` is a device.
add_executable(iterate-kit-mac
  ../../devices/mac/mac_device.c
  ../../devices/mac/keyboard.c)
target_compile_features(iterate-kit-mac PRIVATE c_std_11)
target_compile_options(iterate-kit-mac PRIVATE
  -Wall -Wextra -Werror -Wpedantic -Wconversion -Wshadow)
target_link_libraries(iterate-kit-mac PRIVATE
  iterate-kit-voice-mac
  iterate-kit-darwin
  iterate-kit-capabilities
  iterate-kit-host-esp-idf)
set_target_properties(iterate-kit-mac PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
