# Only opt-in targets add this component. The board owns the public header;
# esp-sr never becomes a dependency of boards that only use the shared codec.
idf_component_register(
  SRCS ../board/wake_word.c
  PRIV_REQUIRES board espressif__esp-sr esp_timer capabilities)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
