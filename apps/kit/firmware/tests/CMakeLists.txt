set(ITERATE_KIT_BOUNDARY_CHECK
    "${CMAKE_CURRENT_SOURCE_DIR}/verify_core_boundary.cmake")

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
