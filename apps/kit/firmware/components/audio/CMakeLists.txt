# Audio is a separate link unit so targets without audio never acquire its
# headers, implementations, platform frameworks, or transitive dependencies.
add_library(iterate-kit-audio INTERFACE)
target_compile_features(iterate-kit-audio INTERFACE c_std_11)
