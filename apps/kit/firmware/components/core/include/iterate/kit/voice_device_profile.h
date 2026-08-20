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
   * Twenty milliseconds is the provider/device wire frame, and four frames per
   * independent append gives the sender catch-up margin without assigning
   * ordering to RPC completion.
   */
  ITERATE_KIT_VOICE_FRAME_MS = 20,
  ITERATE_KIT_VOICE_FRAME_SAMPLES = 320,
  ITERATE_KIT_VOICE_FRAME_BYTES = 640,
  ITERATE_KIT_VOICE_SAMPLE_RATE_HZ =
      ITERATE_KIT_VOICE_FRAME_SAMPLES * 1000 / ITERATE_KIT_VOICE_FRAME_MS,
  /*
   * FIVE SECONDS OF SPEECH THE LINK CANNOT YET CARRY. It was 32 frames — 640
   * ms — and the number was chosen for a different job.
   *
   * This queue is latest-wins, and while a call is up it never fills: capture
   * produces 50 frames a second and the sender is polled once per captured
   * frame and takes four, so it drains at four times the rate it fills. The
   * ONLY thing that makes it grow is a link that will not accept an append —
   * which is precisely the seconds between a person starting to speak and the
   * transport coming up.
   *
   * Measured, cold start: the prompt invited speech at t=622 ms and the
   * transport did not reach READY until t=8297 ms. A press at t=3105 and a
   * release at t=5289 fell entirely inside that window, and at 640 ms of hold
   * every word of it was displaced by the next word. The person said a
   * sentence and the agent received the last syllable, or nothing.
   *
   * 256 frames covers that connect with margin, costs 164 KB — SPIRAM on the
   * board, nothing on a host — and changes NOTHING during a call, because
   * during a call the queue is empty. Sizing it to the connect rather than to
   * the jitter is the whole point: jitter was never what overflowed it.
   *
   * It does NOT size the platform capture ring any more; see
   * ITERATE_KIT_DARWIN_AUDIO_INPUT_RING_FRAMES for why those are now two
   * numbers.
   */
  ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH = 256,
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
   * TEN SECONDS: A CUSHION AGAIN, because the sender paces once more.
   *
   * It was thirty, and the comment here argued the case honestly: the server
   * of the day shipped a whole answer as fast as the wire took it, so the ring
   * "is not a cushion any more — it IS the answer, and it has to hold the
   * longest one anybody will ask for". That was a true description of a wrong
   * arrangement. A microcontroller had become the buffer for a server that
   * would not wait, and the catch-up, high-water and lag-skip machinery around
   * it was all compensation for the same missing wait.
   *
   * The buffer now lives on the server, where memory is free and a unit test
   * can watch it, and the server releases at playback rate with a bounded
   * budget: voice-agent2's MAX_DEVICE_SPEAKER_BACKLOG_BYTES, 128,000 bytes —
   * four seconds. Ten seconds is that budget plus six of margin for jitter,
   * and 320 KiB rather than 960 KiB of PSRAM.
   *
   * DO NOT SHRINK THIS BELOW THE SENDER'S BUDGET, and read the budget from
   * voice-agent2.ts rather than from here — this comment is a copy and copies
   * go stale. It described v1's `leadMs: 3_000` for a while after v2 stopped
   * having a `leadMs` at all. The failure is silent from
   * here: a frame refused at the door was never a frame that went missing, so
   * the loss counters stay small and innocent while the listener loses whole
   * seconds. That is how the 1.5 s version hid 2080 discarded frames — 41
   * seconds of speech — across two minutes of ordinary conversation.
   */
  ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES = 320000,
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
   * hands over its whole budget — four seconds of audio — as fast as it can
   * append the instant an answer begins, so the frames behind the first one
   * are already in flight when it lands. Two cushions for one hazard, and only
   * this one costs the listener.
   */
  ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES = 60 * 32 + 2880,
  ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS = 400,
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
  /*
   * How often a board with a mouth asks the processor what that mouth is
   * doing — and ONLY while its speaker queue is non-empty, which is what
   * keeps an idle board silent on the wire. A face rendered at 10 Hz looks
   * fine and the classifier's output is sparser than that.
   */
  ITERATE_KIT_VOICE_FACE_POLL_MS = 100,
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
   * 120 s, AND THE COST IS REAL RATHER THAN FREE. It was 15 s, which is the
   * interval a liveness probe wants. It is not the interval a HIBERNATING
   * Durable Object can survive: nothing on the platform side calls
   * `setWebSocketAutoResponse`, so a control-frame PING is not answered by the
   * runtime — it wakes the object that owns the socket. Four boards probing
   * every fifteen seconds is four objects that never sleep, forever, whether
   * or not anybody is in the room.
   *
   * WHAT IS TRADED: a half-open socket now goes unnoticed for up to two
   * minutes of idleness instead of fifteen seconds. That is accepted because
   * the cost of a stale socket while nobody is talking is zero, and the cost
   * of never hibernating is paid continuously. It is NOT accepted for the
   * moment that matters — see below.
   *
   * THE FIRST PRESS AFTER A LONG IDLE MUST NOT WAIT THIS OUT, and it does not:
   * a press asks the hop itself, on its own clock. See
   * ITERATE_KIT_VOICE_PRESS_PROBE_MS below.
   *
   * THESE TWO MOVE TOGETHER, which is why the one below moved with it.
   */
  /*
   * A liveness PROBE for a hop silent both ways this long — deliberately
   * NOT a keepalive racing anybody's idle policy. A client's standing job
   * is to BE CONNECTED and available: the socket is how the server reaches
   * this device (server-triggered conversations, pushes), so it exists
   * whether or not anyone is pressing anything — only the voice PROVIDER is
   * dialed on demand. Sockets still die (isolate churn, deploys; measured
   * 2026-08-18: no idle policy anywhere, pings prevent nothing), and a
   * half-open one looks healthy from here. The probe exists to DETECT that,
   * so the transport's reconnect loop runs NOW — not at the next use, and
   * not after minutes of capture are spoken into a corpse.
   */
  ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS = 120000,
  /*
   * Last resort: no PONG for this long on a READY transport and the chip
   * restarts, because a half-open TCP connection looks perfectly healthy from
   * this end and no in-process recovery has worked.
   *
   * 420 s, RAISED FROM 180 BECAUSE THE PROBE ABOVE SLOWED DOWN. At a 15 s
   * probe, 180 s was eleven chances to be answered; at a 120 s probe it is
   * ONE, and the arithmetic is not close — a probe goes out at 120 s, and if
   * that single PONG is lost the restart fires at 180 s, sixty seconds before
   * the next probe is even sent. One dropped packet on an idle board would
   * reboot it, and a lossy access point would reboot it repeatedly.
   *
   * 420 gives three probes (120, 240, 360) and a minute of slack, so a
   * restart means three consecutive losses rather than one. The cost is that
   * a genuinely dead hop on an IDLE board is now carried for up to seven
   * minutes — which costs nothing, because the board is idle, and because the
   * case anybody can notice is a PRESS, and a press has its own probe below.
   */
  ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS = 420000,
  /*
   * HOW LONG A PRESS WAITS FOR THE HOP TO ANSWER BEFORE THE SOCKET IS DEAD.
   *
   * The failure this exists for: a one-way append into a half-open socket is
   * accepted by TCP and reports success. The socket looks open, the transport
   * stays READY, and the first thing that notices is DOWNLINK_SILENCE_MS ten
   * seconds later — ten seconds in which a person has pressed to talk and
   * nothing whatsoever has happened. That is the worst failure left on these
   * boards and it is entirely on the press path.
   *
   * SO THE PRESS ASKS. Placing a call queues a WebSocket PING and watches
   * `websocket_pongs_received`. Armed by a press and by nothing else: an idle
   * board never sends one, which is the whole reason the periodic probe had to
   * be slowed to 120 s and must not be undone here.
   *
   * WHY A PONG AND NOT A DELIVERED BATCH. A batch is the far side finishing
   * application work — journalling the append, fanning it out to subscribers —
   * and its latency legitimately includes waking an object that may be cold.
   * A short deadline on THAT would tear down healthy sessions for being slow,
   * which is worse than the bug. A PONG is owed by the socket peer as soon as
   * it parses the frame in order and owes nothing to any of that work, so it
   * answers the only question the press actually has: is this socket still
   * connected to anything? Nothing else on the device separates "dead socket"
   * from "slow server", and the two want opposite remedies — a new socket
   * versus patience.
   *
   * 1500 ms x 2, AND THE SECOND ATTEMPT IS THE POINT. One missed PONG is a
   * dropped packet; two consecutive are a dead hop. This is the same judgement
   * NO_LIVENESS_RESTART_MS above makes for the idle path, where three losses
   * rather than one are required before a reboot, and it is made here for the
   * same reason: on a lossy access point a single-loss rule fires constantly.
   * So a press into a dead socket is answered in ~3 s where it used to take 10,
   * and a press into a merely slow one is not answered at all.
   *
   * 1500 ms IS A BUDGET, NOT A MEASUREMENT — no PONG round trip has been
   * measured on these boards. `pressProbeMs` in health() reports the last one
   * so that the next person to touch this number has evidence instead of this
   * comment.
   */
  ITERATE_KIT_VOICE_PRESS_PROBE_MS = 1500,
  ITERATE_KIT_VOICE_PRESS_PROBE_ATTEMPTS = 2,
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
   * THE IDLE REMOUNT CONSTANT WAS HERE (180s). It restarted the whole
   * transport after any three quiet minutes, because the platform once
   * dropped mounts silently and this clock was the only recovery. It was
   * also the fleet's dominant Durable Object churn — one incarnation per
   * board per cycle. Deleted 2026-08-20 to measure how long a mount actually
   * lives without it; if the silent drop still exists, the fix is a
   * re-registration that does not drop the socket, not a metronome.
   */
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
