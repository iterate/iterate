/*
 * The Iterate voice device, once, for every board that is one.
 *
 * The whole product is here: a UI (start call / hang up), a live capability at
 * kit.<board> so an agent can drive the screen and the call, and the voice pipe
 * itself. What a board physically IS arrives through
 * `struct iterate_kit_board_ops`; voice/loop.h says why that surface is the
 * size it is, and what four copies of this file cost before it existed.
 *
 * ONE Cap'n Web WebSocket to /api carries everything, exactly like the
 * TypeScript voicelab client: authenticate -> projects.get -> streams.get,
 * then 50 Hz one-way appends of ephemeral events.iterate.com/voice-agent/mic-frame events (real
 * microphone), and a live openConnection callback delivering
 * events.iterate.com/voice-agent/spk-frame events (decoded to the speaker) plus grok-events
 * (speech_started = barge-in flush, response.done = end of answer).
 *
 * Nothing runs off-device: pressing "start call" calls the project's OWN
 * userspace worker (itx.worker.startCall) over that same socket, and the
 * worker holds the Grok session detached. No laptop bridge, no second
 * connection.
 *
 * Turn taking is a per-board FACT, not a per-board program. A board with no
 * echo cancellation holds a control while speaking and sends nothing from the
 * microphone unless it is down — the whole echo story there, since the speaker
 * is never live into an open microphone and pressing to talk cancels an answer
 * in flight instead of talking over it. A board that cancels its own speaker
 * leaves the microphone open and lets the far end segment turns. Both are
 * below, chosen by `facts->turns`.
 *
 * Observability is the stream itself (events.iterate.com/voice-agent/dev-stats every 5s);
 * opening the USB console resets some of these boards.
 *
 * DELIBERATE DEPARTURE from the dual-WebSocket decision in
 * docs/fable-v2-plan/DECISIONS.md — this is the single-socket measurement that
 * decision asked for.
 */
#include <inttypes.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "capnweb/capnweb.h"
#include "iterate/kit/audio_codec.h"
#include "iterate/kit/conversation_launch.h"
#include "iterate/kit/retry_gate.h"
#include "iterate/kit/platforms/esp_idf_reset_reason.h"
#include "iterate/kit/platforms/esp_idf_restart_note.h"
#include "iterate/kit/mount_watchdog.h"
#include "iterate/kit/capabilities/conversation.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/capabilities/push_to_talk.h"
#include "iterate/kit/capabilities/speaker.h"
#include "iterate/kit/audio_playout.h"
#include "iterate/kit/audio_processor.h"

/*
 * UTC as YYYY-MM-DD-HHMMSS, or false when the clock has not arrived.
 *
 * Declared up here because two very distant places need the same string: the
 * name of a new conversation, and `health()`. One function so that what the
 * metrics report is literally what a new path would be called, rather than two
 * formats that agree until one of them is edited.
 */
static bool clock_slug(char *out, size_t capacity);

/*
 * Throw away whatever speaker audio is queued, in the one safe order. Declared
 * here because the abandon sites are spread across the receive path and the app
 * loop; defined once, beside the runtime it acts on.
 */
static uint32_t abandon_speaker_audio(void);
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voicelab_stream.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_playback_clock.h"

static const char tag[] = "iterate-voicelab";

enum {
  /*
   * Occupancy is inbound-call-rate x round-trip: every delivery batch is a
   * push holding a slot until the server's release arrives. At ~12 batches/s
   * and 160 ms RTT that is already 2, and a concurrent recording pull adds
   * one per chunk. Exhausting this aborts the SESSION, so it is sized for
   * the burst, not the average.
   */
  PENDING_CALL_CAPACITY = ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY,
  EXPORT_CAPACITY = ITERATE_KIT_VOICE_EXPORT_CAPACITY,
  IMPORT_CAPACITY = ITERATE_KIT_VOICE_IMPORT_CAPACITY,
  /*
   * Replies to pulled calls and inbound delivery batches both parse inside
   * this budget, one token per JSON key, value, object and array —
   * exhaustion ABORTS THE SESSION. A capped batch of 4 speaker frames is
   * ~72, but a single Grok response.done carries a nested event object that
   * alone runs to several hundred. 256 was sized for a 2-event batch and was
   * never re-checked when the cap doubled; 1024 costs 12 KiB of otherwise
   * idle PSRAM-eligible RAM and takes this off the table.
   */
  TOKEN_CAPACITY = ITERATE_KIT_VOICE_TOKEN_CAPACITY,
  OUTPUT_CAPACITY = ITERATE_KIT_VOICE_OUTPUT_CAPACITY,
  /*
   * An inbox slot takes one whole delivery batch, so this is the ceiling on
   * how much audio one batch may carry — and batch SIZE is what decides
   * whether the speaker keeps up.
   *
   * Delivery is one batch at a time: the platform hands over a batch and the
   * next one waits on this device's reply. Measured at 5.7 batches a second
   * (~175 ms a round trip), so a 4-event cap was 80 ms of audio per 175 ms —
   * 0.46x realtime. The device played 94 of the 200 frames in one answer and
   * concealed 122. That is the choppiness, and no amount of buffering fixes
   * a lane that delivers at half speed.
   *
   * 16 KiB holds a 12-event batch (240 ms of audio) with room for the
   * envelope, which is 1.37x realtime at the same round trip.
   */
  CONTROL_INBOX_SLOT_CAPACITY =
      ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY,
  CONTROL_OUTBOX_SLOT_CAPACITY =
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY,
  /*
   * The inbox rides PSRAM (512 KiB), and overflowing it is SESSION-FATAL, so
   * it is sized for the worst legitimate burst rather than the average: a
   * paced answer clumps at TCP granularity, and pulling a recording off the
   * card adds a call per chunk on top. Measured high-water was 46 of 64
   * during ordinary use — close enough to the edge that the session died
   * under a recording pull concurrent with a call. 128 leaves real headroom.
   */
  CONTROL_INBOX_SLOTS = ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS,
  /*
   * The uplink sends 6 frames per 120 ms, which is exactly the capture rate —
   * so it has no margin, and any iteration blocked on outbox headroom puts
   * it permanently behind (measured: holds over 2 s ended with the queue
   * still full at the flush deadline). The outbox lives in PSRAM now, so
   * depth is cheap; 16 slots lets the sender catch up instead of losing the
   * tail of long utterances.
   */
  /*
   * 64, not 16. Pushing into a FULL outbox returns CAPNWEB_E_TRANSPORT, and
   * this peer terminalizes on that — the session ends, the turn is lost, and
   * the screen sits on "listening". Measured: every push-to-talk turn died
   * this way (appCapnweb=-4 at the moment the microphone opened).
   *
   * The microphone is bursty — three seconds of speech, then nothing — so the
   * fix is room to absorb a burst rather than a faster drain. 64 slots is
   * ~5 s of uplink at 8 KiB each, in PSRAM, which this board has to spare.
   */
  CONTROL_OUTBOX_SLOTS = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS,
  /*
   * How much of that the microphone may never touch. Replies to inbound
   * calls are NOT gated on headroom — the session generates them whenever the
   * platform delivers something — so the mic must leave them room or it
   * starves the very lane that keeps the session alive.
   */
  MIC_OUTBOX_RESERVE = ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE,
  FRAME_MS = ITERATE_KIT_VOICE_FRAME_MS,
  FRAME_SAMPLES = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  /*
   * `SPEAKER_FRAME_MS` and `DMA_RING_CREDIT_MS` were here, and on all four
   * boards, and read by nobody on any of them — 20 everywhere, and 40/60/90/120
   * respectively. A constant no code reads is a claim no measurement checks, so
   * they are deleted rather than promoted to per-board facts. The ring depth
   * that DOES matter survives as `facts->speaker_dry_wait_ms`, which is derived
   * from it and is read on every dry wait.
   */
  FRAME_BYTES = ITERATE_KIT_VOICE_FRAME_BYTES,
  MIC_QUEUE_DEPTH = ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH,
  MIC_FRAMES_PER_APPEND = ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND,
  /*
   * The speaker buffer holds JITTER, never an answer. A 1 MiB (32 s) buffer
   * was the single worst defect here: the bridge paced above realtime, so
   * every answer accumulated until the buffer filled, and then
   * xStreamBufferSend committed the HEAD of a frame and discarded the tail —
   * a click at an arbitrary waveform phase every 20 ms, heard as static that
   * got worse the longer the answer ran. 1 s is ample for network jitter now
   * that the bridge paces at ~1.05x, and whole frames are dropped rather
   * than split.
   */
  /*
   * 900ms, in INTERNAL RAM. Two constraints meet here: it must exceed the
   * bridge's 600ms opening burst plus jitter (at 750ms it did not, and 36
   * frames were dropped on arrival), and it must not rob the TLS handshake
   * (at 40000 the connection could not be established at all). 900ms clears
   * the burst with room and leaves the network stack its working set. (PSRAM is unreachable while the cache is off, and
   * a flash write would otherwise stall the audio ring as well as the tasks).
   * Deep buffers were the wrong lever: they cannot fix a recovery path that
   * under-fills the DMA, and they raise the ceiling that playout lag ratchets
   * toward. Concealment plus drop-debt bounds the lag instead.
   *
   * (Was four seconds, in PSRAM.) One second could not hold the bridge's 600ms
   * opening burst plus network jitter, so the buffer both OVERFLOWED (22
   * frames dropped) and later ran dry (minimum margin 0ms) in the same
   * answer — the classic too-small-for-the-burst signature.
   *
   * Unbounded growth is not a risk any more: the bridge paces at realtime
   * after its burst, so occupancy is bounded by burst + jitter rather than
   * by the length of the answer. (A 32s buffer WAS wrong, but only because
   * pacing was then 2x realtime and accumulated for the whole answer.)
   */
  /*
   * 1500 ms, not 900. The cushion a listener actually hears is the bridge's
   * opening lead PLUS this device's prefill, and they stack: 390 ms of
   * prefill against a 900 ms ring left only ~500 ms for the lead, so the
   * lead was cut to 250 ms to stop the ring overflowing — and then the ring
   * sat at a measured 384 ms maximum margin with MORE frames concealed than
   * played. Choppy in one direction was traded for choppy in the other.
   *
   * The ring is the cheap side of that trade: 19 KiB more internal RAM buys
   * a 600 ms lead with 500 ms of headroom still spare.
   */
  SPEAKER_BUFFER_BYTES = ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES,
  /* Whole-frame queueing makes replacement atomic at frame boundaries. */
  SPEAKER_QUEUE_DEPTH = SPEAKER_BUFFER_BYTES / FRAME_BYTES,
  /*
   * Playback will not start, or resume after starving, until this much audio
   * is queued. Without it the first frame starts the speaker with zero margin
   * and the DMA's 90 ms is the only tolerance the whole path has.
   */
  /*
   * 300ms before playback starts. The bridge bursts 600ms at the opening of
   * every response, so this is reached as fast as the wire allows and costs
   * almost nothing in latency — while doubling the cushion that a network
   * hiccup has to exhaust before anything is audible.
   */
  /*
   * Net of the DMA ring: the first 2880 bytes of any prefill go into the
   * hardware, not into jitter cushion, so the old "300ms" was really 210.
   * 300ms of true cushion plus one ring.
   */
  SPEAKER_PREFILL_BYTES = ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES,
  /*
   * Recovering from a starve does NOT re-buy the full opening prefill. It
   * used to, so a single late frame cost 160 ms of inserted silence —
   * measured at 45 starves per 3099 frames, roughly 7 s of stutter per
   * minute of speech. Mid-answer the bridge is already streaming, so a much
   * smaller cushion is enough to carry on.
   */
  /*
   * Beyond this much silence the answer is simply over: settle back to
   * priming rather than concealing an empty stream indefinitely.
   */
  SPEAKER_CONCEAL_LIMIT_MS = ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS,
  /*
   * Backlog beyond which a frame is skipped to catch up. It must sit ABOVE
   * the standing cushion (600 ms lead + 390 ms prefill), or the device
   * spends every answer deliberately throwing away the margin the bridge
   * just sent it — audible as a tick roughly once a second.
   */
  SPEAKER_HIGH_WATER_MS = ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS,
  /* At most one skipped frame per this many played (1 per second of audio). */
  SPEAKER_CATCHUP_EVERY = ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY,
  /*
   * How long the speaker must stay dry before the amplifier is powered down.
   * Long enough that a network hiccup mid-answer never power-cycles it.
   */
  SPEAKER_IDLE_POWERDOWN_MS = ITERATE_KIT_VOICE_SPEAKER_IDLE_POWERDOWN_MS,
  /* Longest a released turn waits for the uplink before committing anyway. */
  TURN_FLUSH_TIMEOUT_MS = ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS,
  /* Longest a single spoken turn may run before it is closed regardless. */
  TURN_MAX_MS = ITERATE_KIT_VOICE_TURN_MAX_MS,
  /* Control scan cadence; on one board each scan costs an I2C transaction. */
  CONTROL_POLL_MS = ITERATE_KIT_VOICE_CONTROL_POLL_MS,
  STATS_INTERVAL_MS = ITERATE_KIT_VOICE_STATS_INTERVAL_MS,
  /* How long the transport may stay FAILED before the device reboots itself. */
  UNHEALTHY_RESTART_MS = ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS,
  /*
   * With a call wanted there is a live answer coming, so this long without ANY
   * batch on the delivery lane means the lane itself is gone. The remedy is a
   * recycle — one round trip that keeps the call — rather than giving up on it
   * and throwing away a live Grok session.
   *
   * This is now the ONLY application-level liveness deadline the device has.
   * It is also the only one that ever had honest evidence behind it: it fires
   * on silence when traffic is EXPECTED, which is the single condition under
   * which silence means anything at all.
   */
  DOWNLINK_SILENCE_MS = ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS,
  /*
   * Last resort. The transport can be READY, the socket open, and nothing
   * whatsoever moving: a half-open TCP connection looks perfectly healthy
   * from this end. If no probe has completed for this long, no amount of
   * in-process recovery has worked and the chip restarts.
   */
  NO_LIVENESS_RESTART_MS = ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS,
};

/* PSRAM-resident: 256 KiB would crowd internal RAM out of TLS headroom. */
EXT_RAM_BSS_ATTR static uint8_t
    inbox_storage_psram[CONTROL_INBOX_SLOTS][CONTROL_INBOX_SLOT_CAPACITY];
/*
 * PSRAM too. 8 x 8 KiB of internal .bss is memory the TLS handshake and the
 * SPI drivers need — with it in internal RAM, mbedtls_ssl_setup failed with
 * MBEDTLS_ERR_SSL_ALLOC_FAILED and the device could not connect at all. The
 * outbox is never a DMA target: lwIP copies on send.
 */
EXT_RAM_BSS_ATTR static uint8_t
    outbox_storage_psram[CONTROL_OUTBOX_SLOTS][CONTROL_OUTBOX_SLOT_CAPACITY];

/*
 * The stream this device mounts, as a runtime value seeded from the board's
 * `facts->stream_path`.
 *
 * A fresh path per conversation, and mutable. The old shared one accumulated
 * durable events until its Durable Object took ~1s per append — measured
 * against a fresh stream's 72ms — and since every handshake step is one append,
 * the device took 20s to come up and calls felt glacial.
 *
 * Mutable because a compile-time constant is exactly why "start a fresh
 * conversation" could not be expressed: one device, one stream, forever, and
 * every reboot resumed a context that might be days old. The path IS the
 * conversation's identity, so choosing it is choosing whether to continue or
 * begin — no other mechanism is needed.
 *
 * Its per-board DEFAULT, its /agents/voice/ prefix, and the client path beside
 * it are all constants and live in `struct iterate_kit_board_facts`; the notes
 * on why each is what it is went with them.
 */
static char stream_path[96];

/*
 * pdMS_TO_TICKS() truncates, so any wait shorter than one tick becomes zero —
 * and vTaskDelay(0) yields without blocking, which turns a short sleep into a
 * busy spin that can starve the idle task and trip the watchdog. Always wait
 * at least one tick.
 */
#define DELAY_MS(ms) \
  vTaskDelay(pdMS_TO_TICKS(ms) > 0U ? pdMS_TO_TICKS(ms) : 1U)

struct mic_frame {
  int16_t samples[FRAME_SAMPLES];
};

/*
 * A generation is the answer epoch. The consumer can hold a frame while the
 * producer replaces the answer; tagging the copied frame makes that race an
 * exact comparison instead of a byte-count guess over a concurrently-read
 * stream buffer.
 */
struct speaker_frame {
  uint32_t generation;
  int16_t samples[FRAME_SAMPLES];
};

_Static_assert(
    SPEAKER_BUFFER_BYTES % FRAME_BYTES == 0U,
    "speaker capacity must contain whole PCM frames");

