/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 — the Iterate voice device.
 *
 * The whole product is here: an on-screen Iterate UI (start call / hang up,
 * live transcript), a live capability at kit.waveshare so an agent can drive
 * the screen and the call, and the voice pipe itself.
 *
 * ONE Cap'n Web WebSocket to /api carries everything, exactly like the
 * TypeScript voicelab client: authenticate -> projects.get -> streams.get,
 * then 50 Hz one-way appends of ephemeral voicelab/mic-frame events (real
 * ES8311 microphone), and a live openConnection callback delivering
 * voicelab/spk-frame events (decoded to the speaker) plus grok-events
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
 * Observability is the stream itself (durable voicelab/dev-stats every 5s);
 * opening the USB console resets the board.
 *
 * DELIBERATE DEPARTURE from the dual-WebSocket decision in
 * docs/fable-v2-plan/DECISIONS.md — this target is the single-socket
 * measurement that decision asked for.
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

#include "capnweb/capnweb.h"
#include "iterate/kit/audio_playout.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/device_menu.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voicelab_stream.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice_playback_clock.h"
#include "waveshare_audio.h"
#include "waveshare_buttons.h"
#include "waveshare_conversation_store.h"
#include "waveshare_display.h"
#include "waveshare_recorder.h"
#include "waveshare_tools.h"

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
  IDLE_REMOUNT_MS = ITERATE_KIT_VOICE_IDLE_REMOUNT_MS,
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
#define STREAM_PATH_DEFAULT "/voicelab/device"
static char stream_path[96] = STREAM_PATH_DEFAULT;
/*
 * The path a setup call is preparing. Kept apart from the live one so a setup
 * that fails leaves the device on the conversation it already had, rather than
 * pointed at a stream nobody has prepared.
 */
static char pending_stream_path[96];
#define CALL_ID "wsdev"
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

static struct {
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
  struct iterate_kit_module modules[1];
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
  char stats_buffer[1536];
  uint32_t stats_sequence;
  enum iterate_kit_esp_idf_itx_transport_state last_transport_state;
  enum iterate_kit_voicelab_state last_voicelab_state;
  /* Cross-task audio plumbing. */
  QueueHandle_t mic_queue;
  StreamBufferHandle_t speaker_buffer;
  volatile uint32_t speaker_discard_bytes; /* barge-in: playback task skips */
  volatile uint64_t speaker_last_write_ms;
  uint32_t mic_frames_captured;
  uint32_t mic_frames_dropped;
  /** Captured with no turn open: room noise, never sent, never queued. */
  uint32_t mic_frames_idle;
  uint32_t mic_frames_gated;
  uint32_t speaker_frames_played;
  uint32_t speaker_overflow_drops;
  /*
   * Audio removed by the barge-in discard.
   *
   * This was the ONLY path that could delete queued speech without
   * incrementing anything, and that is exactly what it did: 758 frames
   * arrived, 150 played, the ring empty, and every other counter zero. A
   * silent drop path turns a five-minute measurement into an afternoon of
   * theories - two of which were wrong - so it counts now.
   */
  uint32_t speaker_discarded_frames;
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
  volatile uint64_t starve_at_ms;
  /*
   * Proving "no underruns" needs more than a count of holes: it needs the
   * MARGIN distribution. Every write records how much audio was still queued
   * behind it, so the minimum over a call says how close the pipe ever came
   * to running dry. A run with a healthy floor is evidence; a zero count on
   * its own only says none happened to fire this time.
   */
  uint32_t speaker_margin_min_ms;
  uint32_t speaker_margin_p10_ms;
  uint32_t speaker_writes;
  uint32_t speaker_bad_frames;
  uint32_t barge_in_flushes;
  /* Transports torn down because a ping went unanswered. */
  uint32_t liveness_restarts;
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
  volatile bool speaker_reprime;
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
  volatile uint64_t answer_started_ms;
  volatile uint32_t answer_emitted_ms;
  /** When an RPC was last answered: the mount's own liveness, not the socket's. */
  volatile uint64_t last_served_ms;
  /* What the two buttons mean between calls; see device_menu.h. */
  struct iterate_kit_menu menu;
  uint32_t speaker_lag_max_ms;
  volatile bool speaker_answer_done;
  uint32_t flush_frames_left;
  uint64_t flush_deadline_ms;
  uint64_t turn_started_ms;
} runtime;

