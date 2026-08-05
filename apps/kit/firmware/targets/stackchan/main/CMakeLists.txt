idf_component_register(SRCS main.c REQUIRES stackchan)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
