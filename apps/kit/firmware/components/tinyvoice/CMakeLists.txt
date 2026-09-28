# The board's own small speech synthesizer (include/iterate/kit/tinyvoice.h).
# Portable C and libm only, so the ESP targets, the Mac and the host tests all
# build the same file.
if(COMMAND idf_component_register)
  idf_component_register(
    SRCS src/tinyvoice.c
    INCLUDE_DIRS include)
  set(ITERATE_KIT_TINYVOICE_TARGET ${COMPONENT_LIB})
else()
  add_library(iterate-kit-tinyvoice STATIC src/tinyvoice.c)
  target_include_directories(iterate-kit-tinyvoice PUBLIC include)
  find_library(ITERATE_KIT_LIBM m)
  if(ITERATE_KIT_LIBM)
    target_link_libraries(iterate-kit-tinyvoice PUBLIC ${ITERATE_KIT_LIBM})
  endif()
  set(ITERATE_KIT_TINYVOICE_TARGET iterate-kit-tinyvoice)
endif()

target_compile_features(${ITERATE_KIT_TINYVOICE_TARGET} PUBLIC c_std_11)
target_compile_options(${ITERATE_KIT_TINYVOICE_TARGET} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