/* What `itx.kit.waveshare` looks like to whoever holds the capability. */
static const char peer_description[] =
    "{\"instructions\":\"An Iterate voice device: a 368x448 AMOLED showing "
    "the call state and live transcript, two physical buttons (BOOT toggles "
    "the call, PWR is held to speak), a microphone and a speaker. Turn "
    "taking is manual: hold to talk, release to get an answer.\","
    "\"children\":{"
    "\"setBackground\":\"Fill the screen background with a colour — hex "
    "(#1e293b) or a name (navy, teal, iterate).\","
    "\"takeScreenshot\":\"Capture the screen; returns {width,height,"
    "format,bytes,chunkSize,chunks} and readScreenshotChunk(i) returns each "
    "chunk as bytes.\","
    "\"readScreenshotChunk\":\"Read chunk i of the last takeScreenshot.\","
    "\"setVolume\":\"Speaker volume 0-100.\","
    "\"setMicGain\":\"Microphone PGA in dB, 0-48.\","
    "\"recording\":{\"size\":\"Bytes of a recorded file from the current "
    "call: mic.pcm and speaker.pcm are 16kHz mono s16le, call.log is text.\","
    "\"read\":\"Read (name, byteOffset) and get the next chunk as bytes.\"},"
    "\"conversation\":{\"start\":\"Start a voice call — the same intent as "
    "the BOOT button.\","
    "\"hangUp\":\"End the current call.\"},"
    "\"pushToTalk\":{\"start\":\"Begin a spoken turn — the same intent as "
    "holding PWR. Cancels any answer in flight.\","
    "\"stop\":\"End the turn: commits what was said and asks for the "
    "answer.\"}}}";

/*
 * A Cap'n Web session's capability ids die with it. Appending through a
 * voicelab struct that outlived its session poisons the NEXT session with
 * unknown export ids, which the server correctly aborts — so the moment the
 * session ends, the voicelab machine is forced dead; the main loop restarts
 * it fresh for the next connection generation.
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

/* --- speaker path (voicelab callbacks run on the app task) ---------------- */

static void on_speaker_pcm(
    void *context,
    const uint8_t *pcm,
    size_t pcm_length,
    const struct iterate_kit_playout_frame *identity) {
  enum iterate_kit_playout_action action;
  (void)context;
  /*
   * A frame goes in whole or not at all. A partial write splices the head of
   * one frame onto the next at an arbitrary phase, which is a click — and at
   * a full buffer that happens to EVERY frame. An odd length would shift the
   * 16-bit sample grid permanently, so it is refused outright.
   */
  if ((pcm_length & 1U) != 0U || identity == NULL) {
    ++runtime.speaker_bad_frames;
    return;
  }
  action = iterate_kit_playout_classify(&runtime.playout, identity);
  if (action == ITERATE_KIT_PLAYOUT_IGNORE) return;
  if (action == ITERATE_KIT_PLAYOUT_REPLACE) {
    /*
     * StreamBuffer has one reader, so the callback cannot reset it safely.
     * Snapshot exactly the stale prefix and have playback skip that many
     * bytes; the replacement frame appended below is therefore retained.
     */
    runtime.speaker_discard_bytes =
        (uint32_t)xStreamBufferBytesAvailable(runtime.speaker_buffer);
    runtime.speaker_reprime = true;
    /* A new answer is a new timeline: lag does not carry across answers. */
    runtime.answer_started_ms = 0U;
    runtime.answer_emitted_ms = 0U;
  }
  if (xStreamBufferSpacesAvailable(runtime.speaker_buffer) < pcm_length) {
    ++runtime.speaker_overflow_drops;
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
  runtime.speaker_answer_done = false;
  /*
   * Audio arriving within a second of a starve means the answer was still
   * going: the pipe genuinely ran dry mid-speech, and that is audible.
   */
  if (runtime.starve_at_ms != 0U) {
    const uint64_t now = now_ms(NULL);
    if (iterate_kit_voice_elapsed_ms(now, runtime.starve_at_ms) < 1000U) {
      ++runtime.speaker_underruns;
    }
    runtime.starve_at_ms = 0U;
  }
  (void)xStreamBufferSend(runtime.speaker_buffer, pcm, pcm_length, 0);
}

static void on_control(
    void *context, enum iterate_kit_voicelab_control control) {
  (void)context;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    /* With manual turns this only fires if something re-enables VAD, but
     * flushing playback on it is still the right response. */
    /* Barge-in: tell the playback task to skip everything queued so far.
     * The buffer itself is only reset by its reader; a racing writer would
     * corrupt it. */
    runtime.speaker_discard_bytes =
        (uint32_t)xStreamBufferBytesAvailable(runtime.speaker_buffer);
    runtime.speaker_reprime = true;
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
    runtime.speaker_answer_done = true;
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
    waveshare_recorder_log("answer complete");
    /* The answer is complete: back to waiting for the next turn. */
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("hold the upper button to talk");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    waveshare_display_set_call_active(true);
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("hold the upper button to talk");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    /*
     * Drop whatever is still queued. The ring holds thirty seconds, so a call
     * that ends mid-answer otherwise plays the dead conversation out after
     * the screen has already said it is over.
     */
    runtime.speaker_discard_bytes =
        (uint32_t)xStreamBufferBytesAvailable(runtime.speaker_buffer);
    runtime.speaker_reprime = true;
    waveshare_recorder_end_call("bridge hung up");
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
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status(
        waveshare_display_call_requested() ? "reconnecting" : "call ended");
  }
}

/* Transcript deltas land on screen as they arrive; the assistant's open line
 * is replaced until it is final. */
