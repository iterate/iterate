add_library(iterate-kit-capabilities STATIC
  src/push_to_talk.c
  src/rpc_internal.c)

target_include_directories(iterate-kit-capabilities PUBLIC include)
target_include_directories(iterate-kit-capabilities PRIVATE src)
target_compile_features(iterate-kit-capabilities PUBLIC c_std_99)
target_compile_options(iterate-kit-capabilities PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-capabilities PUBLIC iterate-kit-core)