static struct {
  /*
   * WHAT THIS BOARD IS. Held rather than passed, because the voicelab
   * callbacks and both audio tasks are reached through function pointers the
   * platform calls with contexts of their own choosing.
   */
  const struct iterate_kit_board_ops *board;
  const struct iterate_kit_board_facts *facts;
  void *board_context;
  /*
   * WHAT THE PERSON IS TOLD, as one value, pushed once per pass.
   *
   * Assembled here and published by `present`. Eight setters used to write
   * this from 48 places; see voice/loop.h for the state that cost.
   */
  struct iterate_kit_voice_view view;
  /*
   * INTENT, which is now the loop's rather than a panel driver's.
   *
   * `view.wants_call` and `view.talk_held` are the two flags a physical
   * control and an RPC both land on, so remote and local control cannot
   * disagree about what the device is doing. `remote_talk` is the RPC half of
   * the second one, kept apart so releasing the button does not cancel a hold
   * an agent is still asking for, and vice versa.
   */
  bool remote_talk;
  /** What the board's controls last said. Edges are consumed once, on the pass
   * that resolves them; `talk_held` is a level and is read every pass. */
  struct iterate_kit_voice_intent intent;
  struct iterate_kit_audio_codec codec;
  struct iterate_kit_audio_processor processor;
  struct iterate_kit_configuration configuration;
  struct iterate_kit_itx_connection connection;
  struct capnweb_pending_call pending_calls[PENDING_CALL_CAPACITY];
  struct capnweb_export exports[EXPORT_CAPACITY];
  struct capnweb_import imports[IMPORT_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  struct iterate_kit_spsc_ring control_inbox;
  struct iterate_kit_spsc_ring control_outbox;
  size_t inbox_lengths[CONTROL_INBOX_SLOTS];
  size_t outbox_lengths[CONTROL_OUTBOX_SLOTS];
  struct iterate_kit_esp_idf_itx_transport transport;
  struct iterate_kit_peer peer;
  /*
   * REMOTE HANDS. This board is the one that gets left on a shelf running a
   * soak, and it was also the only one of the four with NO capabilities at
   * all: it mounted at kit.waveshare and answered nothing, so the only way to
   * ask it anything was its console, which reboots it. Same three as the
   * others now — talk, conversation, health — reaching the same two intent
   * flags the physical buttons set.
   */
  struct iterate_kit_device_event device_event_storage
      [ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY];
  struct iterate_kit_device_event_queue device_events;
  struct iterate_kit_push_to_talk push_to_talk;
  struct iterate_kit_conversation_control conversation_control;
  struct iterate_kit_voicelab voicelab;
  /* The last refusal from start_call, and how many there have been. */
  enum capnweb_status last_start_status;
  /* The launch seam's own answer, so a branch is named not inferred. */
  int last_launch_step;
  uint32_t launch_polls;
  /*
   * What the seam SAW, captured in the same poll as its answer.
   *
   * Reading these separately through health() reads them at different
   * instants, so a latch that is true when health asks and false when the
   * loop asks looks like an impossibility: every input green and the answer
   * still NOTHING. Captured together, the paradox resolves itself.
   */
  bool saw_wants_call;
  bool saw_link_ready;
  uint32_t wants_call_polls;
  uint32_t start_call_failures;
  struct iterate_kit_playout playout;
  uint32_t voicelab_generation;
  uint32_t frame_sequence;
  /*
   * Generous on purpose: a stats line that outgrows this is silently NOT
   * sent (snprintf truncates and the append is skipped), so the instrument
   * would go dark exactly when someone added the counter that explains a
   * bug. The overflow is logged for the same reason.
   */
  /*
   * 2560, not 1536. Nine added fields overflowed it and the device went dark:
   * every downstream reader then sees "no stats", which looks like a broken
   * speaker rather than a full buffer. The guard names the field it stopped at,
   * which is how this was found in one read.
   */
  char stats_buffer[2560];
  uint32_t stats_sequence;
  enum iterate_kit_esp_idf_itx_transport_state last_transport_state;
  enum iterate_kit_voicelab_state last_voicelab_state;
  /* Cross-task audio plumbing. */
  QueueHandle_t mic_queue;
  QueueHandle_t speaker_queue;
  atomic_uint speaker_generation;
  atomic_uint_fast64_t speaker_last_write_ms;
  /*
   * The playback step's two persistent locals. They were locals of a `for(;;)`
   * that never returned; a step returns every pass, so they live here with the
   * rest of the speaker's state. Written only by the playback task.
   */
  struct iterate_kit_voice_playback_clock playout_clock;
  uint64_t last_write_ms;
  uint32_t mic_frames_captured;
  uint32_t mic_frames_dropped;
  uint32_t mic_process_failures;
  /** Captured with no turn open: room noise, never sent, never queued. */
  uint32_t mic_frames_idle;
  uint32_t speaker_frames_played;
  /* Written by both the app producer and playback consumer. */
  atomic_uint speaker_overflow_drops;
  /*
   * Audio removed by the barge-in discard.
   *
   * This was the ONLY path that could delete queued speech without
   * incrementing anything, and that is exactly what it did: 758 frames
   * arrived, 150 played, the ring empty, and every other counter zero. A
   * silent drop path turns a five-minute measurement into an afternoon of
   * theories - two of which were wrong - so it counts now.
   */
  /* Queue-reset accounting is app-owned; in-flight rejection is playback-owned. */
  atomic_uint speaker_discarded_frames;
  /*
   * The two ways the reader can decline to play WITHOUT touching any other
   * counter, and therefore the only remaining blind spots in this loop.
   *
   * `speaker_waits_priming` is ready() saying no: the ring is below the
   * prefill mark. `speaker_waits_dry` is the ring being empty and the clock
   * choosing WAIT over CONCEAL. A stall in either is invisible today - the
   * failing runs show frames arriving with played AND conceal both frozen,
   * which is exactly what these two look like from outside.
   */
  uint32_t speaker_waits_priming;
  uint32_t speaker_waits_dry;
  /*
   * A starve is only a DEFECT if the stream had more to say. The buffer
   * legitimately empties at the end of every answer, and counting that as an
   * underrun made the metric read one per answer no matter how healthy the
   * pipe was — which is exactly the sort of false positive that hides a real
   * one. A starve is promoted to an underrun only when audio resumes soon
   * after it, meaning the answer was still in progress.
   */
  uint32_t speaker_underruns;
  uint32_t speaker_conceal_frames;
  uint32_t speaker_catchup_frames;
  uint32_t speaker_write_failures;
  uint32_t speaker_margin_max_ms;
  atomic_uint_fast64_t starve_at_ms;
  /*
   * Proving "no underruns" needs more than a count of holes: every write
   * records how much audio was still queued behind it, so the minimum over a
   * call says how close the pipe ever came to running dry. A run with a
   * healthy floor is evidence; a zero count alone proves nothing.
   */
  uint32_t speaker_margin_min_ms;
  uint32_t speaker_writes;
  uint32_t speaker_bad_frames;
  uint32_t barge_in_flushes;
  struct iterate_kit_mount_watchdog mount_watchdog;
  /* Connections replaced because nothing was being delivered on them. */
  uint32_t downlink_recycles;
  /* How many of those in a row have not yet produced a batch. */
  uint32_t downlink_recycles_running;
  /* Diagnostics for a frozen device: see the pulse in the app loop. */
  uint32_t loop_count;
  uint64_t last_pulse_ms;
  bool talking;
  /* Release pressed, but the capture queue is not yet on the wire. */
  bool flushing_turn;
  atomic_bool speaker_reprime;
  /**
   * When the current answer's playout began, and how much of it has played.
   *
   * Together these ARE the audio timeline: frame N of an answer should reach
   * the speaker 20N ms after the first one did. The difference between that
   * and the wall clock is how far behind realtime this device is, and it is
   * the only honest measure of "behind" — queue depth is not, because a whole
   * answer legitimately arrives at once and a deep queue then means the
   * sender was fast, not that playback is late.
   *
   * Needs no clock agreement with the server: both terms are local, and the
   * answer's own first frame is the origin.
   */
  atomic_uint_fast64_t answer_started_ms;
  atomic_uint answer_emitted_ms;
  /** When an RPC was last answered: the mount's own liveness, not the socket's. */
  uint32_t speaker_lag_max_ms;
  atomic_bool speaker_answer_done;
  /*
   * The SENDER said this answer is complete, latched until the speaker actually
   * drains it. `speaker_answer_done` is consumed by the playback clock the
   * moment it is seen, long before the buffer empties, so it cannot answer
   * "has this answer finished being heard?" — and that question is the whole
   * difference between an answer that ended and an answer that was cut off.
   */
  atomic_bool answer_declared_done;
  uint32_t turn_marker_failures;
  uint32_t flush_frames_left;
  uint64_t flush_deadline_ms;
  uint64_t turn_started_ms;
} runtime;

/*
 * THE BOARD, OR NOTHING.
 *
 * Every op below `start` and `present` is optional — a NULL pointer is a board
 * saying it has no such hardware. Funnelling the checks through four one-line
 * thunks keeps that fact in one place instead of at each of the ~110 call sites
 * the four device files used to spread it over.
 */
static void board_phase(enum iterate_kit_voice_phase phase) {
  if (runtime.board->phase != NULL) {
    runtime.board->phase(runtime.board_context, phase);
  }
}

static void board_answer(const struct iterate_kit_voice_answer_note *note) {
  if (runtime.board->observe_answer != NULL) {
    runtime.board->observe_answer(runtime.board_context, note);
  }
}

/*
 * MOVE THE HALF-DUPLEX FENCE, or do nothing on a board that has none.
 *
 * On the one board that is half duplex the ES8311's ADC and DAC share
 * MCLK/BCLK/WS, so capture requires DELETING the playback channel: the
 * microphone physically cannot run while the speaker does. Asynchronous —
 * `playout_fenced_out` is how the playback step learns the fence has settled.
 *
 * The SEQUENCING is the loop's and stays below, because it is policy and not a
 * driver: the pins are taken only after the turn marker is on the wire AND the
 * speaker queue has been emptied, and they are given back at the RELEASE edge
 * rather than at the commit, so the answer can play the moment it arrives.
 */
static void board_fence(bool microphone_owns_pins) {
  if (runtime.board->capture_fence != NULL) {
    runtime.board->capture_fence(runtime.board_context, microphone_owns_pins);
  }
}

static void board_playout(const int16_t *pcm, size_t samples) {
  if (runtime.board->observe_playout != NULL) {
    runtime.board->observe_playout(runtime.board_context, pcm, samples);
  }
}

/*
 * Show the current view. Unconditional, once per app-loop pass: the board
 * decides whether anything changed, under the one lock it already holds, which
 * is cheaper than the nine lock round trips the setters cost.
 */
static void present(void) {
  runtime.board->present(runtime.board_context, &runtime.view);
}

static uint32_t speaker_queued_bytes(void) {
  if (runtime.speaker_queue == NULL) return 0U;
  return (uint32_t)uxQueueMessagesWaiting(runtime.speaker_queue) * FRAME_BYTES;
}

/*
 * The two strings that describe this device to whoever holds the capability
 * are `facts->instructions` and `facts->peer_description`. They are per-board
 * prose — one board says "the upper button is push-to-talk", another says
 * "speak whenever you like" — and voice/loop.h records which of the two a
 * model actually reads, which is not the one you would guess.
 */

static void on_session_ended(void *context) {
  (void)context;
  runtime.voicelab.state = ITERATE_KIT_VOICELAB_FAILED;
  runtime.voicelab.failure = ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED;
  runtime.voicelab.has_session_capability = false;
  runtime.voicelab.has_project_capability = false;
  runtime.voicelab.has_stream_capability = false;
  runtime.voicelab.has_connection_capability = false;
  runtime.voicelab.has_previous_connection_capability = false;
  runtime.voicelab.has_callback_capability = false;
  runtime.voicelab_generation = 0U;
}

static uint64_t now_ms(void *context) {
  (void)context;
  return (uint64_t)(esp_timer_get_time() / 1000);
}

static bool publish_turn_marker(enum iterate_kit_voicelab_turn turn) {
  const enum capnweb_status status =
      iterate_kit_voicelab_mark_turn(&runtime.voicelab, turn);
  if (status == CAPNWEB_OK) return true;

  ++runtime.turn_marker_failures;
  ESP_LOGE(
      tag,
      "turn %s publication failed: capnweb=%d; replacing transport",
      turn == ITERATE_KIT_VOICELAB_TURN_START ? "start" : "commit",
      (int)status);
  /*
   * The bridge cannot infer a missing edge. Invalidate the producer gate now,
   * then remount on a fresh session rather than sending audio whose turn state
   * is ambiguous or pretending a commit succeeded.
   */
  runtime.voicelab_generation = 0U;
  iterate_kit_esp_idf_itx_transport_request_restart(&runtime.transport);
  runtime.view.status = ("reconnecting");
  return false;
}

/* --- speaker path (voicelab callbacks run on the app task) ---------------- */

static void on_speaker_pcm(
    void *context,
    const uint8_t *pcm,
    size_t pcm_length,
    const struct iterate_kit_playout_frame *identity) {
  static struct speaker_frame frame;
  enum iterate_kit_playout_action action;
  (void)context;
  /*
   * A frame goes in whole or not at all. A partial write splices the head of
   * one frame onto the next at an arbitrary phase, which is a click — and at
   * a full buffer that happens to EVERY frame. An odd length would shift the
   * 16-bit sample grid permanently, so it is refused outright.
   */
  if (pcm_length != FRAME_BYTES || identity == NULL) {
    ++runtime.speaker_bad_frames;
    return;
  }
  action = iterate_kit_playout_classify(&runtime.playout, identity);
  if (action == ITERATE_KIT_PLAYOUT_IGNORE) return;
  if (action == ITERATE_KIT_PLAYOUT_REPLACE) {
    /* Ordering-safe: the watch comes off before the audio does. */
    (void)abandon_speaker_audio();
    /*
     * WE ARE ABOUT TO ABANDON AUDIO, SO SAY SO NOW.
     *
     * Disarmed here rather than in the speaker task's reprime branch, because
     * the flush happens on THIS task while the speaker task is blocked in its
     * 60ms receive with the watch still armed. The ring plays out the last 90ms
     * of the abandoned answer and then goes dry waiting for the replacement's
     * first frame — and that gap was landing in the DMA ledger deficit at send index 164:
     * deep into feeding, nowhere near an opening, and only ever on a barge-in.
     *
     * The gap is real and the listener hears it. It is also entirely ours and
     * entirely intended, which is the whole difference from starvation.
     */
    /* A new answer is a new timeline: lag does not carry across answers. */
    atomic_store_explicit(
        &runtime.answer_started_ms, 0U, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_emitted_ms, 0U, memory_order_release);
  }
  if (uxQueueSpacesAvailable(runtime.speaker_queue) == 0U) {
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
    return;
  }
  /*
   * Power the amplifier the moment audio ARRIVES, not when the first sample
   * is written. A class-D amp needs tens of milliseconds to settle, and
   * raising it two milliseconds before the first write meant the opening of
   * every answer played into an amp that was not up yet — heard as the first
   * half-word being clipped or missing. Enabling it here spends the playout
   * prefill (160 ms) as settle time, which costs nothing.
   */
  board_phase(ITERATE_KIT_VOICE_PHASE_ARRIVED);
  atomic_store_explicit(
      &runtime.speaker_answer_done, false, memory_order_release);
  /*
   * SPEAKING FOLLOWS THE AUDIO, not a transcript.
   *
   * This used to be set from `on_transcript`, which meant the face and the
   * lights announced the answer when its TEXT arrived. Text and audio are
   * separate event streams and routinely arrive out of order, so the screen
   * could say "speaking" before a sample had played, or stay on the previous
   * state through the first words. Clients no longer receive transcripts at
   * all; a frame the playout accepted is the honest signal, and the setter
   * is idempotent so paying for it per frame costs one compare.
   */
  runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_SPEAKING;
  /*
   * Audio arriving within a second of a starve means the answer was still
   * going: the pipe genuinely ran dry mid-speech, and that is audible.
   */
  {
    const uint64_t starved_at = atomic_exchange_explicit(
        &runtime.starve_at_ms, 0U, memory_order_acq_rel);
    const uint64_t now = now_ms(NULL);
    if (starved_at != 0U &&
        iterate_kit_voice_elapsed_ms(now, starved_at) < 1000U) {
      ++runtime.speaker_underruns;
    }
  }
  frame.generation = atomic_load_explicit(
      &runtime.speaker_generation, memory_order_acquire);
  memcpy(frame.samples, pcm, sizeof(frame.samples));
  if (xQueueSend(runtime.speaker_queue, &frame, 0) != pdTRUE) {
    /* Only this task writes, but retain an exact signal if that invariant drifts. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
    return;
  }
  /* Counted only for frames actually admitted: the viseme ledger must see
   * exactly the samples the analyzer will eventually be fed. */
  {
    const struct iterate_kit_voice_answer_note note = {
      .kind = ITERATE_KIT_VOICE_ANSWER_ADMITTED,
      .answer = identity->answer,
      .sample_count = pcm_length / 2U,
    };
    board_answer(&note);
  }
}

/*
 * ONE FUNNEL FOR THROWING QUEUED SPEAKER AUDIO AWAY.
 *
 * Five sites used to do this by hand — barge-in, a superseded answer, a call
 * accepted, the bridge hanging up, a new turn's flush — in three different
 * orders. Two disarmed the starvation watch AFTER taking the audio away, two
 * never disarmed at all, and one was right. On 2026-08-04 the wrong ordering
 * cost the acceptance run at 5/10: the bridge had raced 13,020ms ahead, the
 * hang-up arrived with the ring that deep, and `spkStarveEvents` — the
 * never-tier gate — recorded a starvation the device had caused on purpose.
 *
 * Keep these five effects together. The ordering is the correctness proof:
 * disarm -> note flush -> invalidate -> discard -> reprime. In particular,
 * invalidating before disarming creates a window in which an intentional cut
 * is counted as listener-visible starvation. ESP-IDF 5.4.2's
 * FreeRTOS-Kernel-SMP/queue.c:xQueueGenericReset holds the queue lock and leaves
 * blocked receivers waiting when an existing queue is reset. A frame copied
 * before that lock was taken is rejected by generation.
 */
static uint32_t abandon_speaker_audio(void) {
  board_phase(ITERATE_KIT_VOICE_PHASE_FLUSHED);
  const uint32_t bytes = speaker_queued_bytes();
  (void)atomic_fetch_add_explicit(
      &runtime.speaker_generation, 1U, memory_order_acq_rel);
  (void)xQueueReset(runtime.speaker_queue);
  (void)atomic_fetch_add_explicit(
      &runtime.speaker_discarded_frames,
      bytes / FRAME_BYTES,
      memory_order_relaxed);
  atomic_store_explicit(
      &runtime.speaker_reprime, true, memory_order_release);
  /*
   * The face was animating this audio and must forget what nobody will hear,
   * and the mouth track scheduled against it dies with it. One note for both,
   * because they have to be serialized against the ADMITTED notes above — all
   * abandon sites run on the app task, which is what the viseme ledger
   * requires.
   */
  {
    const struct iterate_kit_voice_answer_note note = {
      .kind = ITERATE_KIT_VOICE_ANSWER_ABANDONED,
    };
    board_answer(&note);
  }
  return bytes;
}

static void on_control(
    void *context, enum iterate_kit_voicelab_control control) {
  (void)context;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    /* With manual turns this only fires if something re-enables VAD, but
     * flushing playback on it is still the right response. */
    /* Barge-in: atomically invalidate and reset every queued frame. */
    /* Ordering-safe: the watch comes off before the audio does. */
    (void)abandon_speaker_audio();
    /*
     * WE ARE ABOUT TO ABANDON AUDIO, SO SAY SO NOW.
     *
     * Disarmed here rather than in the speaker task's reprime branch, because
     * the flush happens on THIS task while the speaker task is blocked in its
     * 60ms receive with the watch still armed. The ring plays out the last 90ms
     * of the abandoned answer and then goes dry waiting for the replacement's
     * first frame — and that gap was landing in the DMA ledger deficit at send index 164:
     * deep into feeding, nowhere near an opening, and only ever on a barge-in.
     *
     * The gap is real and the listener hears it. It is also entirely ours and
     * entirely intended, which is the whole difference from starvation.
     */
    iterate_kit_playout_interrupt(&runtime.playout);
    ++runtime.barge_in_flushes;
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_LISTENING;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    /*
     * The answer is finished, so a dry buffer from here is not a deficit —
     * it is simply the end. Telling playback that keeps concealment meaning
     * "audio failed to arrive in time", which is the only reading worth
     * having: without it every answer contributed a settle window's worth of
     * concealed frames and the metric could never reach zero.
     */
    atomic_store_explicit(
        &runtime.speaker_answer_done, true, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_declared_done, true, memory_order_release);
    /*
     * It must NOT interrupt the playout, however tempting "the answer is
     * over, reset for the next one" looks. `response.done` is one small text
     * event and the answer is hundreds of large audio events, all sent as
     * fast as the wire takes them, so the completion routinely arrives
     * FIRST. Interrupting here marks the answer abandoned and every frame of
     * it that follows is refused as stale.
     *
     * Measured on the device: 258 frames received, none played, and a
     * transcript proving the model had spoken. The next answer carries a
     * higher number and supersedes this one by itself; there is nothing to
     * reset.
     */
    /* The answer is complete: back to waiting for the next turn. */
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
    runtime.view.status = runtime.facts->talk_hint;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    /*
     * A NEW CALL IS A NEW SENDER. RESET THE PLAYOUT, HERE.
     *
     * Answer and frame numbers restart with every call, so a second call on the
     * same mount opens numerically BEHIND wherever the last one finished, and
     * the classifier correctly refuses those frames as duplicates. Measured on
     * the first turn of a fresh call: 539 of 583 delivered frames never reached
     * the speaker — 330 refused as duplicates, 209 skipped as catch-up — 10.78s
     * of an answer nobody heard.
     *
     * THIS is the place, not the app loop's display observation where it was
     * first written: that runs later and could easily follow the first audio
     * frame of the new call, classifying it against stale state before the reset
     * landed. This branch is the stream's own conversation-accepted, on the same
     * serialized receive path that classifies frames — so the reset provably
     * precedes every frame of the call it belongs to, and cannot race the
     * classifier because they are the same task.
     */
    iterate_kit_playout_reset(&runtime.playout, 1U);
    (void)abandon_speaker_audio();
    atomic_store_explicit(
        &runtime.speaker_answer_done, false, memory_order_release);
    atomic_store_explicit(
        &runtime.answer_declared_done, false, memory_order_release);
    ESP_LOGI(tag, "new call accepted: playout reset for a fresh sender");
    runtime.view.call_active = (true);
    /* The viseme lane owns the mouth for the duration of the call. */
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
    runtime.view.status = runtime.facts->talk_hint;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    /*
     * Drop whatever is still queued. The ring holds thirty seconds, so a call
     * that ends mid-answer otherwise plays the dead conversation out after
     * the screen has already said it is over.
     *
     * AND STOP MEASURING FIRST. Abandoning queued audio is the device's own
     * decision, so the starvation detector must be disarmed before the source
     * goes away — otherwise the audio-empty deadline it is holding passes with
     * nothing more written, and a deliberate abandon is recorded as a real
     * starve event. Every other discard site pairs these three lines; this one
     * did not, and it survived by luck: the local hang-up path usually drains
     * first. Measured on 2026-08-04, session 5 turn 7 of the acceptance run —
     * the bridge had raced 13,020ms of audio ahead of realtime, so CALL_ENDED
     * arrived with the ring still deep, and `spkStarveEvents` moved by 1.
     */
    (void)abandon_speaker_audio();
    /*
     * The BELIEF ends here; the INTENT does not.
     *
     * This used to clear the call request too, on the reasoning that the
     * button should agree with reality. But the bridge ends a call for
     * reasons that have nothing to do with what the person wants — the
     * provider closing its socket, an eviction, an idle timeout — and
     * clearing the request turned every one of those into "your call is
     * over, press the button again". Measured: the provider closed at 296s
     * into an hour-long soak and the device sat there for the remaining 55
     * minutes with wantsCall false, answering RPCs, waiting to be pressed.
     *
     * Intent is owned locally and only a person changes it: hanging up sets
     * it false BEFORE announcing the end, so the bridge's echo arrives to a
     * device that already agrees. Anything else is a call to reopen.
     */
    runtime.view.call_active = (false);
    /* Envelope mouth returns for whatever local life the face has next. */
    runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
    runtime.view.status = (runtime.view.wants_call ? "reconnecting" : "call ended");
  }
}

static bool playback_apply_reprime(
    struct iterate_kit_voice_playback_clock *playout_clock) {
  if (!atomic_exchange_explicit(
          &runtime.speaker_reprime, false, memory_order_acq_rel)) {
    return false;
  }
  atomic_store_explicit(
      &runtime.speaker_answer_done, false, memory_order_release);
  atomic_store_explicit(
      &runtime.answer_declared_done, false, memory_order_release);
  /*
   * abandon_speaker_audio() already disarmed and accounted for the hardware
   * flush before publishing speaker_reprime. This task owns only the portable
   * playout clock, so it resets that clock exactly once for the new epoch.
   */
  iterate_kit_voice_playback_clock_reprime(playout_clock);
  return true;
}

/*
 * ONE PASS OF THE SPEAKER, so that it is a function rather than a `for(;;)`.
 *
 * A step can be called, and therefore tested, and therefore driven by a host
 * that has one thread where a board has three. Nothing else about it changed:
 * every `continue` in the body below became a `return`, and the two locals
 * that had to survive an iteration — the playout clock and the last write —
 * moved into the runtime beside the state they already describe.
 */
void iterate_kit_voice_loop_playback_step(void) {
  static struct speaker_frame frame;
  /*
   * The writer NEVER stops. That is the whole design.
   *
   * It used to stop on an empty read and wait to re-buy a cushion — and the
   * cushion it waited for (40 ms) was SMALLER THAN THE DMA RING IT HAD JUST
   * LET RUN DRY (90 ms). So every recovery under-filled the hardware and
   * immediately starved again: one network hiccup produced a train of holes,
   * which is why the rate never went to zero however large the buffers grew.
   *
   * The answer to that was to write silence on an empty read, and it was the
   * wrong one: silence occupies playout time and cannot be taken back, so
   * every frame of it puts the rest of the answer permanently further behind.
   * The right answer, and the one three reference implementations use, is to
   * wait long enough that a late frame is absorbed by the hardware cushion
   * rather than concealed — see the read and the dry branch below.
   */
  size_t received;

  /*
   * FENCED OUT. While the microphone owns the shared pins — or the fence is
   * moving in either direction — this step must not pull frames it can only
   * fail to write. Frames stay queued; the fence drops within milliseconds of
   * the turn committing, long before an answer.
   */
  if (runtime.board->playout_fenced_out != NULL &&
      runtime.board->playout_fenced_out(runtime.board_context)) {
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    DELAY_MS(5);
    return;
  }

  (void)playback_apply_reprime(&runtime.playout_clock);
  if (atomic_exchange_explicit(
          &runtime.speaker_answer_done, false, memory_order_acq_rel)) {
    iterate_kit_voice_playback_clock_answer_done(&runtime.playout_clock);
  }
  if (!iterate_kit_voice_playback_clock_ready(
          &runtime.playout_clock, speaker_queued_bytes())) {
    /*
     * NOT FEEDING, SO NOT WATCHING.
     *
     * The watch means "we are handing the DAC audio right now". This branch
     * decides not to, while the clock builds its prefill — and leaving the
     * watch armed across it made the DAC's correct silence read as
     * starvation at every boundary that re-primes: a cold first turn, a turn
     * after idle, the refill after a barge-in, and teardown. That was the
     * whole of the systematic DMA ledger deficits, and it is one missing disarm
     * rather than four separate causes.
     */
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    ++runtime.speaker_waits_priming;
    /* Idle, not starving: nothing is playing, so write nothing. */
    if (runtime.last_write_ms != 0U &&
        iterate_kit_voice_elapsed_ms(now_ms(NULL), runtime.last_write_ms) > SPEAKER_IDLE_POWERDOWN_MS) {
      board_phase(ITERATE_KIT_VOICE_PHASE_QUIET);
    }
    DELAY_MS(5);
    return;
  }

  /*
   * WAIT AS LONG AS THE HARDWARE CUSHION ALLOWS.
   *
   * This was 20 ms — one frame — against a 90 ms I2S DMA ring, which made
   * this the least patient playout loop of any comparable firmware by a
   * factor of two to infinity (ESPHome waits half its DMA depth; esp-adf
   * waits 225 ms against 58.5 ms; xiaozhi-esp32 blocks indefinitely).
   *
   * The impatience was invisible because of where it is measured. By the
   * time this call is reached, the preceding esp_codec_dev_write has
   * returned — and it returns only once i2s_channel_write has copied into
   * the DMA descriptors, back-pressured by the driver's free-buffer queue.
   * So at the instant this loop declares itself "dry", roughly 60 ms of
   * real audio is still queued and the DAC is in no danger at all. Waiting
   * is free; splicing silence is not, because silence written into the ring
   * occupies playout time and can never be taken back.
   *
   * Two thirds of the cushion, so a late frame is absorbed rather than
   * concealed, while the remaining third still bounds how long this task
   * can sit before the ring genuinely empties.
   */
  /*
   * ARMED ACROSS THE WAIT UNLESS THE ANSWER IS OVER.
   *
   * The window that matters is between one frame and the next: the ring holds
   * 90ms, this receive blocks for up to 60ms, and if the source fails to
   * deliver inside that the DAC really does run dry and the listener really
   * does hear it. So the watch stays ARMED across the wait — disarming here
   * unconditionally (which I tried) makes every inter-feed gap invisible and
   * buys a clean run by blinding the detector.
   *
   * The one case where a dry ring is legitimate is an answer that is OVER:
   * the sender said `response.done` and the tail is draining. That is exactly
   * `answer_declared_done`, latched until the drain completes, so it is the
   * only condition that disarms.
   *
   * Arming happens at the write. Between a write and the next one the watch is
   * on; past a declared end it is off; during priming, a reprime flush or a
   * fully skipped frame it is off because we are deliberately not feeding.
   */
  if (atomic_load_explicit(
          &runtime.answer_declared_done, memory_order_acquire)) {
    board_phase(ITERATE_KIT_VOICE_PHASE_DRAINING);
  }
  received = xQueueReceive(
                 runtime.speaker_queue,
                 &frame,
                 pdMS_TO_TICKS(runtime.facts->speaker_dry_wait_ms)) ==
                     pdTRUE
      ? FRAME_BYTES
      : 0U;

  /*
   * A REPRIME REQUESTED WHILE WE WERE BLOCKED STILL COUNTS.
   *
   * The receive above waits up to 60 ms, and a new answer's first frame
   * routinely arrives inside that window — REPLACE sets speaker_reprime and
   * pushes the frame, and this loop then wakes holding it. Checking the
   * flag only at the top of the loop played that frame with priming already
   * cancelled, so ~20 ms of the first phoneme escaped, the reprime was
   * honoured on the NEXT iteration, and the rest of the answer waited out a
   * full prefill behind it. That is the clipped first word.
   */
  if (received > 0U && playback_apply_reprime(&runtime.playout_clock)) {
    /*
     * A replacement can wake the blocked receive with its first frame. Put
     * that whole tagged frame back at the head so opening prefill includes
     * it. If another replacement raced this one, its generation is already
     * stale and it must not be reintroduced after the newer queue reset.
     */
    if (frame.generation == atomic_load_explicit(
                                &runtime.speaker_generation,
                                memory_order_acquire)) {
      if (xQueueSendToFront(runtime.speaker_queue, &frame, 0) != pdTRUE) {
        (void)atomic_fetch_add_explicit(
            &runtime.speaker_overflow_drops, 1U, memory_order_relaxed);
      }
    } else {
      (void)atomic_fetch_add_explicit(
          &runtime.speaker_discarded_frames, 1U, memory_order_relaxed);
    }
    return;
  }

  if (received == 0U) {
    /*
     * DRY. WRITE NOTHING AND COME BACK.
     *
     * This used to splice a frame of silence into the DMA ring, on the
     * theory that a ring kept topped up cannot starve the DAC. That has it
     * backwards. Silence written into the ring is indistinguishable from
     * audio: it occupies playout time, can never be taken back, and so
     * PERMANENTLY puts the rest of the answer 20 ms further behind. Do it
     * 149 times in one answer — measured — and the listener hears three
     * seconds of chopping, while every frame that ever arrived is still
     * faithfully played, just late and in pieces.
     *
     * Not writing costs nothing, because the ring is not empty when this
     * branch is reached: the preceding write returned only once the driver
     * had copied into the DMA descriptors, so tens of milliseconds of real
     * audio are still queued and the DAC is in no danger. And an actually
     * empty ring already clocks out clean zeros — auto_clear is set — so
     * concealment was never buying the silence it claimed to provide.
     *
     * This is what xiaozhi-esp32, ESPHome's speaker and esp-adf all do:
     * when the source is dry, stop calling write. None of them conceals.
     */
    /* Nothing to play: the zeros the DAC now sends are correct. */
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    /*
     * The answer has finished being HEARD — but ONLY if the sender had
     * already declared it complete.
     *
     * A dry buffer mid-answer is starvation, not an ending, and clearing the
     * flag for it would forgive a supersede that really did cut a live answer
     * off. Both facts are required: `response.done` arrived (latched in
     * answer_declared_done) AND there is nothing left to play.
     */
    if (atomic_load_explicit(
            &runtime.answer_declared_done, memory_order_acquire)) {
      iterate_kit_playout_mark_drained(&runtime.playout);
    }
    ++runtime.speaker_waits_dry;
    if (iterate_kit_voice_playback_clock_empty(
            &runtime.playout_clock, now_ms(NULL)) ==
        ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) {
      /* Kept as telemetry: how often the source could not keep up. It no
       * longer costs the listener anything. */
      ++runtime.speaker_conceal_frames;
      atomic_store_explicit(
          &runtime.starve_at_ms, now_ms(NULL), memory_order_release);
    }
    return;
  }

  if (frame.generation != atomic_load_explicit(
                              &runtime.speaker_generation,
                              memory_order_acquire)) {
    /* A replacement raced this frame after it left the synchronized queue. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_discarded_frames, 1U, memory_order_relaxed);
    board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
    return;
  }

  /*
   * Flooded: skip this frame to catch up.
   *
   * The bridge paces off its own wall clock and the device consumes off
   * the I2S clock; the two are independent, so a small rate difference
   * accumulates without bound. Left alone the buffer fills and frames are
   * discarded ON ARRIVAL — which punches a hole in the middle of speech.
   * Dropping one 20ms frame here instead, only when there is most of a
   * second of backlog, is the same total loss placed where it is least
   * audible, and it bounds playout latency as a side effect.
   *
   * This is the symmetric counterpart to concealment: conceal when
   * starved, skip when flooded, and count both honestly.
   */
  {
    const enum iterate_kit_voice_playback_action action =
        iterate_kit_voice_playback_clock_frame(
            &runtime.playout_clock,
            speaker_queued_bytes(),
            runtime.speaker_frames_played,
            iterate_kit_voice_playout_lag_ms(
                atomic_load_explicit(
                    &runtime.answer_started_ms, memory_order_acquire),
                atomic_load_explicit(
                    &runtime.answer_emitted_ms, memory_order_acquire),
                now_ms(NULL)),
            now_ms(NULL));
    if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP) {
      /*
       * A SKIPPED FRAME STILL SPENT ITS PLACE IN THE TIMELINE.
       *
       * Skipping recovers lag only if the timeline advances as the frame is
       * discarded. Leave the counter alone and the computed lag never
       * falls, so the loop keeps deciding it is late and skips again — it
       * drains the whole backlog and the listener hears half the answer
       * missing. Measured exactly that: 78 of 162 frames skipped.
       *
       * Advancing here is what makes "skip until level" terminate at the
       * point it is level, which is the entire safety of the mechanism.
       */
      ++runtime.speaker_catchup_frames;
      (void)atomic_fetch_add_explicit(
          &runtime.answer_emitted_ms,
          (uint32_t)(received / (FRAME_BYTES / FRAME_MS)),
          memory_order_acq_rel);
      return;
    }
  }

  const uint64_t write_started_ms = now_ms(NULL);
  board_phase(ITERATE_KIT_VOICE_PHASE_FEEDING);
  /*
   * Admission is nonblocking. The hardware-owner task reserves the DMA
   * ledger immediately before its blocking write; this task waits at most
   * five frame periods for bounded queue headroom and keeps running the
   * stream protocol independently of the codec driver's pacing.
   */
  enum iterate_kit_status write_status;
  const uint64_t write_deadline_ms = now_ms(NULL) + 100U;
  do {
    if (atomic_load_explicit(
            &runtime.speaker_reprime, memory_order_acquire) ||
        frame.generation != atomic_load_explicit(
                                &runtime.speaker_generation,
                                memory_order_acquire)) {
      /* A replacement answer arrived while this stale frame waited. */
      write_status = ITERATE_KIT_UNAVAILABLE;
      break;
    }
    write_status = iterate_kit_audio_codec_write(
        &runtime.codec, frame.samples, received / 2U);
    if (write_status == ITERATE_KIT_BACKPRESSURE) {
      DELAY_MS(1);
    }
  } while (write_status == ITERATE_KIT_BACKPRESSURE &&
           now_ms(NULL) < write_deadline_ms);

  if (write_status == ITERATE_KIT_OK) {
    ++runtime.speaker_frames_played;
    /*
     * The mouth, from audio the DAC has accepted rather than audio that
     * arrived. This is the only place on the device where those two are the
     * same thing, which is why the tap is here and not on the receive path:
     * see waveshare_avatar.h for what the delay line does with it.
     */
    board_playout(frame.samples, received / 2U);
    /*
     * HOW FAR BEHIND REALTIME THIS ANSWER HAS FALLEN.
     *
     * Frame N of an answer belongs 20N ms after the first one played. The
     * gap between that and the wall clock is lag, and it only grows when
     * playback stalls — never from the sender running ahead, which is why
     * this is measured against the audio timeline rather than queue depth.
     *
     * Recorded rather than acted on. Paying it back means deleting speech,
     * and this device has already shipped one mechanism that did exactly
     * that; the number has to exist before anyone can argue about whether
     * being late is worse than being clipped.
     */
    {
      /*
       * STAMPED BEFORE THE WRITE, NOT AFTER.
       *
       * codec admission may wait for bounded queue headroom. Stamping after
       * that wait folds hardware pacing into the measurement,
       * so a perfectly punctual loop reports itself progressively later and
       * the catch-up rule then deletes speech to fix a delay that only
       * existed in the metric. Measured that way: 1089 ms of "lag" while
       * the ring held 1620 ms of audio, which is the signature of a
       * consumer that is keeping up.
       */
      const uint64_t played_at = write_started_ms;
      uint64_t answer_started = atomic_load_explicit(
          &runtime.answer_started_ms, memory_order_acquire);
      if (answer_started == 0U) {
        atomic_store_explicit(
            &runtime.answer_started_ms, played_at, memory_order_release);
        atomic_store_explicit(
            &runtime.answer_emitted_ms, 0U, memory_order_release);
        answer_started = played_at;
      }
      {
        const uint32_t lag = iterate_kit_voice_playout_lag_ms(
            answer_started,
            atomic_load_explicit(
                &runtime.answer_emitted_ms, memory_order_acquire),
            played_at);
        if (lag > runtime.speaker_lag_max_ms) {
          runtime.speaker_lag_max_ms = lag;
        }
      }
      /* Milliseconds actually emitted, so a short read advances the
       * timeline by what it played and not by a whole frame. */
      (void)atomic_fetch_add_explicit(
          &runtime.answer_emitted_ms,
          (uint32_t)(received / (FRAME_BYTES / FRAME_MS)),
          memory_order_acq_rel);
    }
  } else if (write_status == ITERATE_KIT_UNAVAILABLE &&
             atomic_load_explicit(
                 &runtime.speaker_reprime, memory_order_acquire)) {
    /* Intentional replacement, not a codec failure. */
    (void)atomic_fetch_add_explicit(
        &runtime.speaker_discarded_frames,
        (uint32_t)(received / (FRAME_SAMPLES * sizeof(int16_t))),
        memory_order_relaxed);
  } else {
    /* The bounded hardware path did not admit this frame. */
    ++runtime.speaker_write_failures;
  }

  {
    const uint32_t margin_ms = speaker_queued_bytes() / 32U;
    ++runtime.speaker_writes;
    if (runtime.speaker_writes == 1U ||
        margin_ms < runtime.speaker_margin_min_ms) {
      runtime.speaker_margin_min_ms = margin_ms;
    }
    if (margin_ms > runtime.speaker_margin_max_ms) {
      runtime.speaker_margin_max_ms = margin_ms;
    }
  }
  runtime.last_write_ms = now_ms(NULL);
  atomic_store_explicit(
    &runtime.speaker_last_write_ms, runtime.last_write_ms,
    memory_order_release);
}

/* --- microphone path ------------------------------------------------------ */

/** One pass of the microphone. See the note on the playback step. */
void iterate_kit_voice_loop_capture_step(void) {
  static struct mic_frame near_frame;
  static struct mic_frame processed_frame;
  size_t sample_count = 0U;
  const enum iterate_kit_status read_status = iterate_kit_audio_codec_read(
      &runtime.codec,
      near_frame.samples,
      NULL,
      FRAME_SAMPLES,
      &sample_count);
  if (read_status == ITERATE_KIT_UNAVAILABLE) {
    DELAY_MS(1);
    return;
  }
  if (read_status != ITERATE_KIT_OK || sample_count != FRAME_SAMPLES) {
    ++runtime.mic_process_failures;
    DELAY_MS(1);
    return;
  }
  const struct iterate_kit_audio_processor_frame process_frame = {
    .near = near_frame.samples,
    .reference = NULL,
    .playout_activity = NULL,
    .output = processed_frame.samples,
    .sample_count = sample_count,
  };
  if (iterate_kit_audio_processor_process(
          &runtime.processor, &process_frame) != ITERATE_KIT_OK) {
    /* The wrapper silences output; fail closed and transmit nothing. */
    ++runtime.mic_process_failures;
    return;
  }
  ++runtime.mic_frames_captured;
  /*
   * NOBODY IS LISTENING, SO DO NOT QUEUE.
   *
   * Capture runs continuously — the codec is full duplex and stopping it
   * between turns costs a settle on every press — but frames only LEAVE the
   * queue while a turn is open. Queueing regardless filled it within a
   * second of boot and then churned it forever: 7941 of 8804 frames
   * "dropped" in one session, none of which was speech anybody said.
   *
   * The number mattered more than the wasted work. A drop counter at 90%
   * is indistinguishable from a device losing the customer's words, so the
   * one measurement that would show a real uplink fault was buried in room
   * noise nobody wanted.
   *
   * Frames captured while idle are counted and discarded here, without
   * touching the queue, so the queue holds only what a turn will send.
   */
  if (!runtime.talking) {
    ++runtime.mic_frames_idle;
    return;
  }
  if (xQueueSend(runtime.mic_queue, &processed_frame, 0) != pdTRUE) {
    /* Freshest wins: discard the OLDEST frame, keep this one. Stale
     * speech after a network hiccup is worse than a gap — and it is the
     * only way a backlog can never delay what the customer says next. */
    struct mic_frame discarded;
    (void)xQueueReceive(runtime.mic_queue, &discarded, 0);
  (void)xQueueSend(runtime.mic_queue, &processed_frame, 0);
  ++runtime.mic_frames_dropped;
  }
}

static void playback_task(void *argument) {
  (void)argument;
  for (;;) iterate_kit_voice_loop_playback_step();
}

static void capture_task(void *argument) {
  (void)argument;
  for (;;) iterate_kit_voice_loop_capture_step();
}

/* --- boot wiring ----------------------------------------------------------- */

static bool initialise_rings(void) {
  return iterate_kit_spsc_ring_init(
             &runtime.control_inbox,
             inbox_storage_psram,
             CONTROL_INBOX_SLOT_CAPACITY,
             CONTROL_INBOX_SLOTS,
             runtime.inbox_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &runtime.control_outbox,
             outbox_storage_psram,
             CONTROL_OUTBOX_SLOT_CAPACITY,
             CONTROL_OUTBOX_SLOTS,
             runtime.outbox_lengths) == ITERATE_KIT_OK;
}

/*
 * One intent path for both sources, exactly as the app loop already assumes:
 * an RPC lands on the same two display-owned flags a physical button sets, so
 * remote and local control cannot disagree about what the device is doing.
 */
static enum iterate_kit_status handle_device_event(
    void *context, const struct iterate_kit_device_event *event) {
  (void)context;
  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
      runtime.remote_talk = (true);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      runtime.remote_talk = (false);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
      runtime.view.wants_call = (true);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      runtime.view.wants_call = (false);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      break;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

/* Defined beside health_json, which it adapts. */
static size_t render_health(void *context, char *out, size_t capacity);


static bool initialise_connection(void) {
  /*
   * Four shared (push-to-talk, conversation control, speaker, health) plus
   * whatever the board has of its own: an AEC stage, servos, a camera, a screen
   * to fill. The busiest board mounts seven.
   */
  static struct iterate_kit_module modules[12];
  static struct iterate_kit_speaker speaker;
  static struct iterate_kit_health health;
  size_t module_count = 0U;
  struct iterate_kit_itx_connection_options options;
  struct iterate_kit_esp_idf_itx_transport_options transport_options;
  struct iterate_kit_peer_options peer_options;

  {
    const struct iterate_kit_device_event_queue_options event_options = {
      .storage = runtime.device_event_storage,
      .capacity = ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY,
      .handler = {.context = NULL, .handle = handle_device_event},
      .observer = {.context = NULL, .observe = NULL},
    };
    if (iterate_kit_device_event_queue_init(
            &runtime.device_events, &event_options) != ITERATE_KIT_OK ||
        iterate_kit_push_to_talk_init(
            &runtime.push_to_talk, &runtime.device_events) !=
            ITERATE_KIT_OK ||
        iterate_kit_conversation_control_init(
            &runtime.conversation_control, &runtime.device_events) !=
            ITERATE_KIT_OK) {
      return false;
    }
    /*
     * MOUNTED ONLY WHERE IT MEANS SOMETHING. A board whose microphone is open
     * for the whole call has no push-to-talk to offer, and offering it anyway
     * gives an agent a method that would silently mute live audio. Two boards
     * already refused these events by hand in `handle_device_event`, one
     * returning "invalid" and one "state error"; not mounting the module says
     * the same thing once, before anybody can call it.
     */
    if (runtime.facts->turns == ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK) {
      modules[module_count++] =
          iterate_kit_push_to_talk_module(&runtime.push_to_talk);
    }
    modules[module_count++] =
        iterate_kit_conversation_control_module(&runtime.conversation_control);
  }
  /*
   * TURN IT UP. Every board here shipped at a volume somebody measured once
   * and nobody could change without a reflash, and all four were reported as
   * too quiet. The driver keeps its ceiling; the knob is now a call away.
   */
  {
    if (iterate_kit_speaker_init(&speaker, &runtime.facts->speaker) ==
        ITERATE_KIT_OK) {
      modules[module_count++] = iterate_kit_speaker_module(&speaker);
    }
  }
  /*
   * ASKABLE. The same document this device pushes as dev-stats, on demand,
   * because the pushed copy only reaches whoever was already listening — and
   * the other way to interrogate a quiet board is its console, which on this
   * hardware REBOOTS it.
   */
  {
    const struct iterate_kit_health_driver driver = {
      .context = NULL,
      .render = render_health,
    };
    if (iterate_kit_health_init(
            &health,
            &driver,
            runtime.stats_buffer,
            sizeof(runtime.stats_buffer)) == ITERATE_KIT_OK) {
      modules[module_count++] = iterate_kit_health_module(&health);
    }
  }
  peer_options = (struct iterate_kit_peer_options){
    runtime.facts->peer_description,
    strlen(runtime.facts->peer_description),
    modules,
    module_count,
  };
  if (iterate_kit_peer_init(&runtime.peer, &peer_options) != CAPNWEB_OK) {
    return false;
  }

  memset(&options, 0, sizeof(options));
  options.pending_calls = runtime.pending_calls;
  options.pending_call_count = PENDING_CALL_CAPACITY;
  options.exports = runtime.exports;
  options.export_count = EXPORT_CAPACITY;
  options.imports = runtime.imports;
  options.import_count = IMPORT_CAPACITY;
  options.tokens = runtime.tokens;
  options.token_count = TOKEN_CAPACITY;
  options.outbound_buffer = runtime.output_buffer;
  options.outbound_buffer_size = OUTPUT_CAPACITY;
  options.send_text = iterate_kit_esp_idf_itx_transport_send_text;
  options.send_text_context = &runtime.transport;
  options.project_id = runtime.configuration.project_id;
  options.project_api_key = runtime.configuration.project_api_key;
  options.client_path = runtime.facts->client_path;
  options.capability = iterate_kit_peer_capability(&runtime.peer);
  /*
   * THE ONLY DESCRIPTION A MODEL EVER SEES.
   *
   * Not `facts->peer_description` — the capability host flattens this mount and
   * reports `children: {}` because sub-paths are routes the device interprets,
   * not members the host can list. So `peer_description` documents it for
   * people reading this file, and THIS string is what an agent discovers in
   * itx.__describe().capabilities. It was one 46-character line, which is why a
   * back-office agent asked for the device's metrics went looking through
   * telemetry streams instead of calling health(): nothing told it the call
   * existed.
   */
  options.description = runtime.facts->instructions;
  options.session_ended = on_session_ended;
  options.session_ended_context = NULL;
  if (iterate_kit_itx_connection_init(&runtime.connection, &options) !=
      CAPNWEB_OK) {
    return false;
  }

  memset(&transport_options, 0, sizeof(transport_options));
  transport_options.configuration = &runtime.configuration;
  transport_options.connection = &runtime.connection;
  transport_options.control_inbox = &runtime.control_inbox;
  transport_options.control_outbox = &runtime.control_outbox;
  return iterate_kit_esp_idf_itx_transport_prepare(
             &runtime.transport, &transport_options) == ITERATE_KIT_OK;
}

/*
 * ONE description of how the device is, used by both the telemetry it pushes
 * and the health() anyone can pull. They were never allowed to disagree —
 * the state worth diagnosing is the one where the push has stopped.
 */
static size_t health_json(char *out, size_t capacity) {
  /*
   * PURE. This serializes local statistics and records nothing.
   *
   * It used to stamp "somebody asked us something" here, on the reasoning that
   * answering an RPC is the only proof the mount is still reachable — which is
   * true, and was defeated by the placement: `append_stats` calls this every
   * five seconds to build the dev-stats telemetry body, so the device renewed
   * its own liveness lease twelve times a minute by talking to itself. On
   * 2026-08-04 that left the pinned board unreachable for over seven minutes
   * with a 90s watchdog armed and a server holding zero connections.
   *
   * Reachability now comes from `iterate_kit_peer_served_dispatches` — INBOUND
   * dispatches, which no amount of outbound telemetry can inflate.
   */
  /*
   * NAME AND VALUE TRAVEL TOGETHER.
   *
   * This was one snprintf with sixty-odd "%" specifiers in a format string
   * and sixty-odd arguments below it, aligned by hand. They drifted, twice —
   * a counter was published under its neighbour's name, and because every
   * argument is a uint32_t the compiler could not see it: -Wformat checks
   * types, and a reorder among identically typed arguments is type-correct.
   *
   * The cost was not the wrong number. It was a whole investigation into 133
   * "liveness restarts" that never happened, and three hypotheses tested
   * against labels that were describing other counters. A misaligned metric
   * is worse than a missing one: a missing one asks a question, and a
   * misaligned one answers it wrongly.
   *
   * So a name is now written next to the value it names, and one loop emits
   * the pairs. Adding a counter is one line, and a line cannot be misaligned
   * with itself.
   */
  struct field {
    const char *name;
    uint32_t value;
  };
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  struct iterate_kit_spsc_ring_metrics outbox_metrics;
  const uint64_t now = now_ms(NULL);
  size_t used;
  size_t index;
  int written;

  struct iterate_kit_itx_connection_tables tables;
  iterate_kit_itx_connection_tables(&runtime.connection, &tables);
  iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &metrics);
  iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox_metrics);

