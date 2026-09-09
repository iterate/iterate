idf_component_register(SRCS main.c REQUIRES satellite1)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
