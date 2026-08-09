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
   * 60 ms of cushion, plus one hardware ring. DOWN FROM 300.
   *
   * Raised to 1000 ms once on the theory that a bigger cushion would stop the
   * holes. It did not: measured on the CLI, concealment went 1.06% -> 1.24%,
   * slightly WORSE, because the holes were never starvation. The real causes
   * were a ring too small to hold an answer and a debt mechanism deleting
   * frames, both since fixed. 300 was the retreat from that, and it was still
   * sized for a danger that no longer exists.
   *
   * THIS IS PAID ON EVERY ANSWER, not once per call: the first frame of an
   * answer always REPLACEs, which reprimes the clock. At 300 ms it was 390 ms
   * of silence before every first word — four times the entire measured cost
   * of the server round trip it sits behind (48 ms up, 46 ms down).
   *
   * And it buys nothing the sender is not already buying. The facet's pacer
   * releases an opening burst of 150 frames — three seconds of audio — the
   * instant an answer begins, so the frames behind the first one are already
   * in flight when it lands. Two cushions for one hazard, and only this one
   * costs the listener.
   */
  ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES = 60 * 32 + 2880,
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
  /*
   * `PING_INTERVAL_MS`, `PING_TIMEOUT_MS` and `BRIDGE_SILENCE_MS` were here.
   * All three served an application-level ping/pong that has been deleted: a
   * WebSocket carries its own PING/PONG and the transport already answers it,
   * and the platform exposes a connection-layer probe that returns t0/t1/t2.
   * The bridge-silence deadline went with them because the pong was its only
   * evidence during a silent call — without it, the watchdog would have
   * dropped every call in which nobody spoke for twenty seconds.
   *
   * What is left is the deadline on the lane that has no other proof.
   */
  ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS = 10000,
  /*
   * How long the WebSocket hop must be quiet BOTH ways before this device
   * sends its own PING.
   *
   * Comfortably inside NO_LIVENESS_RESTART_MS below, so a healthy idle board
   * completes several round trips before that watchdog could ever fire, and
   * long enough that a device in a call — which proves the hop continuously
   * with data frames — never sends one at all.
   */
  ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS = 15000,
  ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS = 180000,
  /*
   * Re-mounting a voicelab that failed under a healthy connection.
   *
   * A BACKOFF THAT ONLY EVER GROWS IS NOT A BACKOFF, it is a ceiling the
   * device reaches once and never leaves. All four boards deferred this gate
   * on every remount attempt and never reset it, so five transient failures
   * anywhere in a boot — an access-point blip during the first minute is
   * enough — left the board taking 30s to notice a failed mount for the rest
   * of its life, long after everything had recovered. Both transport gates
   * already reset themselves on a healthy connection; these four did not.
   *
   * Live here rather than as four copies of 2000/30000 so the reset rule and
   * the numbers it applies to cannot drift apart per board, and so the host
   * test pins the same budget the devices use.
   */
  ITERATE_KIT_VOICE_REMOUNT_RETRY_MS = 2000,
  ITERATE_KIT_VOICE_REMOUNT_RETRY_MAX_MS = 30000,
  /*
   * How long an IDLE device may hold a mount nobody is answering before it
   * replaces the session.
   *
   * Every other watchdog here needs a call in progress. So a device whose
   * capability has gone offline server-side while its TCP connection stays
   * perfectly healthy is watched by nothing at all: it loops, it reports
   * itself ready, and every RPC to it fails with "capability is offline"
   * until somebody power-cycles it.
   *
   * Measured: after eighteen turns the soak's calls ended, the capability
   * went offline, and the device sat there for minutes — rx and played both
   * frozen at 8468, conceal 0, gaps 0, entirely healthy and entirely
   * unreachable.
   *
   * THREE MINUTES WAS WRONG, and the sentence that justified it was too: it
   * said "a mounted device exchanges a ping every five [seconds]", so silence
   * on this counter would mean something real. But that ping was OUTBOUND —
   * the device appended it — while this watchdog counts dispatches served TO
   * the device. On an idle board nothing is served, so the counter never
   * moves and the watchdog fires on a schedule, forever, on a device that is
   * working perfectly. (The ping itself is gone now; the reasoning error it
   * illustrates is why this paragraph stays.)
   *
   * What it does when it fires is not cheap either: it replaces the whole
   * transport — TLS, socket, session and mount. Measured on an idle M5StickS3,
   * seven of them in twenty-six minutes. From across the room that is a device
   * that "just randomly disconnects and reconnects", because it is.
   *
   * BACK TO THREE MINUTES, having tried fifteen and measured the cost.
   *
   * Lengthening it stopped the flap and revealed what the flap had been hiding:
   * this is the ONLY thing that re-establishes a mount the platform has
   * dropped. Measured the same night — all four boards mounted, ran ~11
   * minutes, and lost their mounts together. Four independent devices failing
   * simultaneously is one shared cause and it is server-side; with a fifteen
   * minute interval they simply stayed dead for longer.
   *
   * So the flap is real and this constant is not the fix for it. Until the
   * server-side mount loss is understood, a device that recovers in three
   * minutes beats a tidier one that does not recover for fifteen. The proper
   * answer remains a re-registration that does not drop the socket.
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
