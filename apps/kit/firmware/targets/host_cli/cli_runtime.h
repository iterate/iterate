#ifndef ITERATE_KIT_CLI_RUNTIME_H
#define ITERATE_KIT_CLI_RUNTIME_H

/*
 * cli_runtime: private storage shared by the macOS target's C modules.
 *
 * One cooperative thread owns every mutable field except CoreAudio's busy
 * callbacks and the signal flag in main. The large arrays are intentional:
 * they mirror the device profile and make every protocol, audio, utterance,
 * and report bound visible in one assembly object.
 *
 * WHICH CLOCK EVERY `_ms` FIELD IS ON, once, so no field has to say it twice.
 *
 * Four clocks touch this system and none of them is synchronised with any
 * other — the client's, the facet's, the stream Durable Object's, and the
 * inference provider's. The taxonomy and the naming rule live in
 * `voice-agent2.ts`, which is where events are defined; on the wire they are
 * `...AtDeviceMs`, `...AtFacetMs`, `...AtStreamMs` and `...AtGrokMs`.
 *
 * IN HERE, THIS MACHINE IS THE DEVICE, and every bare `_ms` below is
 * `cli_runtime_now_ms()` — this process's own monotonic clock, and nothing
 * else. That is what makes an unqualified subtraction between any two of them
 * sound.
 *
 * So the rule for this struct is the inverse of the rule on the wire: a bare
 * `_ms` is OURS, and a stamp from anywhere else must name where it came from
 * (`..._at_facet_ms`, `..._at_stream_ms`, `..._at_grok_ms`) and may never be
 * subtracted from one of ours. There are currently NONE — this target reads no
 * foreign timestamp off any payload, and `turn-timing` is deliberately read by
 * the latency probes rather than by the client. Adding the first one is the
 * moment to re-read this paragraph, because a deadline compared against
 * somebody else's clock is what once muted every board in the building.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"
#include "cli_capabilities.h"
#include "cli_conversation.h"
#include "cli_device_controls.h"
#include "cli_keyboard.h"
#include "cli_microphone.h"
#include "cli_options.h"
#include "cli_paced_sink.h"
#include "cli_screen.h"
#include "cli_speaker.h"
#include "cli_delivery_fault.h"
#include "cli_device_profile.h"
#include "cli_fault_schedule.h"
#include "cli_virtual_clock.h"
#include "cli_wav.h"
#include "iterate/kit/audio_processor.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/darwin_audio_codec.h"
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
  struct iterate_kit_module modules[2];
  struct cli_capabilities capabilities;
  struct cli_device_controls device_controls;
  struct iterate_kit_voicelab voicelab;
  uint32_t voicelab_generation;
  /* The connection borrows this buffer until process shutdown. */
  char client_path[96];
  enum iterate_kit_posix_itx_transport_state announced_transport;
  enum iterate_kit_voicelab_state announced_voicelab;
  enum iterate_kit_voicelab_failure announced_failure;
  uint32_t frame_sequence;
  struct cli_microphone microphone;
  struct cli_speaker speaker;
  /* Loses, repeats and delays arriving frames per the schedule. */
  struct cli_delivery_fault delivery_fault;
  struct iterate_kit_voice_playback_clock playback_clock;
  struct cli_wav_source source;
  struct cli_wav_sink sink;
  /* What the microphone captured; opened only when --mic-record was given. */
  struct cli_wav_sink mic_sink;
  /* Where the pretend speaker's converter lands, when there is one. */
  struct cli_wav_sink pretend_sink;
  struct iterate_kit_darwin_audio_codec audio_codec;
  struct iterate_kit_audio_processor audio_processor;
  struct cli_keyboard keyboard;
  /** The one place a person reads this session; off unless interactive. */
  struct cli_screen screen;
  /*
   * THE TWO CONNECTIVITY TIMESTAMPS, latched at the transition rather than
   * derived on every draw.
   *
   * Both are "when did this last become true", and both are zero when it is
   * not true now — a call that ended clears its own, because "established
   * four minutes ago" drawn beside a dead call is the most misleading thing
   * this screen could say. Neither can be recovered after the fact: the
   * states they mark are edges, and the poll loop is the only thing that sees
   * them.
   */
  uint64_t api_connected_at_ms;
  uint64_t call_established_at_ms;
  /* Models the converter's clock; unpaced by default. See cli_paced_sink.h. */
  struct cli_paced_sink paced_sink;
  /* This session's adversity, drawn in full before the first frame moves. */
  struct cli_fault_schedule schedule;
  /* Which board the rig is wearing; never NULL after startup. */
  const struct cli_device_profile *profile;
  /* CPU stall episodes actually served, for the report. */
  uint32_t cpu_stalls_injected;
  /** Whether the CPU stall episode now running has yet to fire. */
  bool stall_armed;
  struct cli_conversation conversation;
  /** Wall-clock end of an interactive session; 0 means no limit was asked. */
  uint64_t finish_at_ms;
  /** A hang-up is in progress: the call is being ended before the process is. */
  bool hanging_up;
  uint64_t hangup_deadline_ms;
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
  /*
   * THE ONE THING NOBODY COULD SEE: where the wait after a key comes up goes.
   *
   * Six hops sit between letting go of a button and hearing a reply — the
   * loop noticing, the commit reaching the outbox, the stream carrying it, the
   * provider being asked, the first delta coming back, and the first sample
   * reaching the speaker — and not one of them was timed. Every diagnosis of
   * "it takes ages" so far has been somebody's reading of a scrolling log,
   * including two of mine that were wrong. These are stamped at the edges and
   * differenced once, when the answer starts.
   */
  uint64_t turn_released_ms;
  uint64_t turn_committed_ms;
  uint64_t turn_answer_seen_ms;
  uint32_t turn_release_to_commit_ms;
  uint32_t turn_commit_to_audio_ms;
  /**
   * When this turn's answer last made progress — a frame played or arrived.
   *
   * The turn watchdog measures THIS rather than elapsed time. A turn that is
   * still producing audio is not stuck, however long it runs, and cutting one
   * off because it is lengthy truncates exactly the answers worth asking for.
   */
  uint64_t turn_progress_ms;
  /** CoreAudio/file completion position when the current scripted turn began. */
  uint32_t turn_room_completed_start_bytes;
  /** Bytes this scripted turn successfully submitted to the room boundary. */
  uint32_t turn_room_submitted_bytes;
  /**
   * The current answer's playout timeline: when its first frame reached the
   * speaker, and how many MILLISECONDS have been emitted since. See iterate_kit_voice_playout_lag_ms —
   * both targets measure lateness the same way, from the same helper.
   */
  uint64_t answer_started_ms;
  uint32_t answer_emitted_ms;
  uint32_t speaker_lag_max_ms;
  uint64_t next_mic_at_ms;
  uint64_t next_playback_at_ms;
  uint64_t next_stats_at_ms;
  uint64_t unhealthy_since_ms;
  uint64_t last_pulse_ms;
  uint64_t last_sink_sync_ms;
  uint64_t started_ms;
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
  uint32_t speaker_write_failures;
  uint32_t mic_write_failures;
  /* Frames the room never got because the speaker ring was full. */
  uint32_t speaker_room_drops;
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

/**
 * The process's one clock, for the few sites that must configure it rather
 * than merely read it. Reading is what cli_runtime_now_ms is for.
 */
struct cli_virtual_clock *cli_runtime_clock(void);

/** The transport's clock hook, so its deadlines share the process's clock. */
int64_t cli_runtime_transport_now_us(void *context);

/** Monotonic milliseconds used by the runtime and voicelab callbacks. */
uint64_t cli_runtime_now_ms(void *context);

/**
 * The same monotonic clock in microseconds.
 *
 * The converter model's period is 20000 us, and a millisecond stamp cannot
 * express a rate that does not divide 1000 evenly — which every rate worth
 * sweeping does not.
 */
uint64_t cli_runtime_now_us(void);

/** Emit one timestamped diagnostic line. The caller chooses its severity. */
void cli_runtime_log(const char *level, const char *format, ...);

#endif /* ITERATE_KIT_CLI_RUNTIME_H */
