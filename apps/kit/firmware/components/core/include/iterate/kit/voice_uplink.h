#ifndef ITERATE_KIT_VOICE_UPLINK_H
#define ITERATE_KIT_VOICE_UPLINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voicelab_stream.h"

/* Zero-initialize before use; queued/read/clear/notify callbacks are required.
 * Single-owner microphone/turn controller shared by the CLI and ESP app task.
 * Capture and transport scheduling belong to the platform. This owns admission,
 * turn markers, batching, the release snapshot, and bounded backpressure.
 * Publish capturing()/buffering to a capture thread through platform atomics;
 * never read this mutable object concurrently with step(). */
enum iterate_kit_voice_uplink_state {
  ITERATE_KIT_UPLINK_IDLE,
  ITERATE_KIT_UPLINK_BUFFERING,
  ITERATE_KIT_UPLINK_TALKING,
  ITERATE_KIT_UPLINK_FLUSHING,
  ITERATE_KIT_UPLINK_FAILED,
};

enum iterate_kit_voice_uplink_event {
  ITERATE_KIT_UPLINK_STARTED,
  ITERATE_KIT_UPLINK_RELEASED,
  ITERATE_KIT_UPLINK_COMMITTED,
  ITERATE_KIT_UPLINK_STOPPED,
  ITERATE_KIT_UPLINK_TURN_LIMIT,
  ITERATE_KIT_UPLINK_TAIL_DROPPED,
  ITERATE_KIT_UPLINK_PUBLICATION_FAILED,
  ITERATE_KIT_UPLINK_BACKPRESSURE_FAILED,
};

struct iterate_kit_voice_uplink_io {
  void *context;
  size_t (*queued)(void *context);
  bool (*read)(void *context, uint8_t *frame);
  void (*clear)(void *context);
  /* Optional source preparation, once per new press (e.g. rewind a WAV). */
  bool (*prepare)(void *context);
  void (*notify)(void *context, enum iterate_kit_voice_uplink_event event,
                 enum capnweb_status status);
};

struct iterate_kit_voice_uplink_input {
  uint64_t now_ms;
  size_t outbox_free;
  bool wants_talk;
  /* Caller decides admission: stream readiness, plus call acceptance on ESP. */
  bool ready;
  bool marks_turns;
  bool source_finished;
};

struct iterate_kit_voice_uplink {
  enum iterate_kit_voice_uplink_state state;
  bool marks_turns;
  bool released;
  bool blocked_until_release;
  uint32_t frame_sequence;
  size_t flush_frames_left;
  uint64_t turn_started_ms;
  uint64_t flush_deadline_ms;
  uint64_t drain_at_ms;
  uint64_t jammed_since_ms;
  uint32_t frames_dropped;
  uint32_t marker_failures;
  uint32_t send_failures;
  uint32_t backpressure_failures;
  uint8_t frames[ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND]
                [ITERATE_KIT_VOICE_FRAME_BYTES];
};

bool iterate_kit_voice_uplink_capturing(const struct iterate_kit_voice_uplink *uplink);
bool iterate_kit_voice_uplink_active(const struct iterate_kit_voice_uplink *uplink);
/* Cancel on session/call loss or replacement; cumulative diagnostics survive. */
void iterate_kit_voice_uplink_reset(struct iterate_kit_voice_uplink *uplink,
                                  const struct iterate_kit_voice_uplink_io *io);
void iterate_kit_voice_uplink_step(struct iterate_kit_voice_uplink *uplink,
                                 struct iterate_kit_voicelab *voicelab,
                                 const struct iterate_kit_voice_uplink_io *io,
                                 const struct iterate_kit_voice_uplink_input *input);

#endif
