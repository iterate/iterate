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
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

#include "capnweb/capnweb.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voicelab_stream.h"
#include "waveshare_audio.h"
#include "waveshare_buttons.h"
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
  PENDING_CALL_CAPACITY = 16,
  EXPORT_CAPACITY = 4,
  IMPORT_CAPACITY = 16,
  /*
   * Replies to pulled calls and inbound delivery batches both parse inside
   * this budget, one token per JSON key, value, object and array —
   * exhaustion ABORTS THE SESSION. A capped batch of 4 speaker frames is
   * ~72, but a single Grok response.done carries a nested event object that
   * alone runs to several hundred. 256 was sized for a 2-event batch and was
   * never re-checked when the cap doubled; 1024 costs 12 KiB of otherwise
   * idle PSRAM-eligible RAM and takes this off the table.
   */
  TOKEN_CAPACITY = 1024,
  OUTPUT_CAPACITY = 128,
  /*
   * Inbox slots take one whole delivery batch each (the connection is opened
   * with maxDeliveryBytes 5200 + envelope) and outbox slots an eight-frame
   * mic append, about 7 KiB. 8 KiB serves both.
   */
  CONTROL_INBOX_SLOT_CAPACITY = 8192,
  CONTROL_OUTBOX_SLOT_CAPACITY = 8192,
  /*
   * The inbox rides PSRAM (512 KiB), and overflowing it is SESSION-FATAL, so
   * it is sized for the worst legitimate burst rather than the average: a
   * paced answer clumps at TCP granularity, and pulling a recording off the
   * card adds a call per chunk on top. Measured high-water was 46 of 64
   * during ordinary use — close enough to the edge that the session died
   * under a recording pull concurrent with a call. 128 leaves real headroom.
   */
  CONTROL_INBOX_SLOTS = 128,
  /*
   * The uplink sends 6 frames per 120 ms, which is exactly the capture rate —
   * so it has no margin, and any iteration blocked on outbox headroom puts
   * it permanently behind (measured: holds over 2 s ended with the queue
   * still full at the flush deadline). The outbox lives in PSRAM now, so
   * depth is cheap; 16 slots lets the sender catch up instead of losing the
   * tail of long utterances.
   */
  CONTROL_OUTBOX_SLOTS = 16,
  FRAME_MS = 20,
  FRAME_SAMPLES = WAVESHARE_AUDIO_FRAME_SAMPLES,
  FRAME_BYTES = FRAME_SAMPLES * 2,
  MIC_QUEUE_DEPTH = 32,
  MIC_FRAMES_PER_APPEND = ITERATE_KIT_VOICELAB_MAX_FRAMES_PER_APPEND,
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
  SPEAKER_BUFFER_BYTES = 32000,
  /*
   * Playback will not start, or resume after starving, until this much audio
   * is queued. Without it the first frame starts the speaker with zero margin
   * and the DMA's 90 ms is the only tolerance the whole path has.
   */
  SPEAKER_PREFILL_BYTES = 160 * 32,
  /*
   * Recovering from a starve does NOT re-buy the full opening prefill. It
   * used to, so a single late frame cost 160 ms of inserted silence —
   * measured at 45 starves per 3099 frames, roughly 7 s of stutter per
   * minute of speech. Mid-answer the bridge is already streaming, so a much
   * smaller cushion is enough to carry on.
   */
  SPEAKER_REPRIME_BYTES = 40 * 32,
  /*
   * And a starve is only real if the buffer stays empty. One empty read is
   * ordinary jitter between a 20 ms write and a ~20 ms arrival cadence.
   */
  SPEAKER_STARVE_READS = 3,
  /*
   * How long the speaker must stay dry before the amplifier is powered down.
   * Long enough that a network hiccup mid-answer never power-cycles it.
   */
  SPEAKER_IDLE_POWERDOWN_MS = 1500,
  /* Longest a released turn waits for the uplink before committing anyway. */
  TURN_FLUSH_TIMEOUT_MS = 1500,
  /* Button scan cadence; each scan costs an I2C transaction. */
  BUTTON_POLL_MS = 25,
  STATS_INTERVAL_MS = 5000,
  /* How long the transport may stay FAILED before the device reboots itself. */
  UNHEALTHY_RESTART_MS = 120000,
  PING_INTERVAL_MS = 5000,
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

