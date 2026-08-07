/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 — the Iterate voice device.
 *
 * The whole product is here: an on-screen Iterate UI (start call / hang up,
 * live transcript), a live capability at kit.waveshare so an agent can drive
 * the screen and the call, and the voice pipe itself.
 *
 * ONE Cap'n Web WebSocket to /api carries everything, exactly like the
 * TypeScript voicelab client: authenticate -> projects.get -> streams.get,
 * then 50 Hz one-way appends of ephemeral events.iterate.com/voice-agent/mic-frame events (real
 * ES8311 microphone), and a live openConnection callback delivering
 * events.iterate.com/voice-agent/spk-frame events (decoded to the speaker) plus grok-events
 * (speech_started = barge-in flush, response.done = end of answer,
 * transcript deltas to the screen).
 *
 * Nothing runs off-device: pressing "start call" calls the project's OWN
 * userspace worker (itx.worker.startCall) over that same socket, and the
 * worker holds the Grok session detached. No laptop bridge, no second
 * connection.
 *
 * Turn taking is MANUAL, like the M5StickS3: no VAD anywhere. BOOT toggles
 * the call, PWR is held while speaking. Nothing is sent from the microphone
 * unless PWR is down, which is also the whole echo story on a board with no
 * AEC reference — the speaker is never live into an open microphone, and
 * pressing PWR cancels an answer in flight instead of talking over it.
 *
 * Observability is the stream itself (durable events.iterate.com/voice-agent/dev-stats every 5s);
 * opening the USB console resets the board.
 *
 * DELIBERATE DEPARTURE from the dual-WebSocket decision in
 * docs/fable-v2-plan/DECISIONS.md — this target is the single-socket
 * measurement that decision asked for.
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
#include "esp_random.h"
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
#include "iterate/kit/voice_playback_clock.h"
#include "waveshare_audio.h"
#include "waveshare_avatar.h"
#include "waveshare_buttons.h"
#include "waveshare_display.h"

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
  /* One frame of speaker audio, in milliseconds. */
  SPEAKER_FRAME_MS = 20,
  /* One hardware ring of credited audio: the point an answer is under way. */
  DMA_RING_CREDIT_MS = 90,
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
   * How long the playback task waits for a frame before treating the source
   * as dry. Two thirds of the 90 ms I2S DMA ring (6 descriptors x 240
   * frames at 16 kHz); see the argument at the read itself.
   */
  SPEAKER_DRY_WAIT_MS = 60,
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
  /* Button scan cadence; each scan costs an I2C transaction. */
  BUTTON_POLL_MS = ITERATE_KIT_VOICE_CONTROL_POLL_MS,
  STATS_INTERVAL_MS = ITERATE_KIT_VOICE_STATS_INTERVAL_MS,
  /* How long the transport may stay FAILED before the device reboots itself. */
  UNHEALTHY_RESTART_MS = ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS,
  PING_INTERVAL_MS = ITERATE_KIT_VOICE_PING_INTERVAL_MS,
  /*
   * A ping whose append never resolves within this long means the session is
   * not carrying traffic in BOTH directions, whatever the socket believes.
   * Well clear of the worst RTT ever measured here (~400 ms) and of a
   * connection recycle, so a healthy device never trips it.
   */
  PING_TIMEOUT_MS = ITERATE_KIT_VOICE_PING_TIMEOUT_MS,
  /*
   * A call with no event from its bridge for this long is a call whose bridge
   * is gone. Pings run every 5 s and each one earns a pong, so this is three
   * missed round trips — not a network hiccup.
   */
  BRIDGE_SILENCE_MS = ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS,
  /*
   * With a call wanted there is always a bridge pinging back, so this long
   * without ANY batch on the delivery lane means the lane itself is gone.
   * Deliberately shorter than BRIDGE_SILENCE_MS: recycling the connection is
   * one round trip and keeps the call, whereas giving up on the call throws
   * away a live Grok session.
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
 * A fresh path. The previous one accumulated durable events (dev-stats every
 * 5s, plus every call lifecycle event) until its Durable Object took ~1s per
 * append — measured against a fresh stream's 72ms. Every handshake step is
 * one append, so the device took 20s to come up and calls felt glacial.
 * dev-stats is ephemeral now, so this path stays fast.
 */
/*
 * The stream this device mounts, as a runtime value.
 *
 * It was a compile-time constant, which is exactly why "start a fresh
 * conversation" could not be expressed: one device, one stream, forever, and
 * every reboot resumed a context that might be days old. The path IS the
 * conversation's identity, so choosing it is choosing whether to continue or
 * begin — no other mechanism is needed.
 *
 * The default is the historical one, so a device that has never been asked for
 * anything else behaves exactly as it did.
 */
/*
 * Under /agents/voice/ because the conversation's stream IS its agent: the
 * voice half and the thinking half are one identity at one path. A default
 * outside /agents/ gave the device a conversation with no agent behind it.
 */
#define STREAM_PATH_DEFAULT "/agents/voice/device"
static char stream_path[96] = STREAM_PATH_DEFAULT;
/*
 * The path a setup call is preparing. Kept apart from the live one so a setup
 * that fails leaves the device on the conversation it already had, rather than
 * pointed at a stream nobody has prepared.
 */
static char pending_stream_path[96];

