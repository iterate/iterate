idf_component_register(SRCS main.c REQUIRES m5sticks3)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
