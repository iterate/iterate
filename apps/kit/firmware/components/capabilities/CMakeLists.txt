set(ITERATE_KIT_CAPABILITIES_SOURCES
  src/push_to_talk.c
  src/conversation.c
  src/servos.c
  src/health.c
  src/camera.c
  src/rpc_internal.c)

if(COMMAND idf_component_register)
  idf_component_register(
    SRCS ${ITERATE_KIT_CAPABILITIES_SOURCES}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS src
    REQUIRES core)
  set(ITERATE_KIT_CAPABILITIES_TARGET ${COMPONENT_LIB})
else()
  add_library(
    iterate-kit-capabilities STATIC ${ITERATE_KIT_CAPABILITIES_SOURCES})
  target_include_directories(iterate-kit-capabilities PUBLIC include)
  target_include_directories(iterate-kit-capabilities PRIVATE src)
  target_link_libraries(iterate-kit-capabilities PUBLIC iterate-kit-core)
  set(ITERATE_KIT_CAPABILITIES_TARGET iterate-kit-capabilities)
endif()

target_compile_features(${ITERATE_KIT_CAPABILITIES_TARGET} PUBLIC c_std_99)
target_compile_options(${ITERATE_KIT_CAPABILITIES_TARGET} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
