if(NOT DEFINED ITERATE_KIT_FIRMWARE_ROOT)
  message(FATAL_ERROR "ITERATE_KIT_FIRMWARE_ROOT is required")
endif()

file(
  GLOB_RECURSE ITERATE_KIT_CORE_FILES
  LIST_DIRECTORIES false
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core/*.c"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core/*.cc"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core/*.cpp"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core/*.cxx"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core/*.h"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core/*.hh"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core/*.hpp"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/core/*.inc")

# Build the bare-name deny-list from the platform tree itself. Platform headers
# normally arrive as iterate/kit/platforms/<name>.h, but a future include-path
# mistake must not make `#include "<name>.h"` an escape hatch.
file(
  GLOB_RECURSE ITERATE_KIT_PLATFORM_HEADERS
  LIST_DIRECTORIES false
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/*.h"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/*.hh"
  "${ITERATE_KIT_FIRMWARE_ROOT}/platforms/*.hpp")
set(ITERATE_KIT_PLATFORM_HEADER_NAMES "")
foreach(ITERATE_KIT_PLATFORM_HEADER IN LISTS ITERATE_KIT_PLATFORM_HEADERS)
  get_filename_component(
    ITERATE_KIT_PLATFORM_HEADER_NAME "${ITERATE_KIT_PLATFORM_HEADER}" NAME)
  string(REPLACE "." "\\."
    ITERATE_KIT_PLATFORM_HEADER_NAME "${ITERATE_KIT_PLATFORM_HEADER_NAME}")
  list(APPEND ITERATE_KIT_PLATFORM_HEADER_NAMES
    "${ITERATE_KIT_PLATFORM_HEADER_NAME}")
endforeach()
list(JOIN ITERATE_KIT_PLATFORM_HEADER_NAMES "|"
  ITERATE_KIT_PLATFORM_HEADER_PATTERN)

# This is a second line of defence, not the seam itself. Platform-private
# headers must also stay out of the core target's include paths so a bypass does
# not compile. The source check makes the intended dependency direction visible
# in a fast host test instead of waiting for a particular board build.
set(ITERATE_KIT_FORBIDDEN_INCLUDE
    "^[ \t]*#[ \t]*include[ \t]*[<\"][^>\"]*(audio\\.h|audio_codec\\.h|audio_processor\\.h|components/audio|iterate/kit/audio/|\\.\\./audio|platforms/|iterate/kit/platforms|\\.\\./platforms|${ITERATE_KIT_PLATFORM_HEADER_PATTERN})[^>\"]*[>\"]")

foreach(ITERATE_KIT_CORE_FILE IN LISTS ITERATE_KIT_CORE_FILES)
  file(STRINGS "${ITERATE_KIT_CORE_FILE}" ITERATE_KIT_BOUNDARY_VIOLATIONS
       REGEX "${ITERATE_KIT_FORBIDDEN_INCLUDE}")
  if(ITERATE_KIT_BOUNDARY_VIOLATIONS)
    message(
      FATAL_ERROR
        "components/core must not include audio or platform headers: ${ITERATE_KIT_CORE_FILE}\n${ITERATE_KIT_BOUNDARY_VIOLATIONS}")
  endif()
endforeach()
