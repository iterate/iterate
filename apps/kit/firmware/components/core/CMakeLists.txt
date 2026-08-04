# Phase 0 deliberately has no implementation. The interface target gives later
# phases a stable dependency name without inventing placeholder source files.
add_library(iterate-kit-core INTERFACE)
target_compile_features(iterate-kit-core INTERFACE c_std_11)