  /*
   * The gate every producer sits behind. Closed, the device answers RPCs and
   * does nothing else — which is exactly what a broken one looks like, so it
   * is reported rather than inferred.
   */
  const bool gate_open =
      (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY) &&
      runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
      runtime.voicelab_generation == runtime.connection.generation;

  const struct field fields[] = {
    {"connectionState", (uint32_t)runtime.connection.state},
    {"seq", runtime.stats_sequence++},
    {"framesSent", runtime.voicelab.frames_sent},
    {"frameFailures", runtime.voicelab.frame_send_failures},
    {"micCaptured", runtime.mic_frames_captured},
    {"micDropped", runtime.mic_frames_dropped},
    {"micProcessFailures", runtime.mic_process_failures},
    {"micIdle", runtime.mic_frames_idle},
    {"spkFrames", runtime.voicelab.spk_frames_received},
    {"spkPlayed", runtime.speaker_frames_played},
    {"spkOverflow",
     atomic_load_explicit(
         &runtime.speaker_overflow_drops, memory_order_relaxed)},
    /* Audio arriving just after a software-dry tick. Same signal, one step on. */
    {"spkSoftDryRefills", runtime.speaker_underruns},
    /* The task-side starvation measure: ms the ring was empty, and how often. */
    /*
     * SOFTWARE-BUFFER LATENESS, absorbed by the hardware ring — not an audible
     * gap, and named so nobody gates on it. The 90ms DMA ring sits between this
     * and the listener: on the turns that moved it, spkStarvedMs was 0 and every
     * frame received was played. spkStarvedMs is the audible-failure gate.
     */
    {"spkSoftDryTicks", runtime.speaker_conceal_frames},
    {"spkCatchup", runtime.speaker_catchup_frames},
    {"spkWriteFailures", runtime.speaker_write_failures},
    {"spkMarginMaxMs", runtime.speaker_margin_max_ms},
    {"spkLagMaxMs", runtime.speaker_lag_max_ms},
    {"spkMarginMinMs", runtime.speaker_margin_min_ms},
    {"spkWrites", runtime.speaker_writes},
    {"spkBadFrames", runtime.speaker_bad_frames},
    {"spkSeqGaps", runtime.playout.gaps},
    {"spkDecodeFailures", runtime.voicelab.spk_decode_failures},
    {"spkDiscarded",
     atomic_load_explicit(
         &runtime.speaker_discarded_frames, memory_order_relaxed)},
    /*
     * The playout's own census. Every other way a frame fails to reach the
     * speaker is counted somewhere; these are the four the classifier
     * decides, and without them a refused frame leaves no trace at all.
     */
    {"spkIgnoredCall", runtime.playout.ignored_other_call},
    {"spkIgnoredStale", runtime.playout.ignored_stale_answer},
    {"spkIgnoredDup", runtime.playout.ignored_duplicate},
    /*
     * NORMAL TRANSITIONS, named so nobody tiers them as faults again. Both move
     * once per answer on a perfect turn: every answer begins by replacing the
     * last, and every answer ends by the source going dry.
     */
    {"spkAnswerStarts", runtime.playout.replaced},
    /* The subset that cost the listener audio: superseded while still playing. */
    {"spkSupersededMidplay", runtime.playout.superseded_midplay},
    {"spkWaitPriming", runtime.speaker_waits_priming},
    {"spkAnswerDrains", runtime.speaker_waits_dry},
    {"bargeIns", runtime.barge_in_flushes},
    {"turnMarkerFailures", runtime.turn_marker_failures},
    /*
     * THE FACE, AND THE ONE NUMBER THAT SAYS IT IS ALIVE.
     *
     * `faceFrames` counts completed analysis windows — 100 a second while audio
     * plays. A mouth that has stopped moving is either this number standing
     * still or the audio never arriving, and nothing on the screen tells those
     * apart. The frozen-pose bug was diagnosed from source because there was no
     * counter to look at; there is one now.
     */
    {"batches", runtime.voicelab.batches_on_connection},
    {"connGeneration", runtime.voicelab.connection_generation},
    {"idleRemounts", runtime.mount_watchdog.remounts},
    /* Inbound capability dispatches served. This is the liveness proof the idle
     * watchdog keys on — telemetry publishing does not move it. */
    {"servedDispatches", iterate_kit_peer_served_dispatches(&runtime.peer)},
    {"bridgeAgeMs",
     runtime.voicelab.last_bridge_ms == 0U
         ? 0U
         : (uint32_t)iterate_kit_voice_elapsed_ms(
               now, runtime.voicelab.last_bridge_ms)},
    {"downlinkRecycles", runtime.downlink_recycles},
    {"batchAgeMs",
     runtime.voicelab.last_batch_ms == 0U
         ? 0U
         : (uint32_t)iterate_kit_voice_elapsed_ms(
               now, runtime.voicelab.last_batch_ms)},
    /*
     * THE THREE FIXED TABLES. Sized at boot and never grown; when one fills,
     * the next call fails with a status that names no table and the device
     * latches. Published as used/capacity pairs so "nearly full" is visible
     * before "full" makes the board look broken.
     */
    {"rpcExports", tables.exports_used},
    {"rpcExportsMax", tables.exports_capacity},
    {"rpcImports", tables.imports_used},
    {"rpcImportsMax", tables.imports_capacity},
    {"rpcCalls", tables.calls_used},
    {"rpcCallsMax", tables.calls_capacity},
    /* Which step of preparing a conversation failed last — the reason that
     * used to exist only on a console whose opening reboots the board. */
    {"heapFree", (uint32_t)esp_get_free_heap_size()},
    /*
     * INTERNAL, NOT TOTAL. `heapFree` counts PSRAM, and on a board with eight
     * megabytes of it a number near six million looks like abundance while the
     * internal heap — the only kind TLS, Wi-Fi and DMA can use — is down to
     * scraps. That is not a hypothetical: a StackChan reading heapFree
     * 5,800,196 dropped its socket mid-sentence with "esp-aes: Failed to
     * allocate memory", and nothing in this document could say why.
     */
    {"internalFree",
     (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL)},
    {"internalMin",
     (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL)},
    {"internalLargest",
     (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)},
    {"heapMin", (uint32_t)esp_get_minimum_free_heap_size()},
    /* Image buffers are PSRAM, so a leak there is invisible in heapFree. */
    {"psramFree", (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM)},
    {"dmaLargest", (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_DMA)},
    {"wsSent", metrics.control_messages_sent},
    {"outboxDiscarded", metrics.control_outbox_discarded},
    {"outboxUsed", (uint32_t)outbox_metrics.current_slots},
    {"outboxSlots", (uint32_t)CONTROL_OUTBOX_SLOTS},
    {"inboxPublished", metrics.control_inbox.messages_published},
    {"inboxConsumed", metrics.control_inbox.messages_consumed},
    {"inboxDiscarded", metrics.control_inbox_discarded},
    {"inboxHighWater", metrics.control_inbox.high_water_slots},
    {"inboxDeferrals", metrics.control_inbox_deferrals},
    {"sessionGeneration", runtime.connection.generation},
    {"protoFailures", metrics.protocol_failures},
    {"recvFailures", metrics.control_receive_failures},
    {"sendFailures", metrics.control_send_failures},
    {"lastAppStatus", (uint32_t)metrics.last_application_capnweb_status},
  };

