add_library(iterate-kit-core STATIC
  src/audio_playout.c
  src/configuration.c
  src/device_events.c
  src/itx_connection.c
  src/itx_mount.c
  src/itx_outbox_sender.c
  src/peer.c
  src/retry_gate.c
  src/spsc_ring.c
  src/talk_button.c
  src/voice_playback_clock.c
  src/voicelab_stream.c
  src/websocket_frame_reader.c
  src/websocket_frame_writer.c
  src/websocket_rx.c
  src/websocket_text.c
  src/websocket_tx.c)

target_include_directories(iterate-kit-core PUBLIC include)
target_compile_features(iterate-kit-core PUBLIC c_std_99)
target_compile_options(iterate-kit-core PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
target_link_libraries(iterate-kit-core PUBLIC capnweb)
