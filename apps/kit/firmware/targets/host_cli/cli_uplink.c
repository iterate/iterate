/* macOS queue, source and reporting adapter for the shared uplink controller. */
#include "cli_uplink.h"
#include "cli_runtime.h"

static size_t queued(void *context) {
  const struct cli_runtime *runtime = context;
  return cli_microphone_queued(&runtime->microphone);
}

static bool read_frame(void *context, uint8_t *frame) {
  struct cli_runtime *runtime = context;
  return cli_microphone_pop(&runtime->microphone, frame,
                           ITERATE_KIT_VOICE_FRAME_BYTES) == CLI_MICROPHONE_OK;
}

static void clear(void *context) {
  struct cli_runtime *runtime = context;
  cli_microphone_clear(&runtime->microphone);
}

static bool prepare(void *context) {
  struct cli_runtime *runtime = context;
  if (runtime->conversation.state == CLI_CONVERSATION_DISABLED &&
      !runtime->options.live_mic) {
    if (cli_wav_source_open(&runtime->source, NULL) != CLI_WAV_OK) {
      cli_runtime_log("error", "cannot rewind the microphone source");
      runtime->stop_requested = true;
      return false;
    }
    runtime->source_finished = false;
  }
  return true;
}

static void notify(void *context, enum iterate_kit_voice_uplink_event event,
                   enum capnweb_status status) {
  struct cli_runtime *runtime = context;
  switch (event) {
    case ITERATE_KIT_UPLINK_STARTED:
      cli_speaker_clear(&runtime->speaker);
      iterate_kit_voice_playback_clock_reprime(&runtime->playout.clock);
      break;
    case ITERATE_KIT_UPLINK_RELEASED:
      runtime->turn_released_ms = cli_runtime_now_ms(NULL);
      runtime->turn_committed_ms = 0U;
      runtime->turn_answer_seen_ms = 0U;
      break;
    case ITERATE_KIT_UPLINK_COMMITTED:
      runtime->turn_committed_ms = cli_runtime_now_ms(NULL);
      break;
    case ITERATE_KIT_UPLINK_TURN_LIMIT:
      runtime->wants_talk = false;
      cli_runtime_log("warn", "turn reached its maximum duration");
      break;
    case ITERATE_KIT_UPLINK_TAIL_DROPPED:
      cli_runtime_log("warn", "microphone tail exceeded the flush deadline");
      break;
    case ITERATE_KIT_UPLINK_PUBLICATION_FAILED:
    case ITERATE_KIT_UPLINK_BACKPRESSURE_FAILED:
      cli_runtime_log("error", "voice uplink failed: event=%d capnweb=%d",
                      (int)event, (int)status);
      runtime->wants_talk = false;
      runtime->restart_requested = true;
      break;
    case ITERATE_KIT_UPLINK_STOPPED:
      break;
  }
}

static struct iterate_kit_voice_uplink_io io_for(struct cli_runtime *runtime) {
  return (struct iterate_kit_voice_uplink_io){
    .context = runtime, .queued = queued, .read = read_frame, .clear = clear,
    .prepare = prepare, .notify = notify,
  };
}

void cli_uplink_reset(struct cli_runtime *runtime) {
  const struct iterate_kit_voice_uplink_io io = io_for(runtime);
  const uint32_t dropped = runtime->uplink.frames_dropped;
  iterate_kit_voice_uplink_reset(&runtime->uplink, &io);
  runtime->mic_frames_dropped += runtime->uplink.frames_dropped - dropped;
}

void cli_uplink_step(struct cli_runtime *runtime, uint64_t now_ms) {
  const bool lost = runtime->transport.state == ITERATE_KIT_POSIX_ITX_FAILED ||
      runtime->transport.state == ITERATE_KIT_POSIX_ITX_STOPPED;
  if (lost) {
    cli_uplink_reset(runtime);
    return;
  }
  struct iterate_kit_spsc_ring_metrics outbox = {0};
  iterate_kit_spsc_ring_metrics(&runtime->control_outbox, &outbox);
  const struct iterate_kit_voice_uplink_input input = {
    .now_ms = now_ms,
    .outbox_free = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS - outbox.current_slots,
    .wants_talk = runtime->wants_talk,
    .ready = runtime->transport.state == ITERATE_KIT_POSIX_ITX_READY &&
        runtime->voicelab.state == ITERATE_KIT_VOICELAB_READY &&
        runtime->voicelab_generation == runtime->connection.generation,
    .marks_turns = !runtime->options.open_mic,
    .source_finished = runtime->source_finished,
  };
  const struct iterate_kit_voice_uplink_io io = io_for(runtime);
  const uint32_t dropped = runtime->uplink.frames_dropped;
  iterate_kit_voice_uplink_step(&runtime->uplink, &runtime->voicelab, &io, &input);
  runtime->mic_frames_dropped += runtime->uplink.frames_dropped - dropped;
}