#define STREAM_PATH "/voicelab/dev-waveshare"
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
  uint32_t voicelab_generation;
  uint32_t frame_sequence;
  char stats_buffer[896];
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
  uint32_t mic_frames_gated;
  uint32_t speaker_frames_played;
  uint32_t speaker_overflow_drops;
  uint32_t speaker_underruns;
  uint32_t speaker_bad_frames;
  uint32_t barge_in_flushes;
  bool talking;
  /* Release pressed, but the capture queue is not yet on the wire. */
  bool flushing_turn;
  volatile bool speaker_reprime;
  uint32_t flush_frames_left;
  uint64_t flush_deadline_ms;
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
    void *context, const uint8_t *pcm, size_t pcm_length, int64_t sequence) {
  (void)context;
  (void)sequence;
  /*
   * A frame goes in whole or not at all. A partial write splices the head of
   * one frame onto the next at an arbitrary phase, which is a click — and at
   * a full buffer that happens to EVERY frame. An odd length would shift the
   * 16-bit sample grid permanently, so it is refused outright.
   */
  if ((pcm_length & 1U) != 0U) {
    ++runtime.speaker_bad_frames;
    return;
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
    ++runtime.barge_in_flushes;
    waveshare_display_set_state(WAVESHARE_UI_LISTENING);
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    waveshare_recorder_log("answer complete");
    /* The answer is complete: back to waiting for the next turn. */
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("hold the lower button to talk");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    waveshare_display_set_call_active(true);
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("hold the lower button to talk");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    waveshare_recorder_end_call("bridge hung up");
    /* The bridge hung up (its idle timeout, Grok closing, or our own
     * hangup echoing back) — the button must agree with reality. */
    waveshare_display_request_call(false);
    waveshare_display_set_call_active(false);
    waveshare_display_set_state(WAVESHARE_UI_IDLE);
    waveshare_display_set_status("call ended");
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
   * Starts buffering, and returns to buffering whenever the queue runs dry.
   * Resuming at zero margin is why a single network excursion used to turn
   * into continuous stutter: the deficit was never recovered.
   */
  bool priming = true;
  bool started_once = false;
  uint32_t empty_reads = 0U;
  uint64_t last_write_ms = 0U;
  (void)argument;
  for (;;) {
    size_t received;
    if (runtime.speaker_reprime) {
      runtime.speaker_reprime = false;
      priming = true;
      started_once = false; /* a real boundary: buy the full cushion */
    }
    if (priming) {
      const size_t target = started_once ? (size_t)SPEAKER_REPRIME_BYTES
                                         : (size_t)SPEAKER_PREFILL_BYTES;
      if (xStreamBufferBytesAvailable(runtime.speaker_buffer) < target) {
        DELAY_MS(5);
        continue;
      }
      priming = false;
      started_once = true;
      empty_reads = 0U;
    }
    received = xStreamBufferReceive(
        runtime.speaker_buffer, chunk, sizeof(chunk), pdMS_TO_TICKS(20));
    if (received == 0U) {
      /*
       * One empty read is ordinary jitter, not a starve: the DMA still holds
       * ~90 ms and the next frame is usually already in flight. Only a run of
       * them means the pipe is genuinely dry, and only then is it worth
       * re-buying a cushion — treating every hiccup as a starve is what
       * turned jitter into audible stutter.
       *
       * The amplifier is NOT dropped here either; a momentary gap would
       * power-cycle it and clip the audio on both sides. It goes down only
       * after sustained silence, below.
       */
      if (++empty_reads < (uint32_t)SPEAKER_STARVE_READS) {
        continue;
      }
      empty_reads = 0U;
      priming = true;
      ++runtime.speaker_underruns;
      if (last_write_ms != 0U &&
          now_ms(NULL) - last_write_ms > SPEAKER_IDLE_POWERDOWN_MS) {
        waveshare_audio_amplifier(false);
      }
      continue;
    }
    if (runtime.speaker_discard_bytes > 0U) {
      /*
       * Discard only what was asked for. Dropping the whole chunk threw away
       * up to 20 ms of the NEXT answer on the last chunk of a flush — the
       * first syllable after a barge-in.
       */
      const uint32_t discard = runtime.speaker_discard_bytes;
      const size_t skipped = discard < received ? (size_t)discard : received;
      runtime.speaker_discard_bytes = (uint32_t)(discard - skipped);
      if (skipped == received) continue;
      memmove(chunk, (const uint8_t *)chunk + skipped, received - skipped);
      received -= skipped;
    }
    if (waveshare_audio_write(chunk, received / 2U)) {
      ++runtime.speaker_frames_played;
      waveshare_recorder_write_speaker(chunk, received);
    }
    /*
     * Stamp the echo gate from PLAYBACK, not arrival: paced delivery can
     * finish arriving seconds before the speaker finishes, and a gate timed
     * from arrival reopens the microphone while the board is still talking.
     */
    empty_reads = 0U;
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
    if (xQueueSend(runtime.mic_queue, &frame, 0) != pdTRUE) {
      /* Freshest wins: discard the OLDEST frame, keep this one. Stale
       * speech after a network hiccup is worse than a gap. */
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

static void append_stats(uint64_t now) {
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  int length;
  iterate_kit_esp_idf_itx_transport_metrics(&runtime.transport, &metrics);
  length = snprintf(
      runtime.stats_buffer,
      sizeof(runtime.stats_buffer),
      "[{\"type\":\"voicelab/dev-stats\",\"payload\":{"
      "\"seq\":%" PRIu32 ",\"t\":%" PRIu64
      ",\"framesSent\":%" PRIu32 ",\"frameFailures\":%" PRIu32
      ",\"micCaptured\":%" PRIu32 ",\"micDropped\":%" PRIu32
      ",\"micGated\":%" PRIu32
      ",\"spkFrames\":%" PRIu32 ",\"spkPlayed\":%" PRIu32
      ",\"spkOverflow\":%" PRIu32 ",\"spkUnderruns\":%" PRIu32
      ",\"spkBadFrames\":%" PRIu32 ",\"spkSeqGaps\":%" PRIu32
      ",\"spkDecodeFailures\":%" PRIu32 ",\"bargeIns\":%" PRIu32
      ",\"batches\":%" PRIu32 ",\"connGeneration\":%" PRIu32
      ",\"rttMs\":%" PRIu32 ",\"pings\":%" PRIu32
      ",\"heapFree\":%" PRIu32 ",\"heapMin\":%" PRIu32
      ",\"wsSent\":%" PRIu32 ",\"outboxDiscarded\":%" PRIu32
      ",\"inboxPublished\":%" PRIu32 ",\"inboxConsumed\":%" PRIu32
      ",\"inboxDiscarded\":%" PRIu32 ",\"inboxHighWater\":%" PRIu32
      ",\"sessionGeneration\":%" PRIu32
      ",\"protoFailures\":%" PRIu32 ",\"recvFailures\":%" PRIu32
      ",\"sendFailures\":%" PRIu32 ",\"inboxDeferrals\":%" PRIu32
      ",\"lastAppStatus\":%" PRId32
      ",\"dmaLargest\":%" PRIu32 "}}]",
      runtime.stats_sequence++,
      now,
      runtime.voicelab.frames_sent,
      runtime.voicelab.frame_send_failures,
      runtime.mic_frames_captured,
      runtime.mic_frames_dropped,
      runtime.mic_frames_gated,
      runtime.voicelab.spk_frames_received,
      runtime.speaker_frames_played,
      runtime.speaker_overflow_drops,
      runtime.speaker_underruns,
      runtime.speaker_bad_frames,
      runtime.voicelab.spk_seq_gaps,
      runtime.voicelab.spk_decode_failures,
      runtime.barge_in_flushes,
      runtime.voicelab.batches_on_connection,
      runtime.voicelab.connection_generation,
      runtime.voicelab.last_rtt_ms,
      runtime.voicelab.ping_count,
      (uint32_t)esp_get_free_heap_size(),
      (uint32_t)esp_get_minimum_free_heap_size(),
      metrics.control_messages_sent,
      metrics.control_outbox_discarded,
      metrics.control_inbox.messages_published,
      metrics.control_inbox.messages_consumed,
      metrics.control_inbox_discarded,
      metrics.control_inbox.high_water_slots,
      runtime.connection.generation,
      metrics.protocol_failures,
      metrics.control_receive_failures,
      metrics.control_send_failures,
      metrics.control_inbox_deferrals,
      metrics.last_application_capnweb_status,
      (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_DMA));
  if (length > 0 && (size_t)length < sizeof(runtime.stats_buffer)) {
    (void)iterate_kit_voicelab_append_raw(
        &runtime.voicelab, runtime.stats_buffer, (size_t)length);
  }
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
  vTaskPrioritySet(NULL, 4);
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
  runtime.speaker_buffer = xStreamBufferCreateWithCaps(
      SPEAKER_BUFFER_BYTES, FRAME_BYTES, MALLOC_CAP_SPIRAM);
  if (runtime.mic_queue == NULL || runtime.speaker_buffer == NULL) {
    ESP_LOGE(tag, "audio buffer allocation failed");
    return;
  }
  if (!initialise_rings() || !initialise_connection()) {
    ESP_LOGE(tag, "bounded runtime initialization failed");
    return;
  }
  if (iterate_kit_esp_idf_itx_transport_start(&runtime.transport) !=
      ITERATE_KIT_OK) {
    ESP_LOGE(
        tag,
        "transport start failed: platform=%ld",
        (long)runtime.transport.last_platform_error);
    return;
  }
  (void)xTaskCreatePinnedToCore(
      capture_task, "vl-capture", 4096, NULL, 8, NULL, 1);
  (void)xTaskCreatePinnedToCore(
      playback_task, "vl-playback", 4096, NULL, 9, NULL, 1);
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
    (void)iterate_kit_esp_idf_itx_transport_poll(&runtime.transport, 4U);
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
    if (waveshare_buttons_take_call_long_press()) {
      ESP_LOGW(tag, "call button held — restarting");
      waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
      waveshare_display_set_status("restarting…");
      waveshare_recorder_end_call("user restart");
      DELAY_MS(400); /* let the screen show it */
      esp_restart();
    }
    {
      /* Show the hold progressing, so it is discoverable rather than folklore. */
      static bool showing_hold;
      const uint32_t held = waveshare_buttons_call_held_ms();
      if (held > 600U) {
        showing_hold = true;
        waveshare_display_set_status("keep holding to restart…");
      } else if (showing_hold) {
        showing_hold = false;
        waveshare_display_set_status(
            runtime.voicelab.call_active ? "hold the lower button to talk"
                                         : "press the upper button to call");
      }
    }
    if (waveshare_buttons_take_call_press()) {
      const bool wanted = !waveshare_display_call_requested();
      ESP_LOGI(tag, "BOOT pressed: call %s", wanted ? "requested" : "ended");
      waveshare_display_request_call(wanted);
    }
    {
      static bool talk_logged;
      const bool talk = waveshare_buttons_talk_held();
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
      } else if (now - unhealthy_since > UNHEALTHY_RESTART_MS) {
        ESP_LOGE(
            tag,
            "transport unrecoverable for %us — restarting",
            (unsigned int)(UNHEALTHY_RESTART_MS / 1000U));
        waveshare_recorder_end_call("device restart");
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
        STREAM_PATH,
        CALL_ID,
        now_ms,
        NULL,
        on_speaker_pcm,
        on_control,
        on_transcript,
        NULL,
      };
      if (iterate_kit_voicelab_start(&runtime.voicelab, &options) ==
          CAPNWEB_OK) {
        runtime.voicelab_generation = runtime.connection.generation;
        runtime.frame_sequence = 0U;
        (void)xQueueReset(runtime.mic_queue); /* drop pre-session stale audio */
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
        waveshare_display_set_status(STREAM_PATH);
      } else if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_FAILED) {
        /* A dead session takes the call with it; the button starts over. */
        waveshare_display_request_call(false);
        waveshare_display_set_call_active(false);
        waveshare_display_set_state(WAVESHARE_UI_CONNECTING);
        waveshare_display_set_status(
            iterate_kit_voicelab_failure_name(runtime.voicelab.failure));
      }
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
      static bool call_active_shown;

      /*
       * One intent path for both sources: a physical button edge and an RPC
       * call land on the same two flags, so remote and local control cannot
       * disagree about what the device is doing (the M5StickS3 does the same
       * through its device-event queue).
       */
      const bool wants_call = waveshare_display_call_requested();
      const bool wants_talk = wants_call &&
          (waveshare_buttons_talk_held() || waveshare_display_talk_held());

      if (wants_call && !runtime.voicelab.call_active &&
          !runtime.voicelab.call_pending && outbox_free >= 3U &&
          now >= next_call_attempt_at) {
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
      if (runtime.voicelab.call_active && !waveshare_recorder_recording()) {
        waveshare_recorder_begin_call(CALL_ID);
      } else if (!runtime.voicelab.call_active &&
                 waveshare_recorder_recording()) {
        waveshare_recorder_end_call("call no longer active");
      }
      if (runtime.voicelab.call_active != call_active_shown) {
        call_active_shown = runtime.voicelab.call_active;
        waveshare_display_set_call_active(call_active_shown);
        if (call_active_shown) {
          waveshare_display_set_state(WAVESHARE_UI_IDLE);
          waveshare_display_set_status("hold the lower button to talk");
        }
      }

      /*
       * Turn edges. Pressing talk cancels whatever is playing — locally by
       * dropping the queued speaker audio, and at the bridge by asking it to
       * cancel the response — so the microphone never opens into a live
       * speaker. Releasing commits the turn and asks for the answer.
       */
      if (wants_talk && !runtime.talking && runtime.voicelab.call_active &&
          outbox_free >= 3U) {
        runtime.talking = true;
        runtime.flushing_turn = false;
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
      if (runtime.flushing_turn && outbox_free >= 3U &&
          (runtime.flush_frames_left == 0U ||
           now >= runtime.flush_deadline_ms)) {
        const bool timed_out = runtime.flush_frames_left > 0U;
        runtime.talking = false;
        runtime.flushing_turn = false;
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
            queued >= needed && outbox_free >= 3U) {
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
               now - drain_window_at > MIC_FRAMES_PER_APPEND * FRAME_MS * 4U)
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
      if (now >= next_stats_at && outbox_free >= 3U) {
        append_stats(now);
        next_stats_at = now + STATS_INTERVAL_MS;
      }
    }

    DELAY_MS(5);
  }
}