  /*
   * What the clock says, in exactly the form a new conversation would be named.
   *
   * Empty until the time server answers, which is the useful distinction: a
   * device with no clock names conversations from the RNG, and this is the only
   * way to tell that from outside. A READ, so health_json stays pure — see the
   * comment on this function about what recording anything here once cost.
   */
  char clock[20];
  if (!clock_slug(clock, sizeof(clock))) clock[0] = '\0';

  /* The strings and the one 64-bit field, which do not fit the pair table. */
  written = snprintf(
      out,
      capacity,
      "{\"transport\":\"%s\",\"voicelab\":\"%s\",\"voicelabFailure\":\"%s\","
      /*
       * WHICH CONVERSATION. Every call gets its own stream and the path is
       * chosen ON THE DEVICE, so without this the only way to find the
       * transcript of the call you are looking at is to guess a UTC second.
       */
      "\"conversation\":\"%s\","
      "\"clock\":\"%s\","
      /* WHY IT LAST RESTARTED. Uptime says one happened; only this
       * says whether it was a panic, a stall or somebody's thumb. */
      "\"resetReason\":\"%s\",\"restartNote\":\"%s\","
      "\"connection\":\"%s\","
      "\"callActive\":%s,\"callPending\":%s,\"wantsCall\":%s,\"talking\":%s,"
      /*
       * WHY A PRESS DID NOT BECOME A CALL. Every input the launch seam reads,
       * reported over the stream — because the console port reboots this
       * board, so the only way to watch it decide is to have it say so. A
       * board that wants a call and never places one is otherwise silent
       * about which of three conditions refused it.
       */
      "\"hasStreamCap\":%s,\"outboxFree\":%u,"
      "\"lastStartStatus\":%d,\"startCallFailures\":%u,"
      "\"lastLaunchStep\":%d,\"launchPolls\":%u,"
      "\"sawWantsCall\":%s,\"sawLinkReady\":%s,\"wantsCallPolls\":%u,"
      "\"gateOpen\":%s,\"t\":%" PRIu64 ",\"uptimeMs\":%" PRIu64,
      iterate_kit_esp_idf_itx_transport_state_name(runtime.transport.state),
      iterate_kit_voicelab_state_name(runtime.voicelab.state),
      iterate_kit_voicelab_failure_name(runtime.voicelab.failure),
      stream_path,
      clock,
      iterate_kit_esp_reset_reason_name(),
      iterate_kit_esp_last_restart_note(),
      iterate_kit_itx_connection_state_name(runtime.connection.state),
      runtime.voicelab.call_active ? "true" : "false",
      runtime.voicelab.call_pending ? "true" : "false",
      runtime.view.wants_call ? "true" : "false",
      runtime.talking ? "true" : "false",
      runtime.voicelab.has_stream_capability ? "true" : "false",
      (unsigned)(CONTROL_OUTBOX_SLOTS - outbox_metrics.current_slots),
      (int)runtime.last_start_status,
      (unsigned)runtime.start_call_failures,
      runtime.last_launch_step,
      (unsigned)runtime.launch_polls,
      runtime.saw_wants_call ? "true" : "false",
      runtime.saw_link_ready ? "true" : "false",
      (unsigned)runtime.wants_call_polls,
      gate_open ? "true" : "false",
      now,
      now);
  if (written <= 0 || (size_t)written >= capacity) return 0U;
  used = (size_t)written;

