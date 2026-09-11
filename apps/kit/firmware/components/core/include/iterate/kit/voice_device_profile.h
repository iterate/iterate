#ifndef ITERATE_KIT_VOICE_DEVICE_PROFILE_H
#define ITERATE_KIT_VOICE_DEVICE_PROFILE_H

#include <stdint.h>

/* Shared transport budgets for PCM16 mono at 16 kHz (32 bytes/ms).
 * Device DMA, codec timing and AEC calibration belong to the board. */
enum {

  /* Bounded Cap’n Web arenas; exhaustion is a session failure. */
  ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY = 16,
  ITERATE_KIT_VOICE_EXPORT_CAPACITY = 4,
  ITERATE_KIT_VOICE_IMPORT_CAPACITY = 16,
  ITERATE_KIT_VOICE_TOKEN_CAPACITY = 1024,
  ITERATE_KIT_VOICE_OUTPUT_CAPACITY = 128,

  /* Leave 2 KiB in an outbox slot for the RPC envelope. */
  ITERATE_KIT_VOICE_HEALTH_CAPACITY = 6144,

  /* Reserve outbox space so microphone traffic cannot starve RPC replies. */
  ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY = 16384,
  ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY = 8192,
  ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS = 64,
  ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS = 64,
  ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE = 40,

  ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY = 8,
  ITERATE_KIT_VOICE_DEVICE_EVENT_POLL_BUDGET = 8,

  /* Capture grain; GPT-Live itself accepts arbitrary even PCM byte lengths. */
  ITERATE_KIT_VOICE_FRAME_MS = 20,
  ITERATE_KIT_VOICE_FRAME_SAMPLES = 320,
  ITERATE_KIT_VOICE_FRAME_BYTES = 640,
  ITERATE_KIT_VOICE_SAMPLE_RATE_HZ =
      ITERATE_KIT_VOICE_FRAME_SAMPLES * 1000 / ITERATE_KIT_VOICE_FRAME_MS,

  /* 20 s opening deadline plus 500 ms wake history. */
  ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH = 21000 / ITERATE_KIT_VOICE_FRAME_MS,

  /* Eight is the catch-up cap; normal partial batches flush every 50 ms. */
  ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND = 8,

  ITERATE_KIT_VOICE_MIC_FLUSH_MS = 50,


  /* Ten seconds of bounded incoming jitter; this is capacity, not a delay. */
  ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES = 320000,

  /* 210 ms plus 90 ms DMA lead. Current transport p99 gaps reach 300–400 ms;
   * reduce only with paired latency and starvation measurements. */
  ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES = 210 * 32 + 2880,

  /* Short answers start at the same deadline without waiting for an end marker. */
  ITERATE_KIT_VOICE_SPEAKER_PRIME_WAIT_MS =
      ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES /
      (ITERATE_KIT_VOICE_FRAME_BYTES / ITERATE_KIT_VOICE_FRAME_MS),
  ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS = 400,

  ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS = 500,
  ITERATE_KIT_VOICE_SPEAKER_IDLE_POWERDOWN_MS = 1500,


  ITERATE_KIT_VOICE_TURN_MAX_MS = 30000,

  /* Device presence is separate from the backend’s continuous input clock. */
  ITERATE_KIT_VOICE_CALL_KEEPALIVE_MS = 20000,

  ITERATE_KIT_VOICE_CONNECTION_OPEN_TIMEOUT_MS = 10000,
  ITERATE_KIT_VOICE_CONTROL_POLL_MS = 25,
  ITERATE_KIT_VOICE_STATS_INTERVAL_MS = 5000,

  /* Poll reduced face state only while answer audio is queued. */
  ITERATE_KIT_VOICE_FACE_POLL_MS = 100,
  ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS = 120000,

  /* Only count silence while call acceptance or answer audio is owed. */
  ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS = 10000,


  /* Long idle probe permits DO hibernation; any inbound frame proves liveness. */
  ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS = 120000,

  ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS = 420000,

  /* Failed remounts use bounded backoff, reset after a successful mount. */
  ITERATE_KIT_VOICE_REMOUNT_RETRY_MS = 2000,
  ITERATE_KIT_VOICE_REMOUNT_RETRY_MAX_MS = 30000,

};

/* A clock reset cannot manufacture elapsed time. */
static inline uint64_t iterate_kit_voice_elapsed_ms(
    uint64_t now, uint64_t since) {
  return since > now ? 0U : now - since;
}

#endif
