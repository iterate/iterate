# Audio is a separate link unit so targets without audio never acquire its
# implementations, platform frameworks, or transitive dependencies. The
# portable module contains only the two seams and the fail-closed passthrough
# processor; concrete codec drivers remain in platform modules.
add_library(iterate-kit-audio STATIC
  src/audio_codec.c
  src/audio_processor.c)

target_include_directories(iterate-kit-audio PUBLIC include)
target_compile_features(iterate-kit-audio PUBLIC c_std_11)
target_compile_options(iterate-kit-audio PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-audio PUBLIC iterate-kit-core)