/*
 * EVERY CALL GETS ITS OWN STREAM.
 *
 * A conversation IS its stream, so a second call on the same path is a second
 * conversation wearing the first one's history — the agent reads it, and the
 * person gets answers about something they said ten minutes ago.
 *
 * `stream_used` starts TRUE, deliberately: the path this device boots on is
 * either the default or one it used before, and both have a past. So the first
 * call after a boot makes a fresh stream like every other call.
 *
 * `awaiting_fresh_stream` is what stops that from looping. Adopting a new
 * conversation asks for a call, which would ask for a new conversation, which
 * would ask for a call; the flag says "the stream being prepared is for the
 * call already asked for" and is cleared the moment it is adopted.
 */
static bool stream_used = true;
static bool awaiting_fresh_stream;
/*
 * WHEN the prepare went out, so waiting on it can expire.
 *
 * `awaiting_fresh_stream` was cleared only by setup_succeeded or setup_failed,
 * so a request whose completion never came back latched it true for the rest
 * of the boot: no further prepare was attempted, no call could be placed, and
 * the board sat on its default stream looking perfectly healthy. Measured on
 * the HA Voice PE — setupFailStep 0, voicelab ready, conversation still
 * /agents/voice/device after four minutes. Every other in-flight state here
 * already expires; this one was missed.
 */
static uint64_t awaiting_since_ms;
/** Prepares abandoned because nothing ever answered them. */
static uint32_t prepare_timeouts;
/*
 * True when the stream being prepared was NOT asked for by a person.
 * See the eager prepare in the app loop: the adoption path must not
 * turn a speculative preparation into a call nobody wanted.
 */
static bool preparing_ahead;
#define CONVERSATION_ID "wsdev"
#define GREETING "Hi, I am your Iterate device. What can I do for you?"

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
  uint32_t speaker_debt_paid;
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
  /* Transports torn down because a ping went unanswered. */
  uint32_t liveness_restarts;
  struct iterate_kit_mount_watchdog mount_watchdog;
  /* Calls abandoned because their bridge stopped proving it existed. */
  uint32_t bridge_losses;
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

static uint32_t speaker_queued_bytes(void) {
  if (runtime.speaker_queue == NULL) return 0U;
  return (uint32_t)uxQueueMessagesWaiting(runtime.speaker_queue) * FRAME_BYTES;
}

/* What `itx.kit.waveshare` looks like to whoever holds the capability. */
/*
 * What an agent is told this device is, and how to use it. See the note at the
 * assignment in initialise_connection() for why this string rather than
 * peer_description is the model-facing one.
 */
static const char instructions[] =
    "Waveshare AMOLED: a voice endpoint with a touch screen showing a face. "
    "The upper button is push-to-talk; the lower button hangs up. "
    "conversation.start() and conversation.end() begin and end a call. "
    "health() returns this device's full diagnostics, the same document it "
    "pushes as dev-stats — start there when it seems unwell. "
    "speaker.setVolume({percent}) sets how loud it plays, 0-100, clamped to a "
    "ceiling this board has a measured reason for; speaker.volume() reads it "
    "back. Both answer {percent,ceiling}. "    "pushToTalk.start() and pushToTalk.stop() hold its microphone open, "
    "joining the physical button as a wired-OR: it has no echo cancellation, "
    "so it only listens while one of them is held. "    "Audio and lifecycle events share this stream connection.";
static const char peer_description[] =
    "{\"instructions\":\"Waveshare voice endpoint. "
    "conversation.start() / conversation.end() begin and end a call; "
    "pushToTalk.start() / pushToTalk.stop() hold its microphone open the way "
    "speaker.setVolume({percent}) sets how loud it plays, 0-100; it clamps "
    "to a ceiling this board has a measured reason for and answers with "
    "{percent,ceiling}, which speaker.volume() also returns. "
    "the upper button does. health() returns the same diagnostics document "
    "the device pushes as dev-stats.\",\"children\":{}}";

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
  waveshare_display_set_status("reconnecting");
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
  waveshare_audio_amplifier(true);
  atomic_store_explicit(
      &runtime.speaker_answer_done, false, memory_order_release);
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
  waveshare_avatar_note_accepted(identity->answer, pcm_length / 2U);
}

/* Scheduled mouth shapes ride the same lane as the audio they describe. */
static void on_viseme(
    void *context, uint32_t answer, uint32_t offset_samples,
    uint8_t viseme, uint8_t confidence) {
  (void)context;
  waveshare_avatar_note_viseme(answer, offset_samples, viseme, confidence);
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
  waveshare_audio_dma_watch(false);
  waveshare_audio_note_flush();
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
  /* The face was animating this audio; it must forget what nobody will hear. */
  waveshare_avatar_note_abandoned();
  /* And the mouth track scheduled against it dies with it. All abandon
   * sites run on the app task, which is what the viseme ledger requires. */
  waveshare_avatar_viseme_reset();
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
    waveshare_display_set_state(WAVESHARE_UI_LISTENING);
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
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("hold the upper button to talk");
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
    waveshare_display_set_call_active(true);
    /* The viseme lane owns the mouth for the duration of the call. */
    waveshare_avatar_set_call_active(true);
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("hold the upper button to talk");
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
    waveshare_display_set_call_active(false);
    /* Envelope mouth returns for whatever local life the face has next. */
    waveshare_avatar_set_call_active(false);
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status(
        waveshare_display_call_requested() ? "reconnecting" : "call ended");
  }
}

