set(ITERATE_KIT_CORE_SOURCES
  src/audio_playout.c
  src/barge_in.c
  src/configuration.c
  src/conversation_lights.c
  src/conversation_overlay.c
  src/device_events.c
  src/face_wake.c
  src/itx_connection.c
  src/mount_watchdog.c
  src/itx_mount.c
  src/itx_outbox_sender.c
  src/peer.c
  src/retry_gate.c
  src/spsc_ring.c
  src/talk_button.c
  src/touch_tap.c
  src/voice_playback_clock.c
  src/voicelab_stream.c
  src/websocket_frame_reader.c
  src/websocket_frame_writer.c
  src/websocket_rx.c
  src/websocket_text.c
  src/websocket_tx.c)

if(COMMAND idf_component_register)
  idf_component_register(
    SRCS ${ITERATE_KIT_CORE_SOURCES}
    INCLUDE_DIRS include
    REQUIRES capnweb)
  set(ITERATE_KIT_CORE_TARGET ${COMPONENT_LIB})
else()
  add_library(iterate-kit-core STATIC ${ITERATE_KIT_CORE_SOURCES})
  target_include_directories(iterate-kit-core PUBLIC include)
  target_link_libraries(iterate-kit-core PUBLIC capnweb)
  set(ITERATE_KIT_CORE_TARGET iterate-kit-core)
endif()

target_compile_features(${ITERATE_KIT_CORE_TARGET} PUBLIC c_std_99)
target_compile_options(${ITERATE_KIT_CORE_TARGET} PRIVATE
  -Wall
  -Wextra
  -Werror
  -Wpedantic)
