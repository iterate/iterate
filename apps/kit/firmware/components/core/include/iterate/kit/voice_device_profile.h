#ifndef ITERATE_KIT_VOICE_DEVICE_PROFILE_H
#define ITERATE_KIT_VOICE_DEVICE_PROFILE_H

#include <stdint.h>

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
  /* Physical, remote, and system talk edges share this fixed owner queue. */
  ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY = 8,
  ITERATE_KIT_VOICE_DEVICE_EVENT_POLL_BUDGET = 8,

  /*
   * Twenty milliseconds is the provider/device wire frame. Capture is
   * latest-wins within 640 ms, and four frames per independent append gives
   * the sender catch-up margin without assigning ordering to RPC completion.
   */
  ITERATE_KIT_VOICE_FRAME_MS = 20,
  ITERATE_KIT_VOICE_FRAME_SAMPLES = 320,
  ITERATE_KIT_VOICE_FRAME_BYTES = 640,
  ITERATE_KIT_VOICE_SAMPLE_RATE_HZ =
      ITERATE_KIT_VOICE_FRAME_SAMPLES * 1000 / ITERATE_KIT_VOICE_FRAME_MS,
  ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH = 32,
  /*
   * FOUR, and the argument for twelve is written down because it is a good
   * argument that loses to a measurement.
   *
   * Every append costs two WebSocket messages against a socket that sustains
   * roughly 25-50 a second, so four frames per append (25 messages/s) sits on
   * the floor of that ceiling while twelve would sit comfortably under it.
   * The constant's own documentation said twelve. Both were true and it still
   * broke the device.
   *
   * Measured at twelve: fifteen turns answered, then the uplink stopped dead
   * — frames=0 for the rest of a 26-minute soak while the downlink stayed
   * perfect at rx=7721 played=7721. Twelve frames is 240 ms of speech against
   * a 32-frame (640 ms) queue, and the catch-up rule only calls the sender
   * "behind" at twice the batch, which is 480 ms: three quarters of the whole
   * queue. A turn that never accumulates 480 ms never triggers catch-up, and
   * a queue that fills meanwhile drops its oldest frames forever.
   *
   * Fixing that properly means sizing the queue and the catch-up threshold
   * together with the batch, not raising one of the three. Until somebody
   * does that with a measurement in hand, this stays where it was proven.
   */
  ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND = 4,

  /*
   * The speaker ring is 1.5 s of jitter, not an answer store. Playback starts
   * after 390 ms (300 ms acoustic lead plus the 90 ms I2S DMA lead), conceals
   * at most 400 ms, and sheds one frame per 50 above 1200 ms so catch-up is
   * audible only as bounded latency recovery rather than pitch distortion.
   */
  /*
   * THIRTY SECONDS, because the sender no longer paces.
   *
   * This was a jitter cushion when the server dripped frames to arrive just
   * in time. That server is gone: a whole answer now leaves as fast as the
   * wire takes it, so the ring is not a cushion any more — it IS the answer,
   * and it has to hold the longest one anybody will ask for.
   *
   * Sized at 1.5 s it did not. Measured over two minutes of ordinary
   * conversation: 2080 frames — forty-one seconds of speech — discarded at
   * the door for want of room, while the loss counters stayed small and
   * innocent because a frame refused on arrival was never a frame that went
   * missing. 30 s of 16 kHz mono PCM16 is 960 KiB of PSRAM this board has
   * spare, and overflowing THAT is a real fault worth shouting about.
   */
  ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES = 960000,
  /*
   * 300 ms of true cushion, plus one hardware ring.
   *
   * Raised to 1000 ms on the theory that a bigger cushion would stop the
   * holes. It did not: measured on the CLI, concealment went 1.06% -> 1.24%,
   * slightly WORSE, because the holes were never starvation. The real causes
   * were a ring too small to hold an answer and a debt mechanism deleting
   * frames, both since fixed.
   *
   * So this goes back down, because prefill is pure added latency before the
   * first word and buys nothing once the sender ships whole answers. The
   * device holds a 30 s ring; it does not need to wait a second to start.
   */
  ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES = 300 * 32 + 2880,
  ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS = 400,
  /*
   * Backlog beyond which a frame is skipped to catch up — effectively never,
   * and deliberately so. Catching up on DEPTH made sense when a deep buffer
   * meant the sender was running ahead of realtime. With a whole answer
   * arriving at once a deep buffer is the NORMAL state, and skipping then
   * deletes speech from the middle of a sentence at a steady rate. Just under
   * the ring, so it can only fire if something has gone truly wrong.
   *
   * Lateness is measured against the audio timeline instead — see
   * ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS, which is the signal this one
   * was standing in for and getting wrong.
   */
  ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS = 29000,
  /*
   * How far behind its own timeline playback may fall before a frame is
   * dropped to recover.
   *
   * THE SIGNAL, AND WHY IT IS NOT QUEUE DEPTH. Frame N of an answer belongs
   * 20N ms after the first one played; the gap between that and the wall
   * clock is lag. It grows only when playback stalls, never when the sender
   * runs ahead — which is exactly the distinction depth cannot make, and the
   * reason the depth trigger had to be set so high it never fired.
   *
   * Measured on hardware with no trigger at all: playback drifted 2772 ms
   * behind its own timeline in three turns. Half a second is past the point
   * where a listener hears a reply as slow, and far short of the ~1.5 s where
   * they would notice a single 20 ms frame missing.
   */
  ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS = 500,
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
  /* Bounds DNS, TCP, TLS, and HTTP upgrade as one reconnect attempt. */
  ITERATE_KIT_VOICE_CONNECTION_OPEN_TIMEOUT_MS = 10000,
  ITERATE_KIT_VOICE_CONTROL_POLL_MS = 25,
  ITERATE_KIT_VOICE_STATS_INTERVAL_MS = 5000,
  ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS = 120000,
  ITERATE_KIT_VOICE_PING_INTERVAL_MS = 5000,
  ITERATE_KIT_VOICE_PING_TIMEOUT_MS = 20000,
  ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS = 20000,
  ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS = 10000,
  ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS = 180000,
  /*
   * How long an IDLE device may hold a mount nobody is answering before it
   * replaces the session.
   *
   * Every other watchdog here needs a call in progress, and the one that does
   * not keys on pings — which ride the SOCKET, not the mount. So a device
   * whose capability has gone offline server-side while its TCP connection
   * stays perfectly healthy is watched by nothing at all: it loops, it pings,
   * it reports itself ready, and every RPC to it fails with "capability is
   * offline" until somebody power-cycles it.
   *
   * Measured: after eighteen turns the soak's calls ended, the capability
   * went offline, and the device sat there for minutes — rx and played both
   * frozen at 8468, conceal 0, gaps 0, entirely healthy and entirely
   * unreachable.
   *
   * Ninety seconds is far longer than any legitimate quiet — a mounted device
   * exchanges a ping every five — and short enough that a person who walks up
   * to it finds it working.
   */
  ITERATE_KIT_VOICE_IDLE_REMOUNT_MS = 180000,
};

/**
 * How long ago `since` was, on the same monotonic clock as `now`.
 *
 * WHY THIS EXISTS RATHER THAN `now - since`. Every deadline in this runtime
 * is a supervision rule: no bridge event for 20s means the call is gone, no
 * batch for 10s means the delivery lane is dead. Written as a bare
 * subtraction on unsigned time they are all armed with the same landmine —
 * a stamp one millisecond in the FUTURE underflows to 18446744073709551615,
 * which exceeds every deadline there is.
 *
 * That is not hypothetical, and it does not need a clock that goes backwards.
 * A loop samples `now` once at the top and checks its deadlines at the
 * bottom; in between it polls the network, and an arriving batch stamps its
 * own, later, reading. One millisecond of ordinary progress inside a single
 * iteration was enough: measured on a healthy session with a 78ms round
 * trip, the call was declared gone and restarted, over and over, forty-two
 * times in three minutes.
 *
 * So a stamp from the future reads as "just now", which is the only sane
 * meaning it can have.
 */
static inline uint64_t iterate_kit_voice_elapsed_ms(
    uint64_t now, uint64_t since) {
  return since > now ? 0U : now - since;
}

#endif /* ITERATE_KIT_VOICE_DEVICE_PROFILE_H */
