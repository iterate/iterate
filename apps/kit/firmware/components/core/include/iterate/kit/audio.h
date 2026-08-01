#ifndef ITERATE_KIT_AUDIO_H
#define ITERATE_KIT_AUDIO_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_audio_mode {
  ITERATE_KIT_AUDIO_NONE = -1,
  ITERATE_KIT_AUDIO_PUSH_TO_TALK = 0,
  ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC,
};

enum iterate_kit_audio_event {
  ITERATE_KIT_AUDIO_INTERRUPTION = 0,
  ITERATE_KIT_AUDIO_CAPTURE_STARTED,
  ITERATE_KIT_AUDIO_CAPTURE_ENDED,
};

typedef void (*iterate_kit_audio_send_complete_fn)(
    void *context, enum iterate_kit_status status);

/**
 * Hardware operations are synchronous and must not retain any arguments.
 * A half-duplex adapter must make stop_playback() stop DMA immediately and
 * flush_playback() release every speaker buffer before start_capture().
 * prepare_playback() restores speaker ownership at an explicit conversation
 * boundary. Keeping that edge separate from flush avoids briefly restarting
 * the speaker while a push-to-talk press is about to claim the peripheral.
 */
struct iterate_kit_audio_hardware {
  void *context;
  enum iterate_kit_status (*start_capture)(void *context);
  enum iterate_kit_status (*stop_capture)(void *context);
  enum iterate_kit_status (*stop_playback)(void *context);
  enum iterate_kit_status (*flush_playback)(void *context);
  enum iterate_kit_status (*prepare_playback)(void *context);
};

/**
 * send_pcm() may borrow samples only until complete() is called. It must call
 * complete exactly once after returning ITERATE_KIT_OK, and must not call it
 * after returning any other status. The controller permits only one such
 * borrowed frame at a time.
 */
struct iterate_kit_audio_egress {
  void *context;
  enum iterate_kit_status (*send_event)(
      void *context, enum iterate_kit_audio_event event);
  enum iterate_kit_status (*send_pcm)(
      void *context,
      const int16_t *samples,
      size_t sample_count,
      uint32_t sample_rate_hz,
      iterate_kit_audio_send_complete_fn complete,
      void *complete_context);
};

typedef enum iterate_kit_status (*iterate_kit_audio_capture_submit_fn)(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz);

/**
 * Polls a platform recorder once. It may start an asynchronous hardware read
 * or submit one completed frame. The audio module does not call poll again
 * while egress owns that frame.
 */
struct iterate_kit_audio_capture_driver {
  void *context;
  enum iterate_kit_status (*poll)(
      void *context,
      iterate_kit_audio_capture_submit_fn submit,
      void *submit_context);
};

struct iterate_kit_audio_options {
  enum iterate_kit_audio_mode mode;
  struct iterate_kit_audio_hardware hardware;
  struct iterate_kit_audio_egress egress;
  struct iterate_kit_audio_capture_driver capture;
};

struct iterate_kit_audio_metrics {
  uint64_t capture_frames_sent;
  uint64_t capture_frames_dropped;
  uint64_t capture_send_failures;
  uint64_t event_send_failures;
  uint64_t completion_protocol_errors;
};

/**
 * Caller-owned state. The controller allocates no memory and stores no PCM.
 */
struct iterate_kit_audio_controller {
  struct iterate_kit_audio_options options;
  struct iterate_kit_audio_metrics metrics;
  enum iterate_kit_status last_status;
  bool initialized;
  bool capture_active;
  bool playback_active;
  bool playback_flush_pending;
  bool push_to_talk_active;
  bool capture_frame_in_flight;
};

enum iterate_kit_status iterate_kit_audio_controller_init(
    struct iterate_kit_audio_controller *controller,
    const struct iterate_kit_audio_options *options);

/**
 * Starts always-on capture for a full-duplex AEC profile. Push-to-talk
 * profiles remain idle until push_to_talk(..., true).
 */
enum iterate_kit_status iterate_kit_audio_start(
    struct iterate_kit_audio_controller *controller);

enum iterate_kit_status iterate_kit_audio_note_playback_started(
    struct iterate_kit_audio_controller *controller);

/**
 * Flushes hardware and bounded queued playback even if no frame has yet been
 * marked active. This is what prevents pre-speaker downlink from surviving a
 * push-to-talk interruption.
 */
enum iterate_kit_status iterate_kit_audio_interrupt_playback(
    struct iterate_kit_audio_controller *controller);

/**
 * Makes the hardware ready to consume the next downlink frame.
 *
 * A hang-up deliberately leaves a half-duplex speaker suspended after its
 * destructive flush. The next conversation must cross this explicit fence
 * before userspace is allowed to send an opening greeting; otherwise valid
 * PCM can be accepted by the transport and then discarded below it until the
 * first microphone cycle happens to restore speaker ownership.
 */
enum iterate_kit_status iterate_kit_audio_prepare_playback(
    struct iterate_kit_audio_controller *controller);

enum iterate_kit_status iterate_kit_audio_push_to_talk(
    struct iterate_kit_audio_controller *controller, bool active);

/**
 * Borrows samples only when ITERATE_KIT_OK is returned. While the prior frame
 * is in flight, this returns ITERATE_KIT_BACKPRESSURE, increments the drop
 * counter, and retains no pointer to the rejected frame.
 */
enum iterate_kit_status iterate_kit_audio_submit_capture(
    struct iterate_kit_audio_controller *controller,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz);

/**
 * Lifecycle-only module for the audio lane. It intentionally exposes no
 * Cap'n Web methods: audio control events use the capability/event lane and
 * PCM remains on a separate bounded WebSocket transport.
 */
struct iterate_kit_module iterate_kit_audio_module(
    struct iterate_kit_audio_controller *controller);

#ifdef __cplusplus
}
#endif

#endif
