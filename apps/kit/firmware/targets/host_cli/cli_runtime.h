#ifndef ITERATE_KIT_CLI_RUNTIME_H
#define ITERATE_KIT_CLI_RUNTIME_H

/*
 * cli_runtime: private storage shared by the macOS target's C modules.
 *
 * One cooperative thread owns every mutable field except CoreAudio's busy
 * callbacks and the signal flag in main. The large arrays are intentional:
 * they mirror the device profile and make every protocol, audio, utterance,
 * and report bound visible in one assembly object.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"
#include "cli_audio_out.h"
#include "cli_capabilities.h"
#include "cli_conversation.h"
#include "cli_microphone.h"
#include "cli_options.h"
#include "cli_speaker.h"
#include "cli_wav.h"
#include "iterate/kit/audio_playout.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/posix_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voice_playback_clock.h"
#include "iterate/kit/voicelab_stream.h"

struct cli_runtime {
  struct cli_options options;
  char **argv;
  struct iterate_kit_configuration configuration;
  struct iterate_kit_itx_connection connection;
  struct capnweb_pending_call
      pending_calls[ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY];
  struct capnweb_export exports[ITERATE_KIT_VOICE_EXPORT_CAPACITY];
  struct capnweb_import imports[ITERATE_KIT_VOICE_IMPORT_CAPACITY];
  struct capnweb_json_token tokens[ITERATE_KIT_VOICE_TOKEN_CAPACITY];
  char output[ITERATE_KIT_VOICE_OUTPUT_CAPACITY];
  struct iterate_kit_spsc_ring control_inbox;
  struct iterate_kit_spsc_ring control_outbox;
  uint8_t inbox_storage[ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS]
                         [ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY];
  uint8_t outbox_storage[ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS]
                          [ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY];
  size_t inbox_lengths[ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS];
  size_t outbox_lengths[ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS];
  struct iterate_kit_posix_itx_transport transport;
  struct iterate_kit_peer peer;
  struct iterate_kit_module module;
  struct cli_capabilities capabilities;
  struct iterate_kit_voicelab voicelab;
  uint32_t voicelab_generation;
  /* The connection borrows this array until process shutdown. */
  const char *mount_path[2];
  enum iterate_kit_posix_itx_transport_state announced_transport;
  enum iterate_kit_voicelab_state announced_voicelab;
  enum iterate_kit_voicelab_failure announced_failure;
  uint32_t frame_sequence;
  struct cli_microphone microphone;
  struct cli_speaker speaker;
  struct iterate_kit_playout playout;
  struct iterate_kit_voice_playback_clock playback_clock;
  struct cli_wav_source source;
  struct cli_wav_sink sink;
  struct cli_audio_out live_out;
  struct cli_conversation conversation;
  bool wants_call;
  bool wants_talk;
  bool talking;
  bool flushing_turn;
  bool answer_done;
  bool restart_requested;
  uint64_t restart_requested_at_ms;
  bool stop_requested;
  bool source_finished;
  uint32_t flush_frames_left;
  uint64_t flush_deadline_ms;
  uint64_t turn_started_ms;
  uint64_t next_mic_at_ms;
  uint64_t next_playback_at_ms;
  uint64_t next_stats_at_ms;
  uint64_t next_ping_at_ms;
  uint64_t next_call_attempt_at_ms;
  uint64_t call_pending_since_ms;
  uint64_t unhealthy_since_ms;
  uint64_t last_liveness_ms;
  uint64_t next_liveness_restart_at_ms;
  uint64_t last_pulse_ms;
  uint64_t started_ms;
  uint32_t last_ping_count;
  uint32_t downlink_recycles_running;
  uint32_t stats_sequence;
  uint32_t loop_count;
  uint32_t mic_frames_captured;
  uint32_t mic_frames_dropped;
  uint32_t mic_frames_gated;
  uint32_t speaker_frames_played;
  uint32_t speaker_overflow_drops;
  uint32_t speaker_underruns;
  uint32_t speaker_conceal_frames;
  uint32_t speaker_catchup_frames;
  uint32_t speaker_debt_paid;
  uint32_t speaker_write_failures;
  uint32_t speaker_margin_min_ms;
  uint32_t speaker_margin_max_ms;
  uint32_t speaker_writes;
  uint32_t speaker_bad_frames;
  uint32_t barge_in_flushes;
  uint32_t liveness_restarts;
  uint32_t session_restarts;
  uint32_t bridge_losses;
  uint32_t downlink_recycles;
  uint32_t transport_restarts;
  uint32_t calls_lost;
  bool mounted_once;
};

/** Monotonic milliseconds used by the runtime and voicelab callbacks. */
uint64_t cli_runtime_now_ms(void *context);

/** Emit one timestamped diagnostic line. The caller chooses its severity. */
void cli_runtime_log(const char *level, const char *format, ...);

#endif /* ITERATE_KIT_CLI_RUNTIME_H */
