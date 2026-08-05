# Audio is a separate link unit so targets without audio never acquire its
# implementations, platform frameworks, or transitive dependencies. The
# portable module contains only the two seams and the fail-closed passthrough
# processor; concrete codec drivers remain in platform modules.
set(ITERATE_KIT_AUDIO_SOURCES
  src/audio_codec.c
  src/audio_processor.c)

if(COMMAND idf_component_register)
  idf_component_register(
    SRCS ${ITERATE_KIT_AUDIO_SOURCES}
    INCLUDE_DIRS include
    REQUIRES core)
  set(ITERATE_KIT_AUDIO_TARGET ${COMPONENT_LIB})
else()
  add_library(iterate-kit-audio STATIC ${ITERATE_KIT_AUDIO_SOURCES})
  target_include_directories(iterate-kit-audio PUBLIC include)
  target_link_libraries(iterate-kit-audio PUBLIC iterate-kit-core)
  set(ITERATE_KIT_AUDIO_TARGET iterate-kit-audio)
endif()

target_compile_features(${ITERATE_KIT_AUDIO_TARGET} PUBLIC c_std_11)
target_compile_options(${ITERATE_KIT_AUDIO_TARGET} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