/* Transcript state drives the face; this minimal target retains no transcript. */
static void on_transcript(
    void *context, bool from_user, const char *text, bool final) {
  (void)context;
  (void)from_user;
  (void)text;
  (void)final;
  if (!from_user) {
    waveshare_display_set_state(WAVESHARE_UI_SPEAKING);
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

static void playback_task(void *argument) {
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
  struct iterate_kit_voice_playback_clock playout_clock;
  uint64_t last_write_ms = 0U;
  iterate_kit_voice_playback_clock_init(&playout_clock);
  (void)argument;
  for (;;) {
    size_t received;

    (void)playback_apply_reprime(&playout_clock);
    if (atomic_exchange_explicit(
            &runtime.speaker_answer_done, false, memory_order_acq_rel)) {
      iterate_kit_voice_playback_clock_answer_done(&playout_clock);
    }
    if (!iterate_kit_voice_playback_clock_ready(
            &playout_clock, speaker_queued_bytes())) {
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
      waveshare_audio_dma_watch(false);
      ++runtime.speaker_waits_priming;
      /* Idle, not starving: nothing is playing, so write nothing. */
      if (last_write_ms != 0U &&
          iterate_kit_voice_elapsed_ms(now_ms(NULL), last_write_ms) > SPEAKER_IDLE_POWERDOWN_MS) {
        waveshare_audio_amplifier(false);
      }
      DELAY_MS(5);
      continue;
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
      waveshare_audio_dma_draining();
      waveshare_audio_dma_watch(false);
    }
    received = xQueueReceive(
                   runtime.speaker_queue,
                   &frame,
                   pdMS_TO_TICKS(SPEAKER_DRY_WAIT_MS)) == pdTRUE
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
    if (received > 0U && playback_apply_reprime(&playout_clock)) {
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
      continue;
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
      waveshare_audio_dma_watch(false);
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
              &playout_clock, now_ms(NULL)) ==
          ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) {
        /* Kept as telemetry: how often the source could not keep up. It no
         * longer costs the listener anything. */
        ++runtime.speaker_conceal_frames;
        atomic_store_explicit(
            &runtime.starve_at_ms, now_ms(NULL), memory_order_release);
      }
      continue;
    }

    if (frame.generation != atomic_load_explicit(
                                &runtime.speaker_generation,
                                memory_order_acquire)) {
      /* A replacement raced this frame after it left the synchronized queue. */
      (void)atomic_fetch_add_explicit(
          &runtime.speaker_discarded_frames, 1U, memory_order_relaxed);
      waveshare_audio_dma_watch(false);
      continue;
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
              &playout_clock,
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
        continue;
      }

    /*
     * Pay the debt: one frame concealed, one late frame dropped. Without
     * this, every concealment would permanently add its own duration to
     * playout lag and the buffer would ratchet toward full.
     */
      if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_DEBT) {
        ++runtime.speaker_debt_paid;
        continue;
      }
    }

    const uint64_t write_started_ms = now_ms(NULL);
    waveshare_audio_dma_watch(true);
#ifdef ITERATE_KIT_DIAGNOSTIC_STARVATION
    /*
     * FAULT INJECTION, and it must land where a real gap would.
     *
     * Placed AFTER the arm and gated on a full ring already credited, because
     * the first attempt sat before the arm: a recent dry receive had disarmed
     * the watch, the delay ran unarmed, and the arm that followed reset the
     * written-audio counter — telemetry showed sends=2 written=20 at the moment
     * of the injection, which is that reset. Pending is not consumed until the
     * answer is genuinely under way, so it waits for the right frame rather than
     * being spent on the wrong one.
     */
    if (waveshare_audio_starvation_pending() &&
        waveshare_audio_dma_written_ms() >= DMA_RING_CREDIT_MS) {
      const uint32_t starve_ms = waveshare_audio_take_injected_starvation();
      ESP_LOGW(tag, "injecting %ums of starvation mid-answer", (unsigned)starve_ms);
      DELAY_MS(starve_ms);
    }
#endif
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
      waveshare_avatar_observe_playout(frame.samples, received / 2U);
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
    last_write_ms = now_ms(NULL);
    atomic_store_explicit(
        &runtime.speaker_last_write_ms, last_write_ms, memory_order_release);
  }
}

/* --- microphone path ------------------------------------------------------ */

