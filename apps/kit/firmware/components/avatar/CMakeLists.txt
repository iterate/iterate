idf_component_register(
  SRCS
    "src/face_animator.c"
    "src/face_avatar_registry.c"
    "src/face_doze.c"
    "src/face_driver.c"
    "src/face_keyframe.c"
    "src/face_performance.c"
    "src/face_scale.c"
    "src/face_sprite_sheet.c"
    "src/face_stage.c"
    "src/face_viseme_queue.c"
    "src/fspp_dot_matrix_oracle_cores3_fine_atlas.c"
    "src/fspp_furnace_imp_cores3_fine_atlas.c"
    "src/fspp_karakuri_brass_cores3_fine_atlas.c"
    "src/fspp_moonscope_cores3_fine_atlas.c"
    "src/fspp_starbyte_cores3_fine_atlas.c"
  INCLUDE_DIRS "include"
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
