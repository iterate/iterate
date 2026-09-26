# Generate the reviewed press chime (and the board's speech level) in the component build directory.
# Inputs are committed WAVs; this rule never contacts a service or needs a secret.
get_filename_component(ITERATE_KIT_BAKED_SOUNDS_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)

function(iterate_kit_add_baked_sounds)
  cmake_parse_arguments(SOUNDS "TRIM_WAKE" "GAIN" "" ${ARGN})
  if(SOUNDS_UNPARSED_ARGUMENTS)
    message(FATAL_ERROR "Unexpected baked-sound arguments: ${SOUNDS_UNPARSED_ARGUMENTS}")
  endif()

  set(sound_directory "${CMAKE_CURRENT_BINARY_DIR}/generated-sounds")
  set(sound_include "${sound_directory}/sounds_generated.inc")
  set(sound_arguments)
  if(SOUNDS_TRIM_WAKE)
    list(APPEND sound_arguments --trim-wake)
  endif()
  if(SOUNDS_GAIN)
    list(APPEND sound_arguments --gain "${SOUNDS_GAIN}")
  endif()

  add_custom_command(
    OUTPUT "${sound_include}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${sound_directory}"
    COMMAND "${PYTHON}" "${ITERATE_KIT_BAKED_SOUNDS_ROOT}/tools/make-sounds.py"
      --output "${sound_include}"
      "${ITERATE_KIT_BAKED_SOUNDS_ROOT}/assets/sounds"
      chime_press=center_button_press.wav
      ${sound_arguments}
    DEPENDS
      "${ITERATE_KIT_BAKED_SOUNDS_ROOT}/tools/make-sounds.py"
      "${ITERATE_KIT_BAKED_SOUNDS_ROOT}/assets/sounds/center_button_press.wav"
    VERBATIM)
  add_custom_target("${COMPONENT_LIB}_baked_sounds" DEPENDS "${sound_include}")
  add_dependencies("${COMPONENT_LIB}" "${COMPONENT_LIB}_baked_sounds")
  target_include_directories("${COMPONENT_LIB}" PRIVATE "${sound_directory}")
endfunction()