static void capture_task(void *argument) {
  static struct mic_frame near_frame;
  static struct mic_frame processed_frame;
  (void)argument;
  for (;;) {
    size_t sample_count = 0U;
    const enum iterate_kit_status read_status = iterate_kit_audio_codec_read(
        &runtime.codec,
        near_frame.samples,
        NULL,
        FRAME_SAMPLES,
        &sample_count);
    if (read_status == ITERATE_KIT_UNAVAILABLE) {
      DELAY_MS(1);
      continue;
    }
    if (read_status != ITERATE_KIT_OK || sample_count != FRAME_SAMPLES) {
      ++runtime.mic_process_failures;
      DELAY_MS(1);
      continue;
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
      continue;
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
      continue;
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
      waveshare_display_hold_talk(true);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      waveshare_display_hold_talk(false);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
      waveshare_display_request_call(true);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      waveshare_display_request_call(false);
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      break;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

/* Defined beside waveshare_health_json, which it adapts. */
static size_t render_health(void *context, char *out, size_t capacity);


/* The one board-specific fact the portable speaker capability needs. */
static enum iterate_kit_status speaker_set_volume(
    void *context, uint8_t percent, uint8_t *applied) {
  (void)context;
  return waveshare_audio_set_volume(percent, applied);
}

static uint8_t speaker_volume(void *context) {
  (void)context;
  return waveshare_audio_volume();
}

static bool initialise_connection(void) {
  static const char *const client_path = "/clients/waveshare";
  static struct iterate_kit_module modules[4];
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
    modules[module_count++] =
        iterate_kit_push_to_talk_module(&runtime.push_to_talk);
    modules[module_count++] =
        iterate_kit_conversation_control_module(&runtime.conversation_control);
  }
  /*
   * TURN IT UP. Every board here shipped at a volume somebody measured once
   * and nobody could change without a reflash, and all four were reported as
   * too quiet. The driver keeps its ceiling; the knob is now a call away.
   */
  {
    const struct iterate_kit_speaker_driver driver = {
      .context = NULL,
      .set_volume = speaker_set_volume,
      .volume = speaker_volume,
      .ceiling = WAVESHARE_AUDIO_VOLUME_CEILING,
    };
    if (iterate_kit_speaker_init(&speaker, &driver) == ITERATE_KIT_OK) {
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
    peer_description,
    sizeof(peer_description) - 1U,
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
  options.client_path = client_path;
  options.capability = iterate_kit_peer_capability(&runtime.peer);
  /*
   * THE ONLY DESCRIPTION A MODEL EVER SEES.
   *
   * Not peer_description above — the capability host flattens this mount and
   * reports `children: {}` because sub-paths are routes the device interprets,
   * not members the host can list. So peer_description documents the device for
   * people reading this file, and THIS string is what an agent discovers in
   * itx.__describe().capabilities. It was one 46-character line, which is why a
   * back-office agent asked for the device's metrics went looking through
   * telemetry streams instead of calling health(): nothing told it the call
   * existed.
   */
  options.description = instructions;
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
size_t waveshare_health_json(char *out, size_t capacity) {
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
    {"codecCaptureOverruns", waveshare_audio_capture_overruns()},
    {"codecCaptureFailures", waveshare_audio_capture_driver_failures()},
    {"micIdle", runtime.mic_frames_idle},
    {"spkFrames", runtime.voicelab.spk_frames_received},
    {"spkPlayed", runtime.speaker_frames_played},
    {"spkOverflow",
     atomic_load_explicit(
         &runtime.speaker_overflow_drops, memory_order_relaxed)},
    /* Audio arriving just after a software-dry tick. Same signal, one step on. */
    {"spkSoftDryRefills", runtime.speaker_underruns},
    /*
     * NOT A STARVATION MEASURE — an epoch-relative ledger deficit, kept for
     * diagnosis and named so nobody gates on it again.
     *
     * The ISR credits audio per feeding epoch and debits a descriptor per send.
     * An intentional cut discards the software buffer but NOT the DMA ring, so
     * the ring keeps sending descriptors credited in the PREVIOUS epoch while
     * the re-arm has reset the ledger to zero. Measured across one barge-in:
     * written fell 380ms -> 20ms and eleven such descriptors arrived; they were
     * charged to dmaOpening that time and to this counter (+4, +2) on an earlier
     * run, differing only in how much new audio had been credited when they
     * landed. The same physical event under two names is not a gate.
     *
     * spkStarvedMs is the authoritative one: wall-clock lateness against an
     * absolute audio-empty deadline, which stayed at 0 through both cuts.
     */
    {"dmaLedgerDeficit", waveshare_audio_dma_underruns()},
    {"dmaOpening", waveshare_audio_dma_underruns_opening()},
    /* Normal answer-end drain, kept apart from the ledger deficit on purpose. */
    {"dmaDraining", waveshare_audio_dma_sends_draining()},
#ifdef ITERATE_KIT_DIAGNOSTIC_STARVATION
    /*
     * DIAGNOSTIC BUILD ONLY. These six were added to find the starvation bug and
     * they overflowed the stats line in production: the device logged
     * `health json full at "recvFailures" (1476 bytes)` and went telemetry-dark,
     * which reads downstream as "the speaker never started". The gates below are
     * what production needs; this is scaffolding.
     */
    {"dmaUnderrunFirstSend", waveshare_audio_dma_underrun_first_send()},
    {"dmaUnderrunLastSend", waveshare_audio_dma_underrun_last_send()},
    {"dmaUnderrunGapUs", waveshare_audio_dma_underrun_gap_us()},
    {"dmaOwedMs", (uint32_t)waveshare_audio_dma_owed_ms()},
    {"dmaSends", waveshare_audio_dma_sends()},
    {"dmaWrittenMs", waveshare_audio_dma_written_ms()},
#endif
    /* The task-side starvation measure: ms the ring was empty, and how often. */
    {"spkStarvedMs", waveshare_audio_starved_ms()},
    {"spkStarveEvents", waveshare_audio_starve_events()},
    /*
     * SOFTWARE-BUFFER LATENESS, absorbed by the hardware ring — not an audible
     * gap, and named so nobody gates on it. The 90ms DMA ring sits between this
     * and the listener: on the turns that moved it, spkStarvedMs was 0 and every
     * frame received was played. spkStarvedMs is the audible-failure gate.
     */
    {"spkSoftDryTicks", runtime.speaker_conceal_frames},
    {"spkCatchup", runtime.speaker_catchup_frames},
    {"spkDebtPaid", runtime.speaker_debt_paid},
    {"spkWriteFailures", runtime.speaker_write_failures},
    {"codecPlaybackFailures", waveshare_audio_playback_driver_failures()},
    {"lowerReadFailures", waveshare_buttons_lower_read_failures()},
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
    {"faceFrames", waveshare_avatar_frames_analysed()},
    {"faceDropped", waveshare_avatar_dropped_samples()},
    {"faceRenderFails", waveshare_avatar_render_failures()},
    {"batches", runtime.voicelab.batches_on_connection},
    {"connGeneration", runtime.voicelab.connection_generation},
    {"rttMs", runtime.voicelab.last_rtt_ms},
    {"pings", runtime.voicelab.ping_count},
    {"pingFailures", runtime.voicelab.ping_failures},
    {"livenessRestarts", runtime.liveness_restarts},
    {"idleRemounts", runtime.mount_watchdog.remounts},
    /* Inbound capability dispatches served. This is the liveness proof the idle
     * watchdog keys on — telemetry publishing does not move it. */
    {"servedDispatches", iterate_kit_peer_served_dispatches(&runtime.peer)},
    {"bridgeLosses", runtime.bridge_losses},
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
    {"setupFailStep", (uint32_t)runtime.voicelab.setup_failure_step},
    {"prepareTimeouts", prepare_timeouts},
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
      waveshare_display_call_requested() ? "true" : "false",
      runtime.talking ? "true" : "false",
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
  if (used + 2U >= capacity) return 0U;
  out[used++] = '}';
  out[used] = '\0';
  return used;
}

static size_t render_health(void *context, char *out, size_t capacity) {
  (void)context;
  return waveshare_health_json(out, capacity);
}

static void append_stats(uint64_t now) {
  static const char prefix[] =
      "[{\"type\":\"events.iterate.com/voice-agent/dev-stats\",\"ephemeral\":true,\"payload\":";
  const size_t prefix_length = sizeof(prefix) - 1U;
  size_t body;
  (void)now;
  memcpy(runtime.stats_buffer, prefix, prefix_length);
  body = waveshare_health_json(
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
 * A conversation nobody has had before.
 *
 * The path IS the conversation's identity, so a new path is the whole of
 * "start fresh" — there is no history to clear, because a stream nobody has
 * written to has none.
 *
 * NAMED AFTER THE SECOND IT WAS STARTED, with nothing random appended. The
 * name used to be two words from the hardware RNG, which made collisions
 * impossible but also made every conversation in a list indistinguishable from
 * every other. Seconds are unique per device by construction — a device cannot
 * start two conversations in the same second — and two DEVICES doing it in the
 * same second would have to be in the same project and pressed within that
 * second of each other. That is the trade: a readable name everywhere, against
 * a collision nobody in this lab will ever see. The RNG name remains for the
 * case that genuinely cannot be named after a time: a clock that has not
 * arrived.
 */
static bool begin_new_conversation(void) {
  char candidate[sizeof(stream_path)];
  char when[20];

  if (clock_slug(when, sizeof(when))) {
    (void)snprintf(candidate, sizeof(candidate), "/agents/voice/%s", when);
  } else {
    (void)snprintf(candidate, sizeof(candidate), "/agents/voice/dev-%08lx%08lx",
                   (unsigned long)esp_random(), (unsigned long)esp_random());
  }
  /*
   * ANSWERED, so the caller does not latch a wait on a request that was never
   * made. `setup_succeeded`/`setup_failed` only ever fire for a request that
   * actually went out — a refusal here produces neither, so a caller that had
   * already set "waiting for a fresh stream" would wait for the rest of the
   * device's life.
   */
  if (iterate_kit_voicelab_setup_conversation(&runtime.voicelab, candidate) !=
      CAPNWEB_OK) {
    /* Leave the prior status either way; the setup request has completed. */
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("could not ask the server");
    return false;
  }
  (void)snprintf(pending_stream_path, sizeof(pending_stream_path), "%s",
                 candidate);
  waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
  waveshare_display_set_status("preparing a new conversation...");  return true;
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
  waveshare_display_set_fault();
  waveshare_display_set_link_ready(false);
  waveshare_display_set_status(what);
  for (;;) {
    (void)esp_task_wdt_reset();
    /* LVGL's own timer owns this panel, so there is nothing to pump. */
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

void iterate_kit_waveshare_s3_amoled_run(void) {
  TaskHandle_t capture_task_handle = NULL;
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
    return;
  }
  /*
   * Subscribe only after provisioning succeeds. An intentionally unprovisioned
   * board returns to its setup path; subscribing before that return created a
   * watchdog reboot loop. From here onward this task owns every recovery path,
   * so a stall must still reboot loudly.
   */
  (void)esp_task_wdt_add(NULL);
  /*
   * Display first: its bring-up pulses the board's shared reset lines (the
   * panel, the touch controller and their neighbours hang off one TCA9554),
   * and doing that after the codec is configured would reset the codec.
   */
  if (!waveshare_display_init()) {
    ESP_LOGE(tag, "display bring-up failed");
    return;
  }
  if (!waveshare_audio_init()) {
    ESP_LOGE(tag, "audio bring-up failed");
    return;
  }
  runtime.codec = waveshare_audio_codec();
  runtime.processor = iterate_kit_audio_processor_passthrough();
  if (iterate_kit_audio_codec_validate(&runtime.codec) != ITERATE_KIT_OK ||
      iterate_kit_audio_processor_validate(&runtime.processor) !=
          ITERATE_KIT_OK ||
      runtime.codec.properties->capture_sample_rate_hz !=
          runtime.processor.properties->sample_rate_hz ||
      runtime.processor.properties->frame_samples != FRAME_SAMPLES ||
      (runtime.processor.properties->requires_reference_channel &&
       !runtime.codec.properties->has_reference_channel) ||
      iterate_kit_audio_processor_reset(&runtime.processor) != ITERATE_KIT_OK) {
    park_with_fault("incompatible codec and audio processor");
  }
  (void)waveshare_buttons_init();
  waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
  waveshare_display_set_status("connecting to iterate");
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
    waveshare_display_set_status("network start failed — retrying");
    for (int wait = 0; wait < 50; ++wait) {
      (void)esp_task_wdt_reset();
      /* LVGL's own timer owns this panel, so there is nothing to pump. */
      vTaskDelay(pdMS_TO_TICKS(100));
    }
  }
  if (xTaskCreatePinnedToCore(
          capture_task,
          "vl-capture",
          4096,
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
      "voicelab voice client ready: static_bytes=%u stream=/voice-agent/dev-waveshare",
      (unsigned int)sizeof(runtime));

  uint64_t next_stats_at = 0;
  uint64_t next_ping_at = 0;
  uint64_t next_button_poll_at = 0;

  for (;;) {
    (void)esp_task_wdt_reset();
    (void)iterate_kit_esp_idf_itx_transport_poll(&runtime.transport, 16U);
    /*
     * The talk button lives on the TCA9554, so every poll is an I2C
     * transaction on the bus the codec and touch controller share. At the
     * loop's 5 ms cadence that was 200 reads a second of pure contention;
     * 25 ms is still far faster than a human can press.
     */
    if (now_ms(NULL) >= next_button_poll_at) {
      next_button_poll_at = now_ms(NULL) + BUTTON_POLL_MS;
      waveshare_buttons_poll();
    }
    /*
     * Give the capability modules a turn.
     *
     * Nothing on this device did this before, which meant any method that
     * DEFERRED its reply — showImage, and conversation.interruptPlayback —
     * left the caller waiting forever. A deferred reply is only a promise that
     * something will come back to it; this is the something.
     */
    (void)iterate_kit_peer_poll(&runtime.peer, now_ms(NULL));
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
      waveshare_display_set_api_ready(api_ready);
      waveshare_display_set_stream_ready(stream_ready);
      if (ready != published_link_ready) {
        published_link_ready = ready;
        waveshare_display_set_link_ready(ready);
      }
    }
    /*
     * Let the face's delay line drain on this task, which is the only one that
     * writes to the analyzer. Without it the last 90ms of every answer would
     * never be animated and the mouth would stop open — see waveshare_avatar.h.
     */
    waveshare_avatar_tick();
    if (waveshare_buttons_take_lower_press()) {
      waveshare_display_request_call(false);
      ESP_LOGI(tag, "lower button: ending call");
    }
    if (waveshare_buttons_take_upper_press() &&
        !runtime.voicelab.call_active) {
      waveshare_display_request_call(true);
      ESP_LOGI(tag, "upper button: starting call");
    }
    {
      static bool talk_logged;
      const bool talk = waveshare_buttons_upper_held();
      if (talk != talk_logged) {
        talk_logged = talk;
        ESP_LOGI(tag, "PWR %s", talk ? "down (talking)" : "up (commit)");
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
        waveshare_display_set_status(
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
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
     * LIVENESS, not optimism.
     *
     * FAILED is the honest failure, and the block above handles it. The one
     * that cost a whole night is the dishonest one: the socket stays open,
     * the transport stays READY, and nothing moves in either direction — a
     * half-open TCP connection is indistinguishable from a quiet one from
     * this end. The device went on believing it had a session and a call,
     * lit "listening" and "speaking" at the user, and sent every word into
     * a void for hours.
     *
     * A one-way append cannot detect this, and by design never will. The
     * ping is the only pulled call on this lane, so its resolution is the
     * device's single proof that the far end is still processing what it
     * sends. Two remedies, in order of violence: replace the transport, and
     * if even that has not restored a round trip, restart the chip.
     */
    {
      static uint64_t last_liveness_ms;
      /** When the transport last stopped being ready; 0 while it is ready. */
      static uint64_t not_ready_since_ms;
      static uint32_t last_ping_count;
      static uint64_t next_liveness_restart_at;
      if (last_liveness_ms == 0U) last_liveness_ms = now;
      if (runtime.voicelab.ping_count != last_ping_count) {
        last_ping_count = runtime.voicelab.ping_count;
        last_liveness_ms = now;
      }
      /*
       * Not being CONNECTED is a different fault, and the block above owns
       * it. But a transport that is READY while the voicelab mount is not is
       * nobody's fault by that reckoning — and it is the worst state the
       * device has: every producer sits behind one gate, so the device goes
       * on answering RPCs perfectly while starting no calls, sending no
       * audio, and pushing no telemetry. That is not a quiet device, it is a
       * broken one, and it must be on this clock.
       */
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
        last_liveness_ms = now;
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
      if (runtime.voicelab.ping_pending &&
          iterate_kit_voice_elapsed_ms(now, runtime.voicelab.ping_started_ms) > PING_TIMEOUT_MS &&
          now >= next_liveness_restart_at) {
        next_liveness_restart_at = now + PING_TIMEOUT_MS;
        ++runtime.liveness_restarts;
        ESP_LOGE(
            tag,
            "no answer to a ping in %us — replacing the transport",
            (unsigned int)(PING_TIMEOUT_MS / 1000U));
        waveshare_display_set_status("reconnecting");
        iterate_kit_esp_idf_itx_transport_request_restart(&runtime.transport);
      }
      /*
       * A prepared conversation is adopted only once the server says it is
       * ready. Swapping the path first would point the device at a stream
       * with no processor on it, which looks exactly like a dead device.
       */
      if (runtime.voicelab.setup_succeeded) {
        runtime.voicelab.setup_succeeded = false;
        (void)snprintf(
            stream_path, sizeof(stream_path), "%s", pending_stream_path);
        ESP_LOGI(tag, "new conversation ready: %s", stream_path);
        /* NOT the path: the menu draws that as its headline, and printing it
         * again here put the same string on screen twice. */
        waveshare_display_set_status("new conversation ready");
        /* Fresh, and the call that was waiting for it may now happen here. */
        stream_used = false;
        awaiting_fresh_stream = false;
        /* Remount: the mount is bound to the path it was made with. */
        runtime.voicelab_generation = 0U;
        /*
         * A conversation prepared AHEAD of a tap must not place its
         * own call — it exists so that the tap, when it comes, is
         * cheap. Only a preparation somebody asked for starts one.
         */
        if (!preparing_ahead) {
          waveshare_display_request_call(true);
        }
        preparing_ahead = false;
      }
      /* A prepare nothing ever answered must not latch the ladder shut. */
      if (awaiting_fresh_stream && awaiting_since_ms != 0U &&
          iterate_kit_voice_elapsed_ms(now, awaiting_since_ms) >
              ITERATE_KIT_VOICE_PREPARE_TIMEOUT_MS) {
        ++prepare_timeouts;
        awaiting_fresh_stream = false;
        preparing_ahead = false;
        awaiting_since_ms = 0U;
        ESP_LOGW(tag, "preparing a conversation went unanswered — trying again");
      }
      if (runtime.voicelab.setup_failed) {
        runtime.voicelab.setup_failed = false;
        ESP_LOGE(tag, "could not prepare %s", pending_stream_path);
        /* The call it was for cannot happen; drop the intent rather than
         * leaving the device retrying a stream that was never made. */
        awaiting_fresh_stream = false;
        preparing_ahead = false;
        waveshare_display_request_call(false);
        waveshare_display_set_state(WAVESHARE_UI_IDLE);
        waveshare_display_set_status("could not start a new conversation");
      }
      if (iterate_kit_voice_elapsed_ms(now, last_liveness_ms) > NO_LIVENESS_RESTART_MS) {
        ESP_LOGE(
            tag,
            "no round trip in %us despite a ready transport — restarting",
            (unsigned int)(NO_LIVENESS_RESTART_MS / 1000U));
        iterate_kit_esp_restart_with_note("no round trip on a ready transport");
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
    if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED &&
        runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY) {
      static struct iterate_kit_retry_gate remount_gate;
      static bool remount_gate_ready;
      if (!remount_gate_ready) {
        remount_gate_ready =
            iterate_kit_retry_gate_init(&remount_gate, 2000U, 30000U) ==
            ITERATE_KIT_OK;
      }
      if (remount_gate_ready &&
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
        .conversation_id = CONVERSATION_ID,
        .now_ms = now_ms,
        .clock_context = NULL,
        .on_speaker = on_speaker_pcm,
        .on_control = on_control,
        .on_transcript = on_transcript,
        .on_viseme = on_viseme,
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
        waveshare_display_set_state(WAVESHARE_UI_IDLE);
        /*
         * NOTHING. The menu's headline is the path and its context line already
         * carries the connection state, so "ready" here was the same word twice
         * on adjacent rows. The status line is for transients — "reconnecting",
         * "call ended" — and being empty is the honest steady state.
         */
        waveshare_display_set_status("");
      } else if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED) {
        /* A dead session takes the call with it; the button starts over. */
        waveshare_display_request_call(false);
        waveshare_display_set_call_active(false);
        waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
        waveshare_display_set_status(
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
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
      waveshare_display_hold_talk(false);
      waveshare_display_set_state(WAVESHARE_UI_IDLE);
      waveshare_display_set_status("connection lost — press upper to call");
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
      const bool wants_call = waveshare_display_call_requested();
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
      const bool wants_talk = wants_call &&
          (waveshare_buttons_upper_held() || waveshare_display_talk_held());

      /*
       * The bridge holds the call in a Durable Object this device cannot
       * see, and it can stop — evicted, redeployed, or simply gone — without
       * appending the conversation-ended that would say so. Overnight that left the
       * device holding a call that had not existed for hours.
       *
       * So the call is believed only while its bridge keeps proving it is
       * there. Every bridge-sourced event counts, and the pong answering our
       * own ping is the one that arrives when nobody is speaking. Losing the
       * proof drops the BELIEF, never the INTENT: wants_call is still true,
       * so the reconcile immediately below opens a fresh call and the user's
       * next press finds a working device.
       */
      if (runtime.voicelab.call_active &&
          runtime.voicelab.last_bridge_ms != 0U &&
          iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_bridge_ms) > BRIDGE_SILENCE_MS) {
        ++runtime.bridge_losses;
        ESP_LOGE(
            tag,
            "no word from the bridge in %us — that call is gone",
            (unsigned int)(BRIDGE_SILENCE_MS / 1000U));
        iterate_kit_voicelab_forget_call(&runtime.voicelab);
        runtime.talking = false;
        runtime.flushing_turn = false;
        waveshare_display_hold_talk(false);
        waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
        waveshare_display_set_status(
            wants_call ? "call dropped — reconnecting" : "call dropped");
        /* Reconnect now, not on the old backoff. */
        iterate_kit_launch_retry_now(&launch);
      }

      /*
       * THE DOWNLINK NEEDS ITS OWN PROOF.
       *
       * Everything above trusts that if the bridge appends something, this
       * device hears it. That is one lane, held by the platform as a
       * callback registration inside the stream's Durable Object, and it can
       * be lost on its own: measured here, a device pinging happily every
       * five seconds (uplink resolving, RTT 130ms) while eight conversation-accepted
       * events and eleven pongs were appended by live bridges and NOT ONE of
       * them arrived. Its batch counter did not move for 68 seconds. The UI
       * said "starting call" the whole time, which is exactly what a person
       * sees, and nothing in the device was ever going to notice: the socket
       * was fine, the session was fine, the appends were fine.
       *
       * Silence is only evidence when traffic is expected. It is expected
       * whenever a call is wanted: a live bridge pongs every ping, so ten
       * seconds without a single batch means the lane is dead, not quiet.
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
            .preparing = awaiting_fresh_stream,
            .stream_used = stream_used,
            .wants_call = wants_call,
        };
        switch (iterate_kit_launch_next_step(&launch, &launching)) {
          case ITERATE_KIT_LAUNCH_PREPARE_AHEAD:
            ESP_LOGI(tag, "idle: preparing the next conversation in advance");
            preparing_ahead = begin_new_conversation();
            awaiting_fresh_stream = preparing_ahead;
            awaiting_since_ms = now;
            break;
          case ITERATE_KIT_LAUNCH_PREPARE_NOW:
            ESP_LOGI(tag, "call asked for: preparing a fresh conversation");
            awaiting_fresh_stream = begin_new_conversation();
            awaiting_since_ms = now;
            break;
          case ITERATE_KIT_LAUNCH_PLACE_CALL:
            call_pending_since = now;
            if (iterate_kit_voicelab_start_call(&runtime.voicelab, GREETING) ==
                CAPNWEB_OK) {
              waveshare_display_set_status("starting call");
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
        waveshare_audio_dma_watch(false);
        (void)iterate_kit_voicelab_end_call(&runtime.voicelab, "button");
        waveshare_display_set_status("call ended");
        waveshare_display_set_state(WAVESHARE_UI_IDLE);
      }
      if (runtime.voicelab.call_active &&
          runtime.voicelab.call_active != call_active_shown) {
        runtime.speaker_margin_min_ms = 0U;
        runtime.speaker_writes = 0U;
      }
      if (runtime.voicelab.call_active != call_active_shown) {
        call_active_shown = runtime.voicelab.call_active;
        waveshare_display_set_call_active(call_active_shown);
        /*
         * Belt to on_control's braces: a call forgotten for lost liveness
         * never sends CALL_ENDED, and the envelope mouth must not stay gated
         * on a call that no longer exists. Idempotent when on_control already
         * flipped it.
         */
        waveshare_avatar_set_call_active(call_active_shown);
        if (call_active_shown) {
          /* This stream has now hosted a conversation, so the next call will
           * be made somewhere else. Marked on the ACCEPTED edge rather than on
           * the request, because a call that never connected left no history. */
          stream_used = true;
          /*
           * Display only. The playout reset for a new call lives in on_control's
           * CALL_ACCEPTED branch, on the receive path that classifies frames —
           * this observation runs later and could follow the call's first frame.
           */
          waveshare_display_set_state(WAVESHARE_UI_IDLE);
          waveshare_display_set_status("hold the upper button to talk");
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
        waveshare_display_hold_talk(false);
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
          ESP_LOGI(tag, "turn start");
          /*
           * The face attends and shuts its mouth. Told rather than inferred from
           * silence: the audio it was animating has just been discarded, and
           * without this the last shape of the interrupted word would sit on the
           * face for the whole time the person is speaking.
           */
          waveshare_avatar_set_listening(true);
          waveshare_display_set_state(WAVESHARE_UI_LISTENING);
          waveshare_display_set_status("listening — release to send");
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
        waveshare_display_set_status("sending");
      }
      if (runtime.flushing_turn &&
          (runtime.flush_frames_left == 0U ||
           now >= runtime.flush_deadline_ms)) {
        const bool timed_out = runtime.flush_frames_left > 0U;
        runtime.talking = false;
        runtime.flushing_turn = false;
        ESP_LOGI(tag, "turn commit%s", timed_out ? " (tail dropped)" : "");
        /* Done listening: the face waits for the answer rather than for us. */
        waveshare_avatar_set_listening(false);
        if (publish_turn_marker(ITERATE_KIT_VOICELAB_TURN_COMMIT)) {
          waveshare_display_set_state(WAVESHARE_UI_SPEAKING);
          waveshare_display_set_status("thinking");
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
        waveshare_display_set_status("re-registering");
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
      if (next_ping_at == 0U) {
        next_ping_at = now + 1000U;
        next_stats_at = now + STATS_INTERVAL_MS;
      }
      if (now >= next_ping_at && outbox_free >= 3U) {
        (void)iterate_kit_voicelab_ping(&runtime.voicelab);
        next_ping_at = now + PING_INTERVAL_MS;
      }
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
    DELAY_MS(5);
  }
}
