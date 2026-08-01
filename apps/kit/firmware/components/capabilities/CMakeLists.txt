idf_component_register(
  SRCS
    "src/callback_budget.c"
    "src/conversation.c"
    "src/camera.c"
    "src/device_event_stream.c"
    "src/leds.c"
    "src/metrics.c"
    "src/push_to_talk.c"
    "src/rpc_internal.c"
    "src/screen.c"
    "src/screen_capture.c"
    "src/servos.c"
  INCLUDE_DIRS "include"
  PRIV_INCLUDE_DIRS "src"
  REQUIRES core
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
