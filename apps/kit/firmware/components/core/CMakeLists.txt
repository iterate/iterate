idf_component_register(
  SRCS
    "src/aec_capture_bridge.c"
    "src/audio_intent_reconciler.c"
    "src/audio.c"
    "src/configuration.c"
    "src/cpu_usage.c"
    "src/device_events.c"
    "src/itx_connection.c"
    "src/itx_mount.c"
    "src/pcm_clock_playback.c"
    "src/pcm_capture_turn.c"
    "src/pcm_generation_fence.c"
    "src/pcm_lane.c"
    "src/pcm_playback_interruption.c"
    "src/pcm_uplink_conductor.c"
    "src/pcm_uplink_sender.c"
    "src/pcm_websocket.c"
    "src/peer.c"
    "src/retry_gate.c"
    "src/runtime_diagnostics.c"
    "src/spsc_ring.c"
    "src/voicelab_stream.c"
    "src/websocket_frame_writer.c"
    "src/websocket_rx.c"
    "src/websocket_tx.c"
    "src/websocket_text.c"
  INCLUDE_DIRS "include"
  REQUIRES capnweb
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic
)
