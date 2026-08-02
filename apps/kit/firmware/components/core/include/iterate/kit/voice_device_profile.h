#ifndef ITERATE_KIT_VOICE_DEVICE_PROFILE_H
#define ITERATE_KIT_VOICE_DEVICE_PROFILE_H

/*
 * THE MEASUREMENT PROFILE SHARED BY THE PHYSICAL AND HOST VOICE TARGETS.
 *
 * These are resource limits and supervision deadlines, not convenient
 * defaults.  A host run with a deeper queue or a more patient watchdog would
 * exercise a different system and could make an ESP32 failure disappear.  A
 * target may adapt only a physical seam (for example, an I2S DMA lead that
 * macOS does not have); such a difference belongs under an explicitly named
 * override at the adapter, never in a second copy of this table.
 *
 * Audio is 16 kHz mono PCM16.  At 32 bytes/ms the byte and millisecond
 * budgets below are exact, rather than estimates based on a wall clock.
 */
enum {
  /*
   * Cap'n Web arenas are hard failure bounds: pending/export/import exhaustion
   * ends a session, token exhaustion rejects a legitimate nested provider
   * event, and output is only used for the tiny expressions emitted here.
   */
  ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY = 16,
  ITERATE_KIT_VOICE_EXPORT_CAPACITY = 4,
  ITERATE_KIT_VOICE_IMPORT_CAPACITY = 16,
  ITERATE_KIT_VOICE_TOKEN_CAPACITY = 1024,
  ITERATE_KIT_VOICE_OUTPUT_CAPACITY = 128,

  /*
   * A 16 KiB inbox slot admits a 12-frame delivery batch. Sixty-four slots
   * cover measured TCP clumping plus concurrent durable calls. The 64-slot
   * outbox absorbs the microphone's finite speech burst, while its 40-slot
   * reserve prevents unacknowledged audio from starving mandatory replies.
   */
  ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY = 16384,
  ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY = 8192,
  ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS = 64,
  ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS = 64,
  ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE = 40,

  /*
   * Twenty milliseconds is the provider/device wire frame. Capture is
   * latest-wins within 640 ms, and four frames per independent append gives
   * the sender catch-up margin without assigning ordering to RPC completion.
   */
  ITERATE_KIT_VOICE_FRAME_MS = 20,
  ITERATE_KIT_VOICE_FRAME_SAMPLES = 320,
  ITERATE_KIT_VOICE_FRAME_BYTES = 640,
  ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH = 32,
  ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND = 4,

  /*
   * The speaker ring is 1.5 s of jitter, not an answer store. Playback starts
   * after 390 ms (300 ms acoustic lead plus the 90 ms I2S DMA lead), conceals
   * at most 400 ms, and sheds one frame per 50 above 1200 ms so catch-up is
   * audible only as bounded latency recovery rather than pitch distortion.
   */
  ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES = 48000,
  ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES = 300 * 32 + 2880,
  ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS = 400,
  ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS = 1200,
  ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY = 50,
  ITERATE_KIT_VOICE_SPEAKER_IDLE_POWERDOWN_MS = 1500,

  /*
   * These deadlines bound every recovery path. They are intentionally longer
   * than ordinary RTT/jitter but finite: failures remain classified and lead
   * to a call recycle, transport restart, or process restart instead of a
   * permanently plausible-looking stuck session.
   */
  ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS = 1500,
  ITERATE_KIT_VOICE_TURN_MAX_MS = 30000,
  ITERATE_KIT_VOICE_CONTROL_POLL_MS = 25,
  ITERATE_KIT_VOICE_STATS_INTERVAL_MS = 5000,
  ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS = 120000,
  ITERATE_KIT_VOICE_PING_INTERVAL_MS = 5000,
  ITERATE_KIT_VOICE_PING_TIMEOUT_MS = 20000,
  ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS = 20000,
  ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS = 10000,
  ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS = 180000,
};

#endif /* ITERATE_KIT_VOICE_DEVICE_PROFILE_H */
