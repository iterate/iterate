set(CAPNWEB_C_SOURCE_DIR
  "${CMAKE_CURRENT_LIST_DIR}/../../vendor/capnweb")
if(NOT EXISTS "${CAPNWEB_C_SOURCE_DIR}/include/capnweb/capnweb.h")
  message(FATAL_ERROR
    "The vendored Cap'n Web C source is missing")
endif()

idf_component_register(
  SRCS
    "${CAPNWEB_C_SOURCE_DIR}/src/call.c"
    "${CAPNWEB_C_SOURCE_DIR}/src/expression.c"
    "${CAPNWEB_C_SOURCE_DIR}/src/json.c"
    "${CAPNWEB_C_SOURCE_DIR}/src/reply.c"
    "${CAPNWEB_C_SOURCE_DIR}/src/responder.c"
    "${CAPNWEB_C_SOURCE_DIR}/src/session.c"
    "${CAPNWEB_C_SOURCE_DIR}/src/value.c"
    "${CAPNWEB_C_SOURCE_DIR}/src/writer.c"
  INCLUDE_DIRS "${CAPNWEB_C_SOURCE_DIR}/include"
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