  for (index = 0U; index < sizeof(fields) / sizeof(fields[0]); index++) {
    written = snprintf(
        out + used,
        capacity - used,
        ",\"%s\":%" PRIu32,
        fields[index].name,
        fields[index].value);
    if (written <= 0 || (size_t)written >= capacity - used) {
      /*
       * Name the field that did not fit. "health overflow" alone sends the
       * reader to the transport, when the answer is always the same: this
       * buffer is one field too small.
       */
      ESP_LOGE(
          tag, "health json full at \"%s\" (%u bytes)", fields[index].name,
          (unsigned int)capacity);
      return 0U;
    }
    used += (size_t)written;
  }
  /*
   * AND THE BOARD'S OWN, in the same shape and under the same rule.
   *
   * A dozen of the fields above were a particular board's hardware — DMA
   * ledgers, codec overruns, an I2C button's read failures, a face's frame
   * count — and the four device files each carried their own dozen. They are
   * the board's to name, so the board appends them, and a board that overflows
   * fails the same way the shared table does: nothing is sent, because a
   * truncated stats line is not a shorter document, it is no document.
   */
  if (runtime.board->health != NULL) {
    const size_t appended =
        runtime.board->health(runtime.board_context, out + used, capacity - used);
    if (appended == 0U) {
      ESP_LOGE(tag, "health json full in the board's fields (%u bytes)",
               (unsigned int)capacity);
      return 0U;
    }
    used += appended;
  }
  if (used + 2U >= capacity) return 0U;
  out[used++] = '}';
  out[used] = '\0';
  return used;
}

static size_t render_health(void *context, char *out, size_t capacity) {
  (void)context;
  return health_json(out, capacity);
}

static void append_stats(uint64_t now) {
  static const char prefix[] =
      "[{\"type\":\"events.iterate.com/voice-agent/dev-stats\",\"ephemeral\":true,\"payload\":";
  const size_t prefix_length = sizeof(prefix) - 1U;
  size_t body;
  (void)now;
  memcpy(runtime.stats_buffer, prefix, prefix_length);
  body = health_json(
      runtime.stats_buffer + prefix_length,
      sizeof(runtime.stats_buffer) - prefix_length - 3U);
  if (body == 0U) {
    ESP_LOGE(tag, "stats line does not fit — telemetry is dark");
    return;
  }
  runtime.stats_buffer[prefix_length + body] = '}';
  runtime.stats_buffer[prefix_length + body + 1U] = ']';
  (void)iterate_kit_voicelab_append_raw(
      &runtime.voicelab, runtime.stats_buffer, prefix_length + body + 2U);
  /* prefix is `[{...,"payload":`, body closes its own object, so one `}`
   * closes the event and `]` closes the array. */
}

/*
 * A CLOCK, KEPT ONLY SO A CONVERSATION CAN BE NAMED AFTER WHEN IT HAPPENED.
 *
 * Nothing else on this device needs the time: every deadline it has is measured
 * with esp_timer, which counts from boot and cannot be wrong. This exists
 * because a person scrolling a list of streams has to be able to tell which one
 * was this morning's, and `dev-6f0b6ae2562613aa` cannot tell them.
 *
 * Started once, and never waited for. A device whose clock has not arrived is
 * fully usable — it just names conversations the old way — so blocking startup
 * on a UDP round trip to somebody else's server would trade the whole device
 * for a nicety.
 */
