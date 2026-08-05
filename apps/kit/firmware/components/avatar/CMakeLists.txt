set(ITERATE_KIT_AVATAR_SOURCES
  src/face_animator.c
  src/face_avatar_registry.c
  src/face_doze.c
  src/face_driver.c
  src/face_keyframe.c
  src/face_performance.c
  src/face_scale.c
  src/face_sprite_sheet.c
  src/face_stage.c
  src/face_viseme_queue.c
  src/fspp_dot_matrix_oracle_cores3_fine_atlas.c
  src/fspp_furnace_imp_cores3_fine_atlas.c
  src/fspp_karakuri_brass_cores3_fine_atlas.c
  src/fspp_moonscope_cores3_fine_atlas.c
  src/fspp_starbyte_cores3_fine_atlas.c)

if(COMMAND idf_component_register)
  idf_component_register(
    SRCS ${ITERATE_KIT_AVATAR_SOURCES}
    INCLUDE_DIRS include)
  set(ITERATE_KIT_AVATAR_TARGET ${COMPONENT_LIB})
else()
  add_library(iterate-kit-avatar STATIC ${ITERATE_KIT_AVATAR_SOURCES})
  target_include_directories(iterate-kit-avatar PUBLIC include)
  set(ITERATE_KIT_AVATAR_TARGET iterate-kit-avatar)
endif()

target_compile_features(${ITERATE_KIT_AVATAR_TARGET} PUBLIC c_std_99)
target_compile_options(${ITERATE_KIT_AVATAR_TARGET} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