static void on_transcript(
    void *context, bool from_user, const char *text, bool final) {
  (void)context;
  waveshare_display_push_transcript(from_user ? "you" : "iterate", text, final);
  if (final) {
    waveshare_recorder_log("%s %s", from_user ? "you:" : "iterate:", text);
  }
  if (!from_user) {
    waveshare_display_set_state(WAVESHARE_UI_SPEAKING);
  }
}

/* Owns every SD write, so card latency never touches an audio task. */
static void recorder_task(void *argument) {
  (void)argument;
  for (;;) {
    waveshare_recorder_drain();
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

static void playback_task(void *argument) {
  static int16_t chunk[FRAME_SAMPLES];
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

    if (runtime.speaker_reprime) {
      runtime.speaker_reprime = false;
      runtime.speaker_answer_done = false;
      iterate_kit_voice_playback_clock_reprime(&playout_clock);
    }
    if (runtime.speaker_answer_done) {
      runtime.speaker_answer_done = false;
      iterate_kit_voice_playback_clock_answer_done(&playout_clock);
    }
    if (!iterate_kit_voice_playback_clock_ready(
            &playout_clock,
            (uint32_t)xStreamBufferBytesAvailable(runtime.speaker_buffer))) {
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
    received = xStreamBufferReceive(
        runtime.speaker_buffer, chunk, sizeof(chunk),
        pdMS_TO_TICKS(SPEAKER_DRY_WAIT_MS));

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
    if (received > 0U && runtime.speaker_reprime) {
      runtime.speaker_reprime = false;
      runtime.speaker_answer_done = false;
      iterate_kit_voice_playback_clock_reprime(&playout_clock);
      /* Put it back: it belongs to the answer we are about to prime for. */
      (void)xStreamBufferSend(runtime.speaker_buffer, chunk, received, 0);
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
      ++runtime.speaker_waits_dry;
      if (iterate_kit_voice_playback_clock_empty(
              &playout_clock, now_ms(NULL)) ==
          ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) {
        /* Kept as telemetry: how often the source could not keep up. It no
         * longer costs the listener anything. */
        ++runtime.speaker_conceal_frames;
        runtime.starve_at_ms = now_ms(NULL);
      }
      continue;
    }

    if (runtime.speaker_discard_bytes > 0U) {
      const uint32_t discard = runtime.speaker_discard_bytes;
      const size_t skipped = discard < received ? (size_t)discard : received;
      runtime.speaker_discard_bytes = (uint32_t)(discard - skipped);
      runtime.speaker_discarded_frames +=
          (uint32_t)(skipped / (FRAME_SAMPLES * sizeof(int16_t)));
      if (skipped == received) continue;
      memmove(chunk, (const uint8_t *)chunk + skipped, received - skipped);
      received -= skipped;
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
              (uint32_t)xStreamBufferBytesAvailable(runtime.speaker_buffer),
              runtime.speaker_frames_played,
              iterate_kit_voice_playout_lag_ms(
                  runtime.answer_started_ms,
                  runtime.answer_emitted_ms,
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
        runtime.answer_emitted_ms +=
            (uint32_t)(received / (FRAME_BYTES / FRAME_MS));
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
    if (waveshare_audio_write(chunk, received / 2U)) {
      ++runtime.speaker_frames_played;
      waveshare_recorder_write_speaker(chunk, received);
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
         * waveshare_audio_write blocks until the I2S driver accepts the
         * frame, which is the DMA's own pacing — up to a frame period on
         * every call. Stamping after it folds that wait into the measurement,
         * so a perfectly punctual loop reports itself progressively later and
         * the catch-up rule then deletes speech to fix a delay that only
         * existed in the metric. Measured that way: 1089 ms of "lag" while
         * the ring held 1620 ms of audio, which is the signature of a
         * consumer that is keeping up.
         */
        const uint64_t played_at = write_started_ms;
        if (runtime.answer_started_ms == 0U) {
          runtime.answer_started_ms = played_at;
          runtime.answer_emitted_ms = 0U;
        }
        {
          const uint32_t lag = iterate_kit_voice_playout_lag_ms(
              runtime.answer_started_ms, runtime.answer_emitted_ms,
              played_at);
          if (lag > runtime.speaker_lag_max_ms) {
            runtime.speaker_lag_max_ms = lag;
          }
        }
        /* Milliseconds actually emitted, so a short read advances the
         * timeline by what it played and not by a whole frame. */
        runtime.answer_emitted_ms +=
            (uint32_t)(received / (FRAME_BYTES / FRAME_MS));
      }
    } else {
      ++runtime.speaker_write_failures;
    }

    {
      const uint32_t margin_ms =
          (uint32_t)(xStreamBufferBytesAvailable(runtime.speaker_buffer) / 32U);
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
    runtime.speaker_last_write_ms = last_write_ms;
  }
}

/* --- microphone path ------------------------------------------------------ */

static void capture_task(void *argument) {
  static struct mic_frame frame;
  (void)argument;
  for (;;) {
    if (!waveshare_audio_read(frame.samples, FRAME_SAMPLES)) {
      DELAY_MS(100);
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
    if (xQueueSend(runtime.mic_queue, &frame, 0) != pdTRUE) {
      /* Freshest wins: discard the OLDEST frame, keep this one. Stale
       * speech after a network hiccup is worse than a gap — and it is the
       * only way a backlog can never delay what the customer says next. */
      struct mic_frame discarded;
      (void)xQueueReceive(runtime.mic_queue, &discarded, 0);
      (void)xQueueSend(runtime.mic_queue, &frame, 0);
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

static bool initialise_connection(void) {
  static const char *const mount_path[] = {"kit", "waveshare"};
  struct iterate_kit_itx_connection_options options;
  struct iterate_kit_esp_idf_itx_transport_options transport_options;
  struct iterate_kit_peer_options peer_options;

  runtime.modules[0] = waveshare_tools_module();
  peer_options = (struct iterate_kit_peer_options){
    peer_description,
    sizeof(peer_description) - 1U,
    runtime.modules,
    sizeof(runtime.modules) / sizeof(runtime.modules[0]),
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
  options.mount_path = mount_path;
  options.mount_path_count = sizeof(mount_path) / sizeof(mount_path[0]);
  options.capability = iterate_kit_peer_capability(&runtime.peer);
  options.instructions = "Iterate voice device (Waveshare ESP32-S3 AMOLED)";
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
/* Set by the restart capability; acted on by the app loop a moment later. */
static volatile uint64_t restart_requested_at;

void waveshare_request_restart(void) {
  restart_requested_at = now_ms(NULL);
}

size_t waveshare_health_json(char *out, size_t capacity) {
  /*
   * Answering an RPC is the only proof the mount is still reachable. Pings
   * ride the socket and prove nothing about it — which is how a device whose
   * capability had gone offline sat healthy and unreachable for minutes.
   */
  runtime.last_served_ms = now_ms(NULL);
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
    {"micIdle", runtime.mic_frames_idle},
    {"micGated", runtime.mic_frames_gated},
    {"spkFrames", runtime.voicelab.spk_frames_received},
    {"spkPlayed", runtime.speaker_frames_played},
    {"spkOverflow", runtime.speaker_overflow_drops},
    {"spkUnderruns", runtime.speaker_underruns},
    {"dmaUnderruns", waveshare_audio_dma_underruns()},
    {"dmaOpening", waveshare_audio_dma_underruns_opening()},
    {"spkConceal", runtime.speaker_conceal_frames},
    {"spkCatchup", runtime.speaker_catchup_frames},
    {"spkDebtPaid", runtime.speaker_debt_paid},
    {"spkWriteFailures", runtime.speaker_write_failures},
    {"talkReadFailures", waveshare_buttons_lower_read_failures()},
    {"spkMarginMaxMs", runtime.speaker_margin_max_ms},
    {"spkLagMaxMs", runtime.speaker_lag_max_ms},
    {"spkMarginMinMs", runtime.speaker_margin_min_ms},
    {"spkMarginP10Ms", runtime.speaker_margin_p10_ms},
    {"spkWrites", runtime.speaker_writes},
    {"spkBadFrames", runtime.speaker_bad_frames},
    {"spkSeqGaps", runtime.playout.gaps},
    {"spkDecodeFailures", runtime.voicelab.spk_decode_failures},
    {"spkDiscarded", runtime.speaker_discarded_frames},
    /*
     * The playout's own census. Every other way a frame fails to reach the
     * speaker is counted somewhere; these are the four the classifier
     * decides, and without them a refused frame leaves no trace at all.
     */
    {"spkIgnoredCall", runtime.playout.ignored_other_call},
    {"spkIgnoredStale", runtime.playout.ignored_stale_answer},
    {"spkIgnoredDup", runtime.playout.ignored_duplicate},
    {"spkReplaced", runtime.playout.replaced},
    {"spkWaitPriming", runtime.speaker_waits_priming},
    {"spkWaitDry", runtime.speaker_waits_dry},
    {"bargeIns", runtime.barge_in_flushes},
    {"batches", runtime.voicelab.batches_on_connection},
    {"connGeneration", runtime.voicelab.connection_generation},
    {"rttMs", runtime.voicelab.last_rtt_ms},
    {"pings", runtime.voicelab.ping_count},
    {"pingFailures", runtime.voicelab.ping_failures},
    {"livenessRestarts", runtime.liveness_restarts},
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
    {"resetReason", (uint32_t)esp_reset_reason()},
    {"heapFree", (uint32_t)esp_get_free_heap_size()},
    {"heapMin", (uint32_t)esp_get_minimum_free_heap_size()},
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

  /* The strings and the one 64-bit field, which do not fit the pair table. */
  written = snprintf(
      out,
      capacity,
      "{\"transport\":\"%s\",\"voicelab\":\"%s\",\"voicelabFailure\":\"%s\","
      "\"callActive\":%s,\"callPending\":%s,\"wantsCall\":%s,\"talking\":%s,"
      "\"gateOpen\":%s,\"t\":%" PRIu64 ",\"uptimeMs\":%" PRIu64,
      iterate_kit_esp_idf_itx_transport_state_name(runtime.transport.state),
      iterate_kit_voicelab_state_name(runtime.voicelab.state),
      iterate_kit_voicelab_failure_name(runtime.voicelab.failure),
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

static void append_stats(uint64_t now) {
  static const char prefix[] =
      "[{\"type\":\"voicelab/dev-stats\",\"ephemeral\":true,\"payload\":";
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
 * The deployment, in the only place that actually knows it: the URL.
 *
 * Derived rather than stored so there is not a second copy to keep in step —
 * a screen that says "prd" while the device talks to preview is worse than a
 * screen that says nothing.
 */
static const char *environment_from_base_url(const char *url) {
  const char *host = url;
  const char *scheme;

  if (url == NULL) {
    return "unknown";
  }
  scheme = strstr(url, "://");
  if (scheme != NULL) {
    host = scheme + 3;
  }
  return host;
}

/*
 * Paint the menu, plus the facts a person needs in order to know which device
 * and which conversation they are looking at.
 */
static void show_menu(void) {
  struct waveshare_menu_view view;
  uint8_t index;

  if (!runtime.menu.open) {
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    return;
  }
  memset(&view, 0, sizeof(view));
  view.item_count = (uint8_t)ITERATE_KIT_MENU_ITEM_COUNT;
  if (view.item_count > (uint8_t)WAVESHARE_MENU_ITEMS_MAX) {
    view.item_count = (uint8_t)WAVESHARE_MENU_ITEMS_MAX;
  }
  for (index = 0U; index < view.item_count; ++index) {
    view.items[index] =
        iterate_kit_menu_item_name((enum iterate_kit_menu_item)index);
  }
  view.stream_path = stream_path;
  view.project = runtime.configuration.project_id;
  view.environment = environment_from_base_url(runtime.configuration.os_base_url);
  view.connection = iterate_kit_voicelab_state_name(runtime.voicelab.state);
  view.selected = runtime.menu.selected;
  waveshare_display_set_menu(&view);
  waveshare_display_set_state(WAVESHARE_UI_MENU);
}

/*
 * A conversation nobody has had before.
 *
 * The path IS the conversation's identity, so a new path is the whole of
 * "start fresh" — there is no history to clear, because a stream nobody has
 * written to has none. Named from the hardware RNG rather than a clock: the
 * device may not have a trustworthy one this early, and two devices choosing
 * the same path would drop two people into one conversation.
 */
static void begin_new_conversation(void) {
  char candidate[sizeof(stream_path)];

  (void)snprintf(candidate, sizeof(candidate), "/agents/voice/dev-%08lx%08lx",
                 (unsigned long)esp_random(), (unsigned long)esp_random());
  if (iterate_kit_voicelab_setup_conversation(&runtime.voicelab, candidate) !=
      CAPNWEB_OK) {
    /* Leave the menu screen either way: it has already closed underneath. */
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("could not ask the server");
    return;
  }
  (void)snprintf(pending_stream_path, sizeof(pending_stream_path), "%s",
                 candidate);
  waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
  waveshare_display_set_status("preparing a new conversation...");
}

static void take_menu_action(enum iterate_kit_menu_action action) {
  if (action == ITERATE_KIT_MENU_ACTION_REBOOT) {
    ESP_LOGW(tag, "reboot chosen from the menu");
    waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
    waveshare_display_set_status("restarting...");
    waveshare_recorder_end_call("menu reboot");
    DELAY_MS(400);
    esp_restart();
    return;
  }
  if (action == ITERATE_KIT_MENU_ACTION_NEW) {
    begin_new_conversation();
    return;
  }
  /* CONTINUE: this stream is already mounted, so it is simply a call. */
  waveshare_display_request_call(true);
}

void app_main(void) {
  /*
   * The app task is the sole consumer of the control inbox and therefore the
   * producer of every speaker frame: it parses the delivery batch, base64
   * decodes the PCM and pushes it to the playback buffer, all inside a 20ms
   * budget. FreeRTOS starts it at priority 1 — below the WebSocket task, the
   * recorder and the timer service — and there is no Kconfig symbol to
   * change that (ESP_MAIN_TASK_PRIORITY does not exist; believing it did
   * left this at 1 through several rounds of "priority fixes"). So it raises
   * itself, above everything on this core except Wi-Fi, lwIP and the timers.
   */
  /*
   * 4, deliberately BELOW the WebSocket/TLS task at 5 that feeds this one.
   * At 10 the consumer outranked its own producer on the same core, and this
   * loop polls hard — so the network task got starved and everything felt
   * laggy: buttons late, UI stale, the greeting never arriving. Above LVGL
   * (2) and the recorder (1), below the producer. Priority 1 (the FreeRTOS
   * default, and what this was before) is the other extreme and was equally
   * wrong: below LVGL and the recorder both.
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
  /*
   * Subscribe to the hardware watchdog. If this loop ever stops feeding it —
   * blocked on I2C, on FatFs, on anything — the chip reboots itself. Every
   * other recovery path in this firmware runs on this task and therefore
   * cannot rescue it.
   */
  (void)esp_task_wdt_add(NULL);
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
  (void)waveshare_buttons_init();
  (void)waveshare_recorder_init();
  /*
   * Resume the conversation this device was last put on. Choosing a new one
   * is deliberate, so forgetting it at the next power cut would silently drop
   * the user back onto a conversation they had moved on from — and the screen
   * would show a path they did not pick. Anything unreadable leaves the
   * compiled-in default in place.
   */
  {
    char remembered[sizeof(stream_path)];
    if (waveshare_conversation_load(remembered, sizeof(remembered))) {
      (void)snprintf(stream_path, sizeof(stream_path), "%s", remembered);
      ESP_LOGI(tag, "resuming remembered conversation: %s", stream_path);
    }
  }
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
   * PSRAM, not internal. Growing this ring in internal RAM took 19 KiB out
   * of the headroom the TLS handshake needs and the device could not connect
   * at all: mbedtls_ssl_setup returned MBEDTLS_ERR_SSL_ALLOC_FAILED on every
   * attempt. Internal RAM here is TLS's working set, and this buffer has no
   * claim on it — it is read by a task, never by an ISR, and the I2S driver
   * copies into its own DMA ring on the way out.
   */
  /*
   * TRIGGER ON A WHOLE FRAME, NOT ON A SINGLE BYTE.
   *
   * At a trigger level of 1 the receive returns the moment any byte is
   * available — commonly 160 or 320 bytes when the source is behind. The loop
   * then counted that partial read as one whole 20 ms frame in both
   * speaker_frames_played and the playout timeline, so `due` ran ahead of the
   * audio actually emitted: lag read LOW exactly when playback was starving,
   * which is when it most needed to read high. A whole-frame trigger makes
   * every read either a frame or a timeout, and the timeout path is already
   * the one that waits.
   */
  runtime.speaker_buffer = xStreamBufferCreateWithCaps(
      SPEAKER_BUFFER_BYTES, (size_t)FRAME_BYTES, MALLOC_CAP_SPIRAM);
  if (runtime.mic_queue == NULL || runtime.speaker_buffer == NULL) {
    ESP_LOGE(tag, "audio buffer allocation failed");
    return;
  }
  if (!initialise_rings() || !initialise_connection()) {
    ESP_LOGE(tag, "bounded runtime initialization failed");
    return;
  }
  iterate_kit_playout_reset(&runtime.playout, 1U);
  if (iterate_kit_esp_idf_itx_transport_start(&runtime.transport) !=
      ITERATE_KIT_OK) {
    ESP_LOGE(
        tag,
        "transport start failed: platform=%ld",
        (long)runtime.transport.last_platform_error);
    return;
  }
  (void)xTaskCreatePinnedToCore(
      capture_task, "vl-capture", 4096, NULL, 18, NULL, 1);
  (void)xTaskCreatePinnedToCore(
      playback_task, "vl-playback", 4096, NULL, 19, NULL, 1);
  /*
   * Below everything. The audio tasks block inside the I2S driver almost all
   * the time, so 8/9 is as effective as 18/19 was and no longer out-ranks
   * lwIP — an arrangement that could starve the socket feeding playback.
   */
  (void)xTaskCreatePinnedToCore(
      recorder_task, "vl-recorder", 4096, NULL, 1, NULL, 0);
  ESP_LOGI(
      tag,
      "voicelab voice client ready: static_bytes=%u stream=/voicelab/dev-waveshare",
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
     * WHICH BUTTON MEANS WHAT, AND WHY IT IS THIS WAY ROUND.
     *
     * The lower button is PWR, wired into the board's power path: hold it and
     * the hardware powers the device off, which firmware cannot intercept.
     * It had push-to-talk on it, so talking meant holding down the one button
     * that kills the device — and it did kill it, mid-conversation. So the
     * held gesture belongs to the upper button, and the lower one is only
     * ever tapped.
     *
     * LOWER, tap:  no call -> move the menu cursor;  call up -> hang up.
     * UPPER, tap:  menu open -> take the option;     otherwise -> call.
     * UPPER, held: the microphone. Read further down, where the turn is.
     */
    if (waveshare_buttons_take_lower_press()) {
      if (runtime.voicelab.call_active || waveshare_display_call_requested()) {
        ESP_LOGI(tag, "lower button: ending the call");
        waveshare_display_request_call(false);
      } else {
        iterate_kit_menu_cycle(&runtime.menu);
        ESP_LOGI(
            tag, "menu: %s",
            iterate_kit_menu_item_name(
                (enum iterate_kit_menu_item)runtime.menu.selected));
        show_menu();
      }
    }
    if (waveshare_buttons_take_upper_press()) {
      if (runtime.voicelab.call_active || waveshare_display_call_requested()) {
        /*
         * Drained on purpose. Every push-to-talk press puts a press here, and
         * one left waiting would fire the moment the call ended — opening the
         * menu, or starting a call, that nobody asked for.
         */
        ESP_LOGD(tag, "upper press while a call is up: that press meant talk");
      } else {
        const enum iterate_kit_menu_action action =
            iterate_kit_menu_activate(&runtime.menu);
        if (action == ITERATE_KIT_MENU_ACTION_NONE) {
          ESP_LOGI(tag, "upper button: calling");
          waveshare_display_request_call(true);
        } else {
          ESP_LOGI(tag, "menu: chose option %d", (int)action);
          take_menu_action(action);
        }
      }
    }
    /* A call takes the buttons back; the menu has no business being open. */
    if (runtime.voicelab.call_active && runtime.menu.open) {
      iterate_kit_menu_close(&runtime.menu);
      waveshare_display_set_state(WAVESHARE_UI_LISTENING);
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
      if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_FAILED) {
        struct iterate_kit_esp_idf_itx_transport_metrics metrics;
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
        waveshare_recorder_end_call("device restart");
        esp_restart();
      }
    }

    if (restart_requested_at != 0U && iterate_kit_voice_elapsed_ms(now, restart_requested_at) > 400U) {
      ESP_LOGW(tag, "restart requested over itx");
      waveshare_display_set_status("restarting…");
      waveshare_recorder_end_call("restart requested");
      esp_restart();
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
      if (runtime.transport.state != ITERATE_KIT_ESP_IDF_ITX_READY) {
        last_liveness_ms = now;
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
       * NOBODY HAS ASKED US FOR ANYTHING IN A LONG TIME.
       *
       * The downlink watchdog needs a call in progress and the liveness one
       * keys on pings, so an idle device whose mount has gone offline
       * server-side is watched by neither: the socket stays healthy, the
       * pings keep answering, and every RPC fails until somebody power-cycles
       * it. Replacing the session re-mounts the capability, which is the one
       * thing that fixes it.
       */
      if (runtime.voicelab_generation == runtime.connection.generation &&
          runtime.last_served_ms != 0U &&
          iterate_kit_voice_elapsed_ms(now, runtime.last_served_ms) >
              IDLE_REMOUNT_MS) {
        ESP_LOGW(
            tag, "no RPC served in %us — replacing the session to re-mount",
            (unsigned int)(IDLE_REMOUNT_MS / 1000U));
        runtime.last_served_ms = now;
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
        /*
         * Remembered here and nowhere else: this is the one moment the server
         * has confirmed the conversation exists. Storing it when the button
         * was pressed would leave the device pointing at a stream that was
         * never set up, across every future boot.
         */
        if (!waveshare_conversation_store(stream_path)) {
          ESP_LOGW(tag, "could not remember %s; it lasts until reboot", stream_path);
        }
        waveshare_display_set_status(stream_path);
        /* Remount: the mount is bound to the path it was made with. */
        runtime.voicelab_generation = 0U;
        waveshare_display_request_call(true);
      }
      if (runtime.voicelab.setup_failed) {
        runtime.voicelab.setup_failed = false;
        ESP_LOGE(tag, "could not prepare %s", pending_stream_path);
        waveshare_display_set_state(WAVESHARE_UI_IDLE);
        waveshare_display_set_status("could not start a new conversation");
      }
      if (iterate_kit_voice_elapsed_ms(now, last_liveness_ms) > NO_LIVENESS_RESTART_MS) {
        ESP_LOGE(
            tag,
            "no round trip in %us despite a ready transport — restarting",
            (unsigned int)(NO_LIVENESS_RESTART_MS / 1000U));
        waveshare_recorder_end_call("no liveness");
        esp_restart();
      }
    }

    if (runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
        runtime.connection.state == ITERATE_KIT_ITX_CONNECTION_READY &&
        runtime.voicelab_generation != runtime.connection.generation) {
      const struct iterate_kit_voicelab_options options = {
        &runtime.connection.session,
        runtime.configuration.project_id,
        runtime.configuration.project_api_key,
        stream_path,
        CALL_ID,
        now_ms,
        NULL,
        on_speaker_pcm,
        on_control,
        on_transcript,
        NULL,
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
        waveshare_display_set_status(stream_path);
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
      static uint64_t next_call_attempt_at;
      static uint64_t next_recorder_attempt_at;
      static uint64_t call_pending_since;
      static bool call_active_shown;

      /*
       * One intent path for both sources: a physical button edge and an RPC
       * call land on the same two flags, so remote and local control cannot
       * disagree about what the device is doing (the M5StickS3 does the same
       * through its device-event queue).
       */
      const bool wants_call = waveshare_display_call_requested();
      const bool wants_talk = wants_call &&
          (waveshare_buttons_upper_held() || waveshare_display_talk_held());

      /*
       * The bridge holds the call in a Durable Object this device cannot
       * see, and it can stop — evicted, redeployed, or simply gone — without
       * appending the call-ended that would say so. Overnight that left the
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
        waveshare_recorder_end_call("bridge silent");
        iterate_kit_voicelab_forget_call(&runtime.voicelab);
        runtime.talking = false;
        runtime.flushing_turn = false;
        waveshare_display_hold_talk(false);
        waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
        waveshare_display_set_status(
            wants_call ? "call dropped — reconnecting" : "call dropped");
        next_call_attempt_at = 0U; /* reconnect now, not on the old backoff */
      }

      /*
       * THE DOWNLINK NEEDS ITS OWN PROOF.
       *
       * Everything above trusts that if the bridge appends something, this
       * device hears it. That is one lane, held by the platform as a
       * callback registration inside the stream's Durable Object, and it can
       * be lost on its own: measured here, a device pinging happily every
       * five seconds (uplink resolving, RTT 130ms) while eight call-accepted
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
       * expire. It is cleared by call-accepted or by the start RPC failing —
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
        next_call_attempt_at = 0U;
      }
      if (!runtime.voicelab.call_pending) call_pending_since = 0U;

      if (wants_call && !runtime.voicelab.call_active &&
          !runtime.voicelab.call_pending && outbox_free >= 3U &&
          now >= next_call_attempt_at) {
        call_pending_since = now;
        next_call_attempt_at = now + 8000U; /* a start takes ~1-3s; don't spam */
        if (iterate_kit_voicelab_start_call(&runtime.voicelab, GREETING) ==
            CAPNWEB_OK) {
          waveshare_display_set_status("starting call");
        }
      }
      if (!wants_call && runtime.voicelab.call_active && outbox_free >= 3U) {
        (void)iterate_kit_voicelab_end_call(&runtime.voicelab, "button");
        waveshare_recorder_end_call("button");
        waveshare_display_set_status("call ended");
        waveshare_display_set_state(WAVESHARE_UI_IDLE);
      }
      /*
       * Recording follows the call's state, not an edge: a call can already
       * be live when this device joins (the bridge outlives us), and that is
       * exactly when a recording is still wanted.
       */
      /*
       * Rate-limited on purpose. This is a 5 ms poll loop reconciling against
       * a filesystem on another task, and every disagreement between them —
       * however it arises — used to become seven card wipes a second. A
       * recording that starts a beat late costs nothing; a card hammered in
       * a loop takes the audio path down with it.
       */
      if (runtime.voicelab.call_active && !waveshare_recorder_recording() &&
          now >= next_recorder_attempt_at) {
        next_recorder_attempt_at = now + 5000U;
        waveshare_recorder_begin_call(CALL_ID);
        runtime.speaker_margin_min_ms = 0U;
        runtime.speaker_writes = 0U;
      } else if (!runtime.voicelab.call_active &&
                 waveshare_recorder_recording()) {
        waveshare_recorder_end_call("call no longer active");
      }
      if (runtime.voicelab.call_active != call_active_shown) {
        call_active_shown = runtime.voicelab.call_active;
        waveshare_display_set_call_active(call_active_shown);
        if (call_active_shown) {
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
        runtime.talking = true;
        runtime.turn_started_ms = now;
        runtime.flushing_turn = false;
        ESP_LOGI(tag, "turn start");
        waveshare_recorder_log("turn start");
        runtime.speaker_discard_bytes =
            (uint32_t)xStreamBufferBytesAvailable(runtime.speaker_buffer);
        /*
         * The discard empties the ring, so the next answer's first frame
         * would otherwise play with zero cushion and starve immediately —
         * putting a hole at the START of every answer after a turn. Ask the
         * playback task to re-buy its cushion.
         */
        runtime.speaker_reprime = true;
        iterate_kit_playout_interrupt(&runtime.playout);
        (void)xQueueReset(runtime.mic_queue); /* drop pre-press room noise */
        runtime.frame_sequence = 0U;
        (void)iterate_kit_voicelab_mark_turn(
            &runtime.voicelab, ITERATE_KIT_VOICELAB_TURN_START);
        waveshare_display_set_state(WAVESHARE_UI_LISTENING);
        waveshare_display_set_status("listening — release to send");
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
        waveshare_recorder_log(
            "turn commit%s", timed_out ? " (uplink behind; tail dropped)" : "");
        (void)iterate_kit_voicelab_mark_turn(
            &runtime.voicelab, ITERATE_KIT_VOICELAB_TURN_COMMIT);
        waveshare_display_set_state(WAVESHARE_UI_SPEAKING);
        waveshare_display_set_status("thinking");
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
          waveshare_recorder_write_mic(
              frame_storage, take * sizeof(frame_storage[0]));
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
        const bool speaker_idle =
            xStreamBufferBytesAvailable(runtime.speaker_buffer) == 0U;
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
              (unsigned int)(xStreamBufferBytesAvailable(runtime.speaker_buffer) /
                             32U));
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