static void start_clock_once(void) {
  static bool started;
  esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");

  if (started) return;
  started = true;
  if (esp_netif_sntp_init(&config) != ESP_OK) {
    ESP_LOGW(tag, "no time source; new conversations keep their random names");
    return;
  }
  ESP_LOGI(tag, "asked pool.ntp.org for the time");
}

enum {
  /*
   * 2023-11-14. Any timestamp before this is the system clock's power-on value
   * rather than the real time, and a conversation called "1970-01-01-000012"
   * is worse than one called after a random number: it looks like a date.
   */
  CLOCK_TRUSTWORTHY_AFTER = 1700000000,
};

/** UTC, as YYYY-MM-DD-HHMMSS. False when the clock has not arrived yet. */
static bool clock_slug(char *out, size_t capacity) {
  const time_t seconds = time(NULL);
  struct tm parts;

  if (seconds < (time_t)CLOCK_TRUSTWORTHY_AFTER) return false;
  if (gmtime_r(&seconds, &parts) == NULL) return false;
  return strftime(out, capacity, "%Y-%m-%d-%H%M%S", &parts) > 0U;
}
/*
 * A START-UP FAULT MUST BE VISIBLE, NOT A REBOOT LOOP.
 *
 * Every failure path below this point used to `return`, and the task watchdog
 * had already been subscribed by then — so the main task simply stopped
 * feeding it and the board panicked twenty seconds later, over and over.
 * From across a room that is indistinguishable from a dead device.
 *
 * So park instead: keep the watchdog fed, keep the screen alive,
 * and let the fault sit where somebody can read it.
 */
