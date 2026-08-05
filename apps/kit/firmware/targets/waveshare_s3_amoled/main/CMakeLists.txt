idf_component_register(SRCS main.c REQUIRES waveshare_s3_amoled)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
