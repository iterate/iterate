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

# The voice loop is one program every board runs, so nothing in it may name a
# board. Enforced here rather than by a build failure on one target, because
# `devices/**` is not in the host CMake build at all: without this check, a
# `waveshare_`/`havpe_`/`m5sticks3_`/`stackchan_` symbol creeping back into the
# shared loop would compile happily on the board it belongs to and break the
# other three, and nobody would find out until a flash.
file(
  GLOB_RECURSE ITERATE_KIT_VOICE_FILES
  LIST_DIRECTORIES false
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/voice/*.c"
  "${ITERATE_KIT_FIRMWARE_ROOT}/components/voice/*.h")

# Build the board-name list from the device tree itself, so a board added later
# is covered without anyone remembering to come back here.
file(
  GLOB ITERATE_KIT_DEVICE_DIRS
  LIST_DIRECTORIES true
  "${ITERATE_KIT_FIRMWARE_ROOT}/devices/*")
set(ITERATE_KIT_DEVICE_NAMES "")
foreach(ITERATE_KIT_DEVICE_DIR IN LISTS ITERATE_KIT_DEVICE_DIRS)
  if(IS_DIRECTORY "${ITERATE_KIT_DEVICE_DIR}")
    get_filename_component(
      ITERATE_KIT_DEVICE_NAME "${ITERATE_KIT_DEVICE_DIR}" NAME)
    list(APPEND ITERATE_KIT_DEVICE_NAMES "${ITERATE_KIT_DEVICE_NAME}")
  endif()
endforeach()
# The directory name is not always the symbol prefix, so cover both.
list(APPEND ITERATE_KIT_DEVICE_NAMES waveshare m5stick)
list(REMOVE_DUPLICATES ITERATE_KIT_DEVICE_NAMES)

foreach(ITERATE_KIT_VOICE_FILE IN LISTS ITERATE_KIT_VOICE_FILES)
  file(READ "${ITERATE_KIT_VOICE_FILE}" ITERATE_KIT_VOICE_TEXT)
  foreach(ITERATE_KIT_DEVICE_NAME IN LISTS ITERATE_KIT_DEVICE_NAMES)
    string(TOUPPER "${ITERATE_KIT_DEVICE_NAME}" ITERATE_KIT_DEVICE_UPPER)
    # `<board>_` as an identifier prefix, in either case. Prose mentioning a
    # board by name is fine and often the whole point of a comment; a SYMBOL is
    # not, and the trailing underscore is what tells them apart.
    if(ITERATE_KIT_VOICE_TEXT MATCHES "[^A-Za-z0-9_](${ITERATE_KIT_DEVICE_NAME}_|${ITERATE_KIT_DEVICE_UPPER}_)[A-Za-z0-9_]*[ \t]*\\(")
      message(
        FATAL_ERROR
          "components/voice must not name a board: ${ITERATE_KIT_VOICE_FILE} references ${ITERATE_KIT_DEVICE_NAME}_*")
    endif()
    if(ITERATE_KIT_VOICE_TEXT MATCHES "#[ \t]*include[ \t]*[<\"][^>\"]*(devices/|${ITERATE_KIT_DEVICE_NAME}_)")
      message(
        FATAL_ERROR
          "components/voice must not include a device header: ${ITERATE_KIT_VOICE_FILE}")
    endif()
  endforeach()
endforeach()