static void park_with_fault(const char *what) {
  ESP_LOGE(tag, "fatal: %s", what);
  runtime.view.fault = true;
  runtime.view.link_ready = false;
  runtime.view.status = what;
  for (;;) {
    (void)esp_task_wdt_reset();
    /*
     * Present inside the park. One panel is driven by LVGL's own timer and
     * needs nothing, but three are pumped by their caller — and a board that
     * parks without pumping shows the fault to nobody, which is the whole
     * reason parking beats returning.
     */
    present();
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

/*
 * Power the board and check that what it handed back can carry a conversation.
 *
 * PARKS RATHER THAN RETURNS on failure — that is the caller's job, but it is
 * why this is a function: two of the four boards `return`ed from here with the
 * task watchdog already subscribed, which is a reboot loop, and from across a
 * room a board rebooting every twenty seconds is indistinguishable from a dead
 * one and cannot be asked what went wrong.
 *
 * The order INSIDE `start` is the board's own: one must raise its panel before
 * its codec because both resets hang off a single TCA9554, and doing it the
 * other way round resets a configured codec. WHEN this runs relative to the
 * radio is the loop's, and that is `facts->radio_before_codec`.
 */
static bool start_board(void) {
  struct iterate_kit_board_audio audio;
  memset(&audio, 0, sizeof(audio));
  if (!runtime.board->start(runtime.board_context, &audio)) return false;
  runtime.codec = audio.codec;
  runtime.processor = audio.processor;
  return iterate_kit_audio_codec_validate(&runtime.codec) == ITERATE_KIT_OK &&
      iterate_kit_audio_processor_validate(&runtime.processor) ==
          ITERATE_KIT_OK &&
      runtime.codec.properties->capture_sample_rate_hz ==
          runtime.processor.properties->sample_rate_hz &&
      runtime.processor.properties->frame_samples ==
          runtime.facts->processing_frame_samples &&
      (!runtime.processor.properties->requires_reference_channel ||
       runtime.codec.properties->has_reference_channel) &&
      iterate_kit_audio_processor_reset(&runtime.processor) == ITERATE_KIT_OK;
}

bool iterate_kit_voice_loop_init(
    const struct iterate_kit_board_ops *ops,
    const struct iterate_kit_board_facts *facts,
    void *context) {
  TaskHandle_t capture_task_handle = NULL;
  if (ops == NULL || facts == NULL || ops->start == NULL ||
      ops->present == NULL) {
    return false;
  }
  runtime.board = ops;
  runtime.facts = facts;
  runtime.board_context = context;
  (void)snprintf(
      stream_path, sizeof(stream_path), "%s", facts->stream_path);
  iterate_kit_voice_playback_clock_init(&runtime.playout_clock);
  /*
   * The app task is the sole consumer of the control inbox and therefore the
   * producer of every speaker frame: it parses the delivery batch, base64
   * decodes the PCM and pushes it to the playback buffer, all inside a 20ms
   * budget. FreeRTOS starts it at priority 1 — below the WebSocket task, the
   * display and timer services — and there is no Kconfig symbol to
   * change that (ESP_MAIN_TASK_PRIORITY does not exist; believing it did
   * left this at 1 through several rounds of "priority fixes"). So it raises
   * itself, above everything on this core except Wi-Fi, lwIP and the timers.
   */
  /*
   * 4, deliberately BELOW the WebSocket/TLS task at 5 that feeds this one.
   * At 10 the consumer outranked its own producer on the same core, and this
   * loop polls hard — so the network task got starved and everything felt
   * laggy: buttons late, UI stale, the greeting never arriving. Above LVGL
   * (2), below the producer. Priority 1 (the FreeRTOS default, and what this
   * was before) is the other extreme and was equally wrong: below LVGL.
   */
  /*
   * EQUAL to the network task (5), deliberately, so the two round-robin
   * instead of one starving the other.
   *
   * At 4 — one below — the network task won every time it had work, and
   * during an answer it ALWAYS has work: audio arrives continuously. This
   * task is what drains the inbox, decodes that audio, answers every RPC,
   * polls the buttons and sends the microphone, so it got whatever was left,
   * which was not much. Measured: health() calls that took 50 SECONDS to
   * return mid-answer, ping round trips of 28s, and a device that looks
   * frozen with a dead talk button — because it very nearly was.
   *
   * Above (10) was the opposite error and is in this file's history: the app
   * loop polls hard, so the network task starved and nothing arrived at all.
   * Equal priority is the only setting where both make progress.
   */
  vTaskPrioritySet(NULL, 5);
  const struct iterate_kit_esp_configuration_result configuration_result =
      iterate_kit_esp_read_configuration(&runtime.configuration);
  if (configuration_result.status != ITERATE_KIT_ESP_CONFIGURATION_OK) {
    ESP_LOGE(
        tag,
        "device is not provisioned: storage=%s",
        iterate_kit_esp_configuration_status_name(
            configuration_result.status));
    return false;
  }
  /*
   * Subscribe only after provisioning succeeds. An intentionally unprovisioned
   * board returns to its setup path; subscribing before that return created a
   * watchdog reboot loop. From here onward this task owns every recovery path,
   * so a stall must still reboot loudly.
   */
  (void)esp_task_wdt_add(NULL);
  if (!runtime.facts->radio_before_codec && !start_board()) {
    park_with_fault("board bring-up failed");
  }
  runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_CONNECTING;
  runtime.view.status = ("connecting to iterate");
  ESP_LOGI(
      tag,
      /*
       * The largest CONTIGUOUS DMA block is the number that predicts a display
       * freeze: free-size hides fragmentation, and a flush needs one
       * contiguous ~15 KiB internal allocation. If this dips near that, the
       * next flush is the one that fails.
       */
      "heap after display: internal=%u dma=%u dmaLargest=%u total=%u",
      (unsigned int)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
      (unsigned int)heap_caps_get_free_size(MALLOC_CAP_DMA),
      (unsigned int)heap_caps_get_largest_free_block(MALLOC_CAP_DMA),
      (unsigned int)esp_get_free_heap_size());
  runtime.mic_queue =
      xQueueCreate(MIC_QUEUE_DEPTH, sizeof(struct mic_frame));
  /*
   * PSRAM, not internal. Each queue item is one indivisible 20 ms frame plus
   * its answer generation. FreeRTOS synchronizes reset with receive, while the
   * generation rejects a frame a consumer had already copied when reset ran.
   * That is the replacement guarantee a byte stream cannot provide.
   */
  runtime.speaker_queue = xQueueCreateWithCaps(
      SPEAKER_QUEUE_DEPTH, sizeof(struct speaker_frame), MALLOC_CAP_SPIRAM);
  if (runtime.mic_queue == NULL || runtime.speaker_queue == NULL) {
    park_with_fault("audio buffer allocation failed");
  }
  if (!initialise_rings() || !initialise_connection()) {
    park_with_fault("bounded runtime initialization failed");
  }
  iterate_kit_playout_reset(&runtime.playout, 1U);
  /*
   * A RADIO THAT WILL NOT START IS NOT A FATAL FAULT, IT IS AN OFFLINE
   * DEVICE. This used to return, which — with the watchdog already
   * subscribed — turned a transient Wi-Fi start failure into a permanent
   * reboot loop. Keep trying, and keep the surface honest while trying.
   */
  while (iterate_kit_esp_idf_itx_transport_start(&runtime.transport) !=
         ITERATE_KIT_OK) {
    ESP_LOGE(
        tag,
        "transport start failed: platform=%ld — retrying",
        (long)runtime.transport.last_platform_error);
    runtime.view.status = "network start failed — retrying";
    for (int wait = 0; wait < 50; ++wait) {
      (void)esp_task_wdt_reset();
      /*
       * Present inside the wait. One panel is driven by LVGL's own timer and
       * needs nothing here, but three are pumped by their caller — and this
       * five-second loop is exactly where a board that is retrying looks
       * frozen if nobody pumps it.
       */
      present();
      vTaskDelay(pdMS_TO_TICKS(100));
    }
  }
  /*
   * ...AND THE CODEC NOW, on the board that asked for it, while the radio is
   * off doing its own waiting. Its XMOS + AIC3204 bring-up is 6.2 s measured
   * and it used to run to completion BEFORE Wi-Fi was even started, so two
   * waits ran back to back for no reason: that board reached a ready mount at
   * ~14 s where the others managed ~8. Nothing in the transport needs the
   * codec, and only the two tasks below do.
   */
  if (runtime.facts->radio_before_codec && !start_board()) {
    park_with_fault("board bring-up failed");
  }
  if (xTaskCreatePinnedToCore(
          capture_task,
          "vl-capture",
          runtime.facts->capture_stack_bytes,
          NULL,
          16,
          &capture_task_handle,
          1) != pdPASS ||
      xTaskCreatePinnedToCore(
          playback_task, "vl-playback", 4096, NULL, 17, NULL, 1) != pdPASS) {
    if (capture_task_handle != NULL) {
      vTaskDelete(capture_task_handle);
    }
    park_with_fault("portable audio task creation failed");
  }
  ESP_LOGI(
      tag,
      "voicelab voice client ready: static_bytes=%u stream=%s",
      (unsigned int)sizeof(runtime),
      stream_path);
  return true;
}

/*
 * ONE PASS OF THE DEVICE.
 *
 * `now_ms` is a parameter rather than a call, because a step that is handed
 * its clock can be driven by a virtual one — and a device whose every deadline
 * is measured against a clock it fetches itself cannot be tested at all.
 */
void iterate_kit_voice_loop_step(uint64_t now_ms_value) {
  static uint64_t next_stats_at;
  static uint64_t next_control_poll_at;
  (void)now_ms_value;
  {
    (void)esp_task_wdt_reset();
    (void)iterate_kit_esp_idf_itx_transport_poll(&runtime.transport, 16U);
    /*
     * The controls, at a human cadence rather than the loop's.
     *
     * One board's talk button hangs off a TCA9554, so every read is an I2C
     * transaction on the bus the codec and the touch controller share: at the
     * loop's 5 ms that was 200 reads a second of pure contention. 25 ms is
     * still far faster than a person can press, and a board with cheaper
     * controls loses nothing by being asked at the same rate.
     */
    if (now_ms(NULL) >= next_control_poll_at) {
      next_control_poll_at = now_ms(NULL) + CONTROL_POLL_MS;
      memset(&runtime.intent, 0, sizeof(runtime.intent));
      if (runtime.board->poll != NULL) {
        runtime.board->poll(runtime.board_context, &runtime.intent);
      }
    }
    /*
     * ...and drain what those methods queued. A capability that accepts an
     * intent and never delivers it is worse than one that is absent: the
     * first proof run of this board's new conversation.start() returned
     * success, and health() then reported wantsCall FALSE forever, because
     * the event sat in a queue nothing was reading.
     */
    (void)iterate_kit_device_event_poll(
        &runtime.device_events, ITERATE_KIT_VOICE_DEVICE_EVENT_POLL_BUDGET);
    /*
     * WHETHER THIS DEVICE CAN DO ANYTHING, published every time it changes.
     *
     * The same gate every producer sits behind and that `health()` reports as
     * `gateOpen`: transport ready, stream mounted, generations agreed. The
     * screen needs it continuously rather than at one transition, because the UI
     * state it used to be folded into is written from nine places and any of
     * them would erase it — which is exactly how the board came to read "ready"
     * while the server was refusing it every three seconds.
     *
     * On change only: publishing marks the snapshot dirty, and doing that on
     * every pass would repaint the whole screen at the app loop's rate.
     */
    {
      static bool published_link_ready = true;
      /*
       * THE SAME PREDICATE, SPLIT INTO ITS RUNGS. `link_ready` is unchanged —
       * it is the whole chain, and every producer still sits behind it. What
       * is new is publishing the two halves separately, so the lights can say
       * WHICH one is missing instead of showing one undifferentiated amber.
       */
      const bool api_ready =
          runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY;
      const bool stream_ready =
          runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
          runtime.voicelab_generation == runtime.connection.generation;
      const bool ready = api_ready && stream_ready;
      runtime.view.api_ready = api_ready;
      runtime.view.stream_ready = stream_ready;
      if (ready != published_link_ready) {
        published_link_ready = ready;
        runtime.view.link_ready = ready;
      }
    }
    /*
     * INTENT IS THE LOOP'S, and this is the only place a control changes it.
     *
     * Three of the four boards have ONE control and expressed a call toggle;
     * one has two and expressed separate edges. Both arrive here, and the
     * toggle is resolved against the intent the loop holds — which is why it
     * has to be resolved here and not in the board, now that the board can no
     * longer read what the intent currently is.
     */
    if (runtime.intent.end_call) {
      runtime.view.wants_call = false;
      ESP_LOGI(tag, "control: ending call");
    }
    if (runtime.intent.start_call && !runtime.voicelab.call_active) {
      runtime.view.wants_call = true;
      ESP_LOGI(tag, "control: starting call");
    }
    if (runtime.intent.toggle_call) {
      runtime.view.wants_call = !runtime.view.wants_call;
      ESP_LOGI(
          tag, "control: %s call",
          runtime.view.wants_call ? "starting" : "ending");
    }
    runtime.intent.start_call = false;
    runtime.intent.end_call = false;
    runtime.intent.toggle_call = false;
    {
      static bool talk_logged;
      if (runtime.intent.talk_held != talk_logged) {
        talk_logged = runtime.intent.talk_held;
        ESP_LOGI(
            tag, "talk %s",
            talk_logged ? "down (talking)" : "up (commit)");
      }
    }

    if (runtime.transport.state != runtime.last_transport_state) {
      ESP_LOGI(
          tag,
          "transport state=%s",
          iterate_kit_esp_idf_itx_transport_state_name(
              runtime.transport.state));
      if (runtime.last_transport_state == ITERATE_KIT_ESP_IDF_ITX_READY) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &metrics);
        ESP_LOGE(
            tag,
            "left ready: recvStatus=%" PRId32 " wsClose=%" PRId32
            " wsErrType=%" PRId32 " tlsErr=%" PRId32 " errno=%" PRId32
            " protoFail=%" PRIu32 " recvFail=%" PRIu32 " sendFail=%" PRIu32
            " inboxDiscard=%" PRIu32 " outboxDiscard=%" PRIu32
            " appCapnweb=%" PRId32,
            metrics.last_control_receive_status,
            metrics.last_websocket_close_status_code,
            metrics.last_websocket_error_type,
            metrics.last_websocket_tls_error,
            metrics.last_websocket_transport_errno,
            metrics.protocol_failures,
            metrics.control_receive_failures,
            metrics.control_send_failures,
            metrics.control_inbox_discarded,
            metrics.control_outbox_discarded,
            metrics.last_application_capnweb_status);
      }
      if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY) {
        /* The socket is up, so DNS and UDP work: a good moment to ask what
         * time it is. Once, and never blocking on the answer. */
        start_clock_once();
      }
      if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_FAILED) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
        /*
         * The reason, on the screen. Whether the screen SAYS offline is decided
         * by the published link flag rather than here — nine other places set
         * the UI state, and a one-shot "offline" survived only until the next of
         * them ran.
         */
        runtime.view.status = (iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
        iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &metrics);
        ESP_LOGE(
            tag,
            "mount diagnosis: connection=%d mount=%s failure=%s "
            "protoFail=%" PRIu32 " lastRecvStatus=%" PRId32
            " wsClose=%" PRId32 " appCapnweb=%" PRId32 "@%" PRIu32
            " recvFail=%" PRIu32 " sendFail=%" PRIu32,
            (int)runtime.connection.state,
            iterate_kit_itx_mount_state_name(runtime.connection.mount.state),
            iterate_kit_itx_mount_failure_name(
                runtime.connection.mount.failure),
            metrics.protocol_failures,
            metrics.last_control_receive_status,
            metrics.last_websocket_close_status_code,
            metrics.last_application_capnweb_status,
            metrics.last_application_capnweb_generation,
            metrics.control_receive_failures,
            metrics.control_send_failures);
      }
      runtime.last_transport_state = runtime.transport.state;
    }

    const uint64_t now = now_ms(NULL);

    /*
     * The transport can latch a fatal state that nothing ever clears — most
     * reachably when the network task's stack high-water (a minimum-EVER
     * measurement) dips below its floor once, which then forbids every
     * future reconnect for the life of the boot. A human's remedy is the
     * power button, so make that the device's remedy too, bounded and loud,
     * rather than sitting on "connecting" forever.
     */
    {
      static uint64_t unhealthy_since;
      const bool healthy =
          runtime.transport.state != ITERATE_KIT_ESP_IDF_ITX_FAILED;
      if (healthy) {
        unhealthy_since = 0U;
      } else if (unhealthy_since == 0U) {
        unhealthy_since = now;
      } else if (iterate_kit_voice_elapsed_ms(now, unhealthy_since) > UNHEALTHY_RESTART_MS) {
        ESP_LOGE(
            tag,
            "transport unrecoverable for %us — restarting",
            (unsigned int)(UNHEALTHY_RESTART_MS / 1000U));
        iterate_kit_esp_restart_with_note("transport latched fatal");
      }
    }

    /*
     * A TRANSPORT THAT NEVER COMES BACK.
     *
     * FAILED is the honest failure and the block above handles it. This one is
     * quieter: the transport sits in some non-ready state indefinitely, so
     * every producer's gate stays shut while the loop runs perfectly. The
     * device answers nothing, starts no calls, sends no audio and pushes no
     * telemetry — not a quiet device, a broken one.
     *
     * THERE USED TO BE A SECOND WATCHDOG HERE, and its evidence is gone.
     *
     * It restarted the chip when no application-level round trip had completed
     * for three minutes on a READY transport — the half-open TCP case, where
     * the socket stays open and nothing moves in either direction. Its only
     * proof was the pulled `voice-agent/ping` append, and that has been deleted
     * as a duplicate of the WebSocket's own PING/PONG (see voicelab_stream.h).
     *
     * It is DELETED rather than re-keyed, because every candidate replacement
     * is inbound-only: delivery batches and served dispatches both stop on a
     * perfectly healthy IDLE board, so re-keying would have rebooted every idle
     * device every three minutes. That failure mode is not hypothetical — the
     * mount watchdog made exactly this mistake, and the note in
     * voice_device_profile.h explains what it cost.
     *
     * So half-open detection now belongs to the socket layer, which is where
     * the PING it needs actually lives. What remains here is the one deadline
     * whose evidence is local and always available: the transport's own state.
     */
    {
      /** When the transport last stopped being ready; 0 while it is ready. */
      static uint64_t not_ready_since_ms;
      /*
       * A TRANSPORT THAT IS NEVER READY MUST NOT DISABLE THE RESTART.
       *
       * Holding the liveness clock while the transport is down is right — you
       * cannot fault a device for missing round trips it had no lane for — but
       * it was the ONLY thing this branch did, so a transport that never came
       * back reset the clock on every tick and the restart below could never
       * fire. Measured on the StackChan: unreachable for ten minutes and more,
       * no capability, no face, task watchdog fed the whole time (so the loop
       * was alive and this branch was running), recovered only by a human
       * pulling power. Every board here has the same shape.
       *
       * So the grace is bounded. Being down is forgiven; being down forever is
       * the failure this restart exists for.
       */
      if (runtime.transport.state != ITERATE_KIT_ESP_IDF_ITX_READY) {
        if (not_ready_since_ms == 0U) not_ready_since_ms = now;
        if (iterate_kit_voice_elapsed_ms(now, not_ready_since_ms) >
            NO_LIVENESS_RESTART_MS) {
          ESP_LOGE(
              tag,
              "transport has not been ready for %us — restarting",
              (unsigned int)(NO_LIVENESS_RESTART_MS / 1000U));
          iterate_kit_esp_restart_with_note("transport never became ready");
        }
      } else {
        not_ready_since_ms = 0U;
      }
    }

    /*
     * A FAILED VOICELAB IS NOT A RESTING STATE.
     *
     * `fail()` latches, and the only thing that re-mounts is a CONNECTION
     * generation change — so a mount that failed while the transport stayed
     * perfectly ready sat failed forever. Measured on the HA Voice PE:
     * voicelab=failed, failure=open-call, transport=ready, pings frozen at 0,
     * every later call request ignored, until the 180-second liveness watchdog
     * restarted the whole chip. Three minutes of a device that answers nothing
     * and then reboots, from one transient refusal.
     *
     * Re-mounting is the same work the connection-generation path does, so it
     * is asked for the same way: forget which generation we mounted, and the
     * block below builds a new one. Backed off, because a mount that fails
     * every time must not become a spin.
     */
    if (runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY) {
      static struct iterate_kit_retry_gate remount_gate;
      static bool remount_gate_ready;
      if (!remount_gate_ready) {
        remount_gate_ready =
            iterate_kit_retry_gate_init(
                &remount_gate,
                (uint32_t)ITERATE_KIT_VOICE_REMOUNT_RETRY_MS,
                (uint32_t)ITERATE_KIT_VOICE_REMOUNT_RETRY_MAX_MS) ==
            ITERATE_KIT_OK;
      }
      /*
       * RECOVERY HAS TO CLEAR THE BACKOFF, or the backoff outlives the fault.
       *
       * This gate was only ever deferred. Five transient failures — an
       * access-point blip in the first minute will do it — walked the delay
       * 2s, 4s, 8s, 16s, 30s and left it there for the rest of the boot, so a
       * board that had been perfectly healthy for an hour still took thirty
       * seconds to notice the next failed mount. A mount that reached READY
       * is the evidence the gate exists to wait for, and it is the same
       * signal both transport gates already reset themselves on.
       */
      if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY) {
        iterate_kit_retry_gate_reset(&remount_gate);
      } else if (
          runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED &&
          remount_gate_ready &&
          iterate_kit_retry_gate_ready(&remount_gate, (int64_t)now * 1000)) {
        iterate_kit_retry_gate_defer(&remount_gate, (int64_t)now * 1000);
        ESP_LOGW(
            tag,
            "voicelab failed (%s) with a ready connection — re-mounting",
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
        (void)iterate_kit_voicelab_close(&runtime.voicelab);
        runtime.voicelab_generation = 0U;
      }
    }

    if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY &&
        runtime.voicelab_generation != runtime.connection.generation) {
      /*
       * Designated on purpose: this init used to be positional, and the
       * voicelab options struct grows fields — a silent mis-binding here is
       * exactly the hazard the header warns about.
       */
      const struct iterate_kit_voicelab_options options = {
        .session = &runtime.connection.session,
        .project_id = runtime.configuration.project_id,
        .project_api_key = runtime.configuration.project_api_key,
        .stream_path = stream_path,
        .client_path = runtime.facts->client_path,
        .conversation_id = runtime.facts->conversation_id,
        .now_ms = now_ms,
        .clock_context = NULL,
        .on_speaker = on_speaker_pcm,
        .on_control = on_control,
        .downlink_context = NULL,
      };
      const enum capnweb_status started =
          iterate_kit_voicelab_start(&runtime.voicelab, &options);
      if (started != CAPNWEB_OK) {
        /*
         * Rate-limited, but never silent. This retries every 5 ms, and a
         * start that keeps failing leaves the device answering RPCs while
         * doing nothing else — the single most confusing state it has, and
         * previously the only one it never said a word about.
         */
        static uint64_t next_complaint_at;
        if (now >= next_complaint_at) {
          next_complaint_at = now + 5000U;
          ESP_LOGE(tag, "voicelab mount will not start (status %d)", (int)started);
        }
      }
      if (started == CAPNWEB_OK) {
        runtime.voicelab_generation = runtime.connection.generation;
        runtime.frame_sequence = 0U;
        (void)xQueueReset(runtime.mic_queue); /* drop pre-session stale audio */
        /*
         * AND FORGET WHICH ANSWER WE HAD REACHED.
         *
         * The classifier ignores any frame numbered below the highest answer
         * it has played, which is right within one conversation and a
         * permanent latch across a reconnect: a restarted bridge numbers its
         * first answer 0, every frame is then "stale", and the device stays
         * silent for the rest of the boot while the transport reports ready
         * and the batches keep climbing. Reset was called once, at startup,
         * and never here — the one place a new sender takes over.
         *
         * The same hazard on `abandoned` was found and fixed by measurement
         * (95 frames of one answer, discarded whole). This is its twin, on
         * the field next to it.
         */
        iterate_kit_playout_reset(&runtime.playout, 1U);
        ESP_LOGI(
            tag,
            "voicelab mount started (generation %" PRIu32 ")",
            runtime.connection.generation);
      }
    }

    if (runtime.voicelab.state != runtime.last_voicelab_state) {
      ESP_LOGI(
          tag,
          "voicelab state=%s failure=%s",
          iterate_kit_voicelab_state_name(runtime.voicelab.state),
          iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      runtime.last_voicelab_state = runtime.voicelab.state;
      if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY) {
        runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
        /*
         * NOTHING. The menu's headline is the path and its context line already
         * carries the connection state, so "ready" here was the same word twice
         * on adjacent rows. The status line is for transients — "reconnecting",
         * "call ended" — and being empty is the honest steady state.
         */
        runtime.view.status = ("");
      } else if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED) {
        /* A dead session takes the call with it; the button starts over. */
        runtime.view.wants_call = (false);
        runtime.view.call_active = (false);
        runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_CONNECTING;
        runtime.view.status = (iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      }
    }

    /*
     * The turn's UI state is settled OUTSIDE the session gate below.
     *
     * All of this used to live inside "session is READY", so if the session
     * dropped while the button was held, the release was never processed at
     * all: the device sat on "listening" forever, nothing was ever committed,
     * and no answer could arrive. The user's intent and what the screen says
     * must never depend on the network being up — only the appends do.
     */
    if (runtime.talking && !runtime.flushing_turn &&
        (runtime.voicelab.state != ITERATE_KIT_VOICELAB_READY ||
         !runtime.voicelab.call_active)) {
      ESP_LOGW(tag, "turn abandoned: session or call went away");
      runtime.talking = false;
      runtime.flushing_turn = false;
      runtime.remote_talk = false;
      /* Give the pins back: the answer path needs them. */
      board_fence(false);
      runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
      runtime.view.status = runtime.facts->call_hint;
    }

    if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
        runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.voicelab_generation == runtime.connection.generation) {
      /*
       * EVERY producer gates on outbox headroom: exhaustion is
       * SESSION-FATAL in this peer (finish_message terminalizes on
       * backpressure), and the measured drain is only ~25-50 messages/s.
       * Mic frames aggregate to 4-frame/80ms appends (12.5 pushes/s);
       * frames are skipped without headroom — the freshest-wins mic queue
       * makes that loss honest.
       */
      struct iterate_kit_spsc_ring_metrics outbox_metrics;
      iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox_metrics);
      const size_t outbox_free =
          CONTROL_OUTBOX_SLOTS - outbox_metrics.current_slots;
      static struct mic_frame frame_storage[MIC_FRAMES_PER_APPEND];
      static uint64_t drain_window_at;
      static struct iterate_kit_launch launch;
      static uint64_t call_pending_since;
      static bool call_active_shown;

      /*
       * One intent path for both sources: a physical button edge and an RPC
       * call land on the same two flags, so remote and local control cannot
       * disagree about what the device is doing (the M5StickS3 does the same
       * through its device-event queue).
       */
      const bool wants_call = runtime.view.wants_call;
      /*
       * SILENCE ONLY COUNTS ONCE SOMETHING IS EXPECTED. The downlink watchdog
       * below measures time since the last delivered batch, and nothing is
       * delivered before a call exists — so a device that had been idle for
       * more than ten seconds recycled its connection the instant somebody
       * asked for a call, adding a whole reconnection to the wait. Restart
       * the clock at the moment the expectation starts.
       */
      {
        static bool wanted_previously;
        if (wants_call && !wanted_previously) runtime.voicelab.last_batch_ms = now;
        wanted_previously = wants_call;
      }
      /*
       * A WIRED-OR, and then a turn policy on top of it.
       *
       * A physical control and an RPC hold the microphone open the same way,
       * so either is enough. On a board whose far end segments turns there is
       * no control to hold at all and the microphone rides the open call —
       * requesting the manual default there produces an accepted call and a
       * deaf assistant, so the policy is a fact rather than a guess.
       */
      const bool wants_talk =
          runtime.facts->turns == ITERATE_KIT_VOICE_TURNS_SERVER_VAD
          ? runtime.voicelab.call_active
          : (wants_call &&
             (runtime.intent.talk_held || runtime.remote_talk));
      runtime.view.talk_held = wants_talk;

      /*
       * THE BRIDGE-SILENCE WATCHDOG WAS HERE, AND ITS EVIDENCE IS GONE.
       *
       * The bridge holds the call in a Durable Object this device cannot see,
       * and it can stop — evicted, redeployed, or simply gone — without
       * appending the conversation-ended that would say so. Overnight that left
       * a device holding a call that had not existed for hours, so the call was
       * believed only while its bridge kept proving it was there.
       *
       * The proof was the pong answering this device's own ping: the ONE
       * bridge-sourced event that arrives while nobody is speaking. With the
       * ping deleted, twenty seconds of a person thinking is indistinguishable
       * from a dead bridge, and the watchdog would have dropped a live call on
       * every thoughtful pause. A watchdog that fires on the normal case is
       * worse than none.
       *
       * `bridgeAgeMs` still reports the age, so the fact is visible to whoever
       * is looking. What replaced the ACTION is the downlink deadline below,
       * which fires on silence only when traffic is expected — and whose remedy
       * (recycle the connection, keep the call) was always the gentler one.
       */

      /*
       * THE DOWNLINK NEEDS ITS OWN PROOF.
       *
       * Everything above trusts that if the bridge appends something, this
       * device hears it. That is one lane, held by the platform as a
       * callback registration inside the stream's Durable Object, and it can
       * be lost on its own: measured here, a device whose uplink was resolving
       * happily while eight conversation-accepted events and eleven more
       * besides were appended by live bridges and NOT ONE of
       * them arrived. Its batch counter did not move for 68 seconds. The UI
       * said "starting call" the whole time, which is exactly what a person
       * sees, and nothing in the device was ever going to notice: the socket
       * was fine, the session was fine, the appends were fine.
       *
       * Silence is only evidence when traffic is expected. It is expected
       * whenever a call is wanted: an accepted call answers, so ten seconds
       * without a single batch means the lane is dead, not quiet.
       * The cure is the recycle that already exists — make-before-break, one
       * round trip — and if three of those change nothing then it is not the
       * connection that is broken, it is the session under it.
       */
      if (wants_call && runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
          runtime.voicelab.has_connection_capability &&
          !runtime.voicelab.recycle_pending && outbox_free >= 4U &&
          runtime.voicelab.last_batch_ms != 0U &&
          iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_batch_ms) > DOWNLINK_SILENCE_MS) {
        ++runtime.downlink_recycles;
        if (runtime.downlink_recycles_running >= 3U) {
          ESP_LOGE(
              tag,
              "downlink still dead after 3 recycles — replacing the session");
          runtime.downlink_recycles_running = 0U;
          iterate_kit_esp_idf_itx_transport_request_restart(&runtime.transport);
        } else {
          ++runtime.downlink_recycles_running;
          ESP_LOGW(
              tag,
              "nothing delivered for %us with a call wanted — recycling the "
              "connection (%u)",
              (unsigned int)(DOWNLINK_SILENCE_MS / 1000U),
              (unsigned int)runtime.downlink_recycles_running);
          /*
           * Stamp the deadline forward NOW. The recycle is asynchronous and
           * this poll runs 200 times a second; without it every iteration
           * until the successor resolves would open another connection.
           */
          runtime.voicelab.last_batch_ms = now;
          (void)iterate_kit_voicelab_recycle_connection(&runtime.voicelab);
        }
      }
      /* Any delivery at all means the lane recovered; forget the escalation. */
      if (runtime.downlink_recycles_running > 0U &&
          runtime.voicelab.batches_on_connection > 0U) {
        runtime.downlink_recycles_running = 0U;
      }

      /*
       * call_pending is a promise that something will answer, and promises
       * expire. It is cleared by conversation-accepted or by the start RPC failing —
       * so a start whose reply is simply lost (the session died underneath
       * it, the bridge never came up) latched it true forever, and the
       * reconcile below never ran again. The device then waits, with a call
       * it wants and no call, for as long as it is left on.
       */
      if (runtime.voicelab.call_pending && call_pending_since != 0U &&
          iterate_kit_voice_elapsed_ms(now, call_pending_since) > 20000U) {
        ESP_LOGW(tag, "call start went unanswered for 20s — trying again");
        iterate_kit_voicelab_forget_call(&runtime.voicelab);
        call_pending_since = 0U;
        iterate_kit_launch_retry_now(&launch);
      }
      if (!runtime.voicelab.call_pending) call_pending_since = 0U;

      /*
       * GETTING INTO A CALL. The ladder — prepare ahead, prepare now, place —
       * and its three separate deadlines live in conversation_launch.c, which
       * every board shares and which is tested on the host.
       */
      {
        const struct iterate_kit_launch_inputs launching = {
            .call_active = runtime.voicelab.call_active,
            .call_pending = runtime.voicelab.call_pending,
            .link_ready = outbox_free >= 3U,
            .now_ms = now,
            .wants_call = wants_call,
        };
        runtime.last_launch_step = (int)iterate_kit_launch_next_step(&launch, &launching);
        ++runtime.launch_polls;
        runtime.saw_wants_call = launching.wants_call;
        runtime.saw_link_ready = launching.link_ready;
        if (launching.wants_call) ++runtime.wants_call_polls;
        switch ((enum iterate_kit_launch_step)runtime.last_launch_step) {
          case ITERATE_KIT_LAUNCH_PLACE_CALL:
            call_pending_since = now;
            /*
             * KEEP THE REFUSAL. This discarded the status, so a start that
             * failed was indistinguishable from one that was never attempted:
             * a board sat wanting a call with every launch gate green and
             * nothing anywhere said why.
             */
            runtime.last_start_status =
                iterate_kit_voicelab_start_call(
                    &runtime.voicelab, runtime.facts->greeting);
            if (runtime.last_start_status == CAPNWEB_OK) {
              runtime.view.status = ("starting call");
            } else {
              ++runtime.start_call_failures;
            }
            break;
          case ITERATE_KIT_LAUNCH_NOTHING:
          default:
            break;
        }
      }
      if (!wants_call && runtime.voicelab.call_active && outbox_free >= 3U) {
        /*
         * ENDING A CALL ABANDONS WHATEVER WAS PLAYING.
         *
         * Same reasoning as the barge-in flush: the ring still holds the last
         * 90ms of an answer nobody will hear the rest of, and it drains while
         * the speaker task sits armed. That gap was counted as starvation on
         * every hang-up-mid-answer — send index 44 in the run that showed it.
         * Ours, intended, and declared at the moment we cause it.
         */
        board_phase(ITERATE_KIT_VOICE_PHASE_WAITING);
        (void)iterate_kit_voicelab_end_call(&runtime.voicelab, "button");
        runtime.view.status = ("call ended");
        runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
      }
      if (runtime.voicelab.call_active &&
          runtime.voicelab.call_active != call_active_shown) {
        runtime.speaker_margin_min_ms = 0U;
        runtime.speaker_writes = 0U;
      }
      if (runtime.voicelab.call_active != call_active_shown) {
        call_active_shown = runtime.voicelab.call_active;
        runtime.view.call_active = (call_active_shown);
        /*
         * Belt to on_control's braces: a call forgotten for lost liveness
         * never sends CALL_ENDED, and the envelope mouth must not stay gated
         * on a call that no longer exists. Idempotent when on_control already
         * flipped it.
         */
        if (call_active_shown) {
          /*
           * Display only. The playout reset for a new call lives in on_control's
           * CALL_ACCEPTED branch, on the receive path that classifies frames —
           * this observation runs later and could follow the call's first frame.
           */
          runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_IDLE;
          runtime.view.status = runtime.facts->talk_hint;
        }
      }

      /*
       * Turn edges. Pressing talk cancels whatever is playing — locally by
       * dropping the queued speaker audio, and at the bridge by asking it to
       * cancel the response — so the microphone never opens into a live
       * speaker. Releasing commits the turn and asks for the answer.
       */
      /*
       * A turn is bounded no matter what. The talk button is read over a
       * shared I2C bus and the UI can request a turn remotely; either can
       * fail in a way that leaves the request stuck on. Rather than trust
       * both, the turn ends itself after a maximum length — nobody speaks
       * for a minute straight, and a wedged turn is worse than a truncated
       * one because nothing is ever sent for an answer.
       */
      if (runtime.talking && !runtime.flushing_turn &&
          iterate_kit_voice_elapsed_ms(now, runtime.turn_started_ms) > TURN_MAX_MS) {
        ESP_LOGW(tag, "turn exceeded %ums — ending it", (unsigned)TURN_MAX_MS);
        runtime.remote_talk = false;
        board_fence(false);
        runtime.flushing_turn = true;
        runtime.flush_frames_left = 0U;
        runtime.flush_deadline_ms = now;
      }
      if (wants_talk && !runtime.talking && runtime.voicelab.call_active &&
          outbox_free >= 3U) {
        /*
         * Pressing to talk abandons whatever is still playing, which is an
         * intentional flush like any other — and this site never disarmed the
         * starvation watch at all. The funnel also reprimes: the discard empties
         * the ring, so the next answer's first frame would otherwise play with
         * zero cushion and starve immediately, putting a hole at the START of
         * every answer after a turn.
         */
        (void)abandon_speaker_audio();
        iterate_kit_playout_interrupt(&runtime.playout);
        (void)xQueueReset(runtime.mic_queue); /* drop pre-press room noise */
        runtime.frame_sequence = 0U;
        if (publish_turn_marker(ITERATE_KIT_VOICELAB_TURN_START)) {
          runtime.talking = true;
          runtime.turn_started_ms = now;
          runtime.flushing_turn = false;
          /*
           * THE HANDOFF: only now, with the turn marker on the wire and the
           * speaker queue emptied by the abandon above, may the microphone
           * take the pins. If the marker failed, nothing is taken and no turn
           * opens — which is the whole reason this sits inside the branch.
           */
          board_fence(true);
          ESP_LOGI(tag, "turn start");
          /*
           * The face attends and shuts its mouth. Told rather than inferred from
           * silence: the audio it was animating has just been discarded, and
           * without this the last shape of the interrupted word would sit on the
           * face for the whole time the person is speaking.
           */
          runtime.view.listening = (true);
          runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_LISTENING;
          runtime.view.status = ("listening — release to send");
        }
      }
      /*
       * Releasing does NOT commit immediately. The capture queue holds up to
       * 640 ms, and the sender only drains it 6 frames at a time — so
       * committing on the button edge threw away the tail of every
       * utterance, which is the last word or two of whatever was said. The
       * turn stays open until the queue is empty (or a bounded deadline
       * passes, so a stalled uplink cannot hang the turn forever), and only
       * then is the commit sent.
       */
      if (!wants_talk && runtime.talking && !runtime.flushing_turn) {
        /*
         * Flush exactly what was captured UP TO the release, and no more.
         * Waiting for the queue to empty could not work: the capture task
         * keeps filling it every 20ms regardless, so "empty" was a race the
         * sender only won transiently — and four turns in ten hit the
         * deadline instead, dropping their tail.
         */
        runtime.flushing_turn = true;
        runtime.flush_frames_left =
            (uint32_t)uxQueueMessagesWaiting(runtime.mic_queue);
        runtime.flush_deadline_ms = now + TURN_FLUSH_TIMEOUT_MS;
        /*
         * The microphone's job ended at the RELEASE edge, so give the pins
         * back now rather than at the commit below — the answer can then play
         * the moment it arrives. Queued frames still flush; the fence only
         * stops NEW capture.
         */
        board_fence(false);
        runtime.view.status = "sending";
      }
      if (runtime.flushing_turn &&
          (runtime.flush_frames_left == 0U ||
           now >= runtime.flush_deadline_ms)) {
        const bool timed_out = runtime.flush_frames_left > 0U;
        runtime.talking = false;
        runtime.flushing_turn = false;
        ESP_LOGI(tag, "turn commit%s", timed_out ? " (tail dropped)" : "");
        /* Done listening: the face waits for the answer rather than for us. */
        runtime.view.listening = (false);
        if (publish_turn_marker(ITERATE_KIT_VOICELAB_TURN_COMMIT)) {
          runtime.view.screen = ITERATE_KIT_VOICE_SCREEN_SPEAKING;
          runtime.view.status = ("thinking");
        }
      }

      /*
       * One shared answer to "has anything called me lately", tested on the
       * host. See mount_watchdog.h for why a device cannot tell an
       * unreachable mount from a quiet afternoon.
       */
      if (iterate_kit_mount_watchdog_due(
              &runtime.mount_watchdog,
              iterate_kit_peer_served_dispatches(&runtime.peer),
              /* A call UP or a start in flight — NOT merely wanted. See
               * mount_watchdog.h: wanting a call this device cannot start is
               * the symptom of a lost mount, not a reason to keep it. */
              runtime.voicelab.call_active || runtime.voicelab.call_pending,
              now)) {
        ESP_LOGW(tag, "nothing has called this device in a while — re-registering");
        runtime.view.status = ("re-registering");
        iterate_kit_esp_idf_itx_transport_request_restart(&runtime.transport);
      }

      /* The microphone is only on the wire while the talk button is down. */
      {
        const size_t queued = uxQueueMessagesWaiting(runtime.mic_queue);
        /* A partial batch is only worth sending at the end of a turn. */
        const size_t needed =
            runtime.flushing_turn ? 1U : (size_t)MIC_FRAMES_PER_APPEND;
        /*
         * The window paces the uplink at exactly capture rate, so any
         * backlog is permanent — four of ten turns in one call hit the
         * flush deadline with audio still queued ("tail dropped"). When a
         * backlog exists, send immediately instead of waiting for the
         * window, so the sender can actually catch up.
         */
        const bool behind = queued >= (size_t)(MIC_FRAMES_PER_APPEND * 2U);
        if (runtime.talking && (behind || now >= drain_window_at) &&
            queued >= needed && outbox_free >= (size_t)MIC_OUTBOX_RESERVE) {
          const size_t take = queued < (size_t)MIC_FRAMES_PER_APPEND
              ? queued
              : (size_t)MIC_FRAMES_PER_APPEND;
          /*
           * The window only advances on a batch that was actually sent. It
           * used to advance regardless, so a moment of outbox backpressure
           * silently dropped that speech instead of sending it a beat later —
           * the mic queue holds 640ms and is the right place to absorb this.
           */
          const uint8_t *frame_pointers[MIC_FRAMES_PER_APPEND];
          size_t index;
          drain_window_at =
              (drain_window_at == 0U ||
               iterate_kit_voice_elapsed_ms(now, drain_window_at) > MIC_FRAMES_PER_APPEND * FRAME_MS * 4U)
              ? now + (uint64_t)take * FRAME_MS
              : drain_window_at + (uint64_t)take * FRAME_MS;
          for (index = 0U; index < take; ++index) {
            (void)xQueueReceive(runtime.mic_queue, &frame_storage[index], 0);
            frame_pointers[index] =
                (const uint8_t *)frame_storage[index].samples;
          }
          (void)iterate_kit_voicelab_append_frames(
              &runtime.voicelab,
              frame_pointers,
              take,
              sizeof(frame_storage[0].samples),
              runtime.frame_sequence,
              now);
          runtime.frame_sequence += (uint32_t)take;
          runtime.flush_frames_left = runtime.flush_frames_left > take
              ? runtime.flush_frames_left - (uint32_t)take
              : 0U;
        }
      }
      /*
       * Recycling opens a NEW connection — a TLS-backed round trip — inline
       * on this task, which is the same task that decodes speaker PCM. The
       * steady-state cushion is only the 160 ms prefill plus ~90 ms of DMA,
       * so a recycle mid-answer starves the DAC and costs an audible hole.
       * At ~600 batches that lands roughly 12 s into every answer and again
       * every 12 s after — "it gets worse as the session goes on".
       *
       * So it waits for a quiet moment: no audio queued and nothing being
       * spoken. The budget it is racing is ~1000 pushes and it becomes due
       * at 600, so there is ample room to wait for a gap between turns.
       */
      if (outbox_free >= 4U &&
          iterate_kit_voicelab_needs_recycle(&runtime.voicelab)) {
        const bool speaker_idle = speaker_queued_bytes() == 0U;
        if ((speaker_idle && !runtime.talking) ||
            runtime.voicelab.batches_on_connection >
                ITERATE_KIT_VOICELAB_RECYCLE_AFTER_BATCHES + 250U) {
          (void)iterate_kit_voicelab_recycle_connection(&runtime.voicelab);
        }
      }
      /* Seed the telemetry clock the first time the gate opens. */
      if (next_stats_at == 0U) next_stats_at = now + STATS_INTERVAL_MS;
      /*
       * A one-second pulse while a turn is open. When the device freezes
       * mid-turn nothing else can be read out of it — health() is answered by
       * this very task — so this is the only way to tell a stalled APP task
       * from a stalled TRANSPORT: if the pulse keeps printing, the loop is
       * running and the network is stuck; if it stops, the loop is.
       */
      /*
       * The pulse used to cover only the TURN, which is the half of a
       * conversation that was already working. Choppy playback lives in the
       * other half: it needs received-versus-played-versus-concealed and how
       * much audio was standing in the ring, once a second, while the answer
       * is happening. A count taken afterwards cannot show a lane that
       * delivered 240ms and then went quiet for two seconds, which is what
       * a listener hears as clipping in and out.
       */
      if (runtime.talking || runtime.voicelab.call_active ||
          iterate_kit_voice_elapsed_ms(now, runtime.last_pulse_ms) < 3000U) {
        if (iterate_kit_voice_elapsed_ms(now, runtime.last_pulse_ms) >= 1000U) {
          struct iterate_kit_esp_idf_itx_transport_metrics pulse;
          iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &pulse);
          runtime.last_pulse_ms = now;
          ESP_LOGI(
              tag,
              "pulse loops=%" PRIu32 " outbox=%u/%u inPub=%" PRIu32
              " inCon=%" PRIu32 " sent=%" PRIu32 " frames=%" PRIu32
              " | batches=%" PRIu32 " rx=%" PRIu32 " gaps=%" PRIu32
              " played=%" PRIu32 " conceal=%" PRIu32 " under=%" PRIu32
              " ringMs=%u",
              runtime.loop_count,
              (unsigned int)outbox_metrics.current_slots,
              (unsigned int)CONTROL_OUTBOX_SLOTS,
              pulse.control_inbox.messages_published,
              pulse.control_inbox.messages_consumed,
              pulse.control_messages_sent,
              runtime.voicelab.frames_sent,
              runtime.voicelab.batches_on_connection,
              runtime.voicelab.spk_frames_received,
              runtime.voicelab.spk_seq_gaps,
              runtime.speaker_frames_played,
              runtime.speaker_conceal_frames,
              runtime.speaker_underruns,
              (unsigned int)(speaker_queued_bytes() / 32U));
        }
      }
      if (now >= next_stats_at && outbox_free >= 3U) {
        append_stats(now);
        next_stats_at = now + STATS_INTERVAL_MS;
      }
    }

    ++runtime.loop_count;
  }
  /*
   * SHOW IT, LAST AND ALWAYS.
   *
   * Everything above assembles one view; this is the single place it reaches
   * the hardware. Unconditional, because the board's own comparison is cheaper
   * than the nine lock round trips the setters used to cost, and because three
   * of the four panels are pumped by their caller and this is that pump.
   */
  present();
}

void iterate_kit_voice_loop_run(
    const struct iterate_kit_board_ops *ops,
    const struct iterate_kit_board_facts *facts,
    void *context) {
  if (!iterate_kit_voice_loop_init(ops, facts, context)) {
    /*
     * Nothing is up yet — no panel, no watchdog subscription — so there is
     * nowhere to park and nothing to park on. The caller returns to its setup
     * path, which is what an unprovisioned board is supposed to do.
     */
    ESP_LOGE(tag, "voice loop refused its board");
    return;
  }
  for (;;) {
    iterate_kit_voice_loop_step(now_ms(NULL));
    DELAY_MS(5);
  }
}

const char *iterate_kit_voice_loop_stream_path(void) {
  return stream_path;
}
