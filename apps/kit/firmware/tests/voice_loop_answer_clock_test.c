/*
 * WHAT AN ANSWER'S ARRIVAL MEANS, ON A BOARD WHOSE MICROPHONE IS ALWAYS OPEN.
 *
 * `voice_loop_intent_test.c` drives the loop from the CONTROL side — a press
 * arrives as bytes and becomes an intent. Nothing drove it from the AUDIO side,
 * and that is exactly where the bug lived: `on_control` is static and reachable
 * only by delivering a `spk-frame` batch, so the branch that decides what a new
 * answer does to the playout timeline was in no host build at all. Two boards
 * played a fifth of every answer after the first for a week.
 *
 * This file delivers that batch. The board here is `TURNS_SERVER_VAD` — open
 * mic, the case the intent test cannot express — it has no capture op, so its
 * microphone is silent, which is what an ordinary turn looks like by the time
 * the answer's first chunk lands one to two seconds after the person stopped
 * talking. Everything below arrives over the same Cap'n Web session a real
 * stream delivers on, through the callback capability the loop itself exported.
 *
 * The witness is the CODEC: `codec_write` counts what the DAC actually
 * accepted, which is the only thing a listener can hear.
 */

#include "fake_esp_idf.h"
#include "fake_esp_idf_platform.h"

#include "iterate/kit/voice/loop.h"

#include "esp_timer.h"

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voicelab_stream.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(
    bool condition, const char *expression, const char *file, int line) {
  if (condition) return;
  (void)fprintf(
      stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

enum {
  /**
   * Frames per delivered chunk. 5 x 20 ms is the sender's 100 ms maximum.
   *
   * It was 15, at 300 ms, when the wire carried mu-law. PCM16 is twice the
   * bytes per millisecond and the device's chunk and base64 buffers did not
   * grow, so the same buffers now hold a third of the duration. A chunk over
   * that is refused SILENTLY, which is why this constant tracks the sender's.
   */
  CHUNK_FRAMES = 5,
  /** Two chunks an answer: the first carries `drop`, the second `last`. */
  ANSWER_FRAMES = CHUNK_FRAMES * 2,
};

/* --- a board that is an open microphone and a speaker --------------------- */

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  .capture_channels = 1U,
  .playback_channels = 1U,
  .has_reference_channel = false,
  .has_output_gain_control = false,
  .output_gain_ceiling_centi_db = 0,
};

static enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  (void)context;
  (void)capture;
  (void)reference;
  (void)capacity_samples;
  (void)sample_count;
  /*
   * SILENT, AND THAT IS THE SCENARIO. A board that captures nothing has a
   * barge-in gate that has never seen a loud frame, which is the same state an
   * open-mic board is in one second after the person stopped talking — and one
   * second is when the answer's first chunk arrives.
   */
  return ITERATE_KIT_UNAVAILABLE;
}

/** WHAT THE LISTENER HEARD. The only counter in this file that cannot lie. */
static uint32_t frames_written;

static enum iterate_kit_status codec_write(
    void *context, const int16_t *playback, size_t sample_count) {
  (void)context;
  (void)playback;
  assert(sample_count == (size_t)ITERATE_KIT_VOICE_FRAME_SAMPLES);
  ++frames_written;
  return ITERATE_KIT_OK;
}

static const struct iterate_kit_audio_codec_ops codec_ops = {
  .read = codec_read,
  .write = codec_write,
};

struct board {
  struct iterate_kit_voice_view last_view;
  bool started;
  /** Frames the loop admitted to the speaker queue, and which answer they were. */
  uint32_t admitted;
  uint32_t last_admitted_answer;
  /** Times the loop threw queued audio away. */
  uint32_t abandoned;
};

static struct board board;

static bool board_start(void *context, struct iterate_kit_board_audio *out) {
  struct board *self = context;
  self->started = true;
  out->codec.ops = &codec_ops;
  out->codec.properties = &codec_properties;
  out->codec.context = NULL;
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void board_present(
    void *context, const struct iterate_kit_voice_view *view) {
  struct board *self = context;
  self->last_view = *view;
}

/*
 * THE ANSWER'S OWN NUMBER, WHICH IS THE THING THE BUG DESTROYED.
 *
 * `note->answer` is the loop's `answers_started`, and every admitted frame
 * carries the answer it belongs to. When a new answer fails to start, its audio
 * is admitted under the PREVIOUS answer's number — so this is the timeline
 * asserted directly, one layer below "did the listener hear it".
 */
static void board_answer(
    void *context, const struct iterate_kit_voice_answer_note *note) {
  struct board *self = context;
  if (note->kind == ITERATE_KIT_VOICE_ANSWER_ADMITTED) {
    ++self->admitted;
    self->last_admitted_answer = note->answer;
  } else if (note->kind == ITERATE_KIT_VOICE_ANSWER_ABANDONED) {
    ++self->abandoned;
  }
}

static const struct iterate_kit_board_ops board_ops = {
  .start = board_start,
  .present = board_present,
  .observe_answer = board_answer,
};

/*
 * OPEN MIC. `turns` is the only field that decides whether the loop believes
 * the sender about a new answer, and it is the whole difference between the two
 * boards that work and the two that do not.
 */
static const struct iterate_kit_board_facts open_mic_facts = {
  .stream_path = "/agents/voice/host-test-open-mic",
  .client_path = "/clients/host-test-open-mic",
  .conversation_id = "hostmic",
  .greeting = "hello",
  .instructions = "an open-mic board that exists only in a test",
  .peer_description = "{\"instructions\":\"host test\",\"children\":{}}",
  .talk_hint = "speak whenever you like",
  .call_hint = "press to call",
  .speaker = {0},
  .speaker_dry_wait_ms = 40U,
  .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_stack_bytes = 4096U,
  .turns = ITERATE_KIT_VOICE_TURNS_SERVER_VAD,
  .radio_before_codec = false,
};

/* --- driving the loop ----------------------------------------------------- */

static void step(void) {
  iterate_kit_voice_loop_step((uint64_t)(esp_timer_get_time() / 1000));
}

/** One pass of the speaker task, which on a board is a thread of its own. */
static void playback(void) { iterate_kit_voice_loop_playback_step(); }

/**
 * Run the speaker task long enough that anything playable has played.
 *
 * A fixed number of passes rather than "until the queue is empty": the failure
 * this file is about is a device that stops playing, and a drain loop keyed on
 * the queue would hang on it instead of failing. Every caller then asserts what
 * the converter actually took.
 */
static void play_out(void) {
  int pass;
  for (pass = 0; pass < 400; ++pass) playback();
}

static size_t answered;

/*
 * ANSWER WHATEVER THE DEVICE ASKED, THE WAY A LIVE /api WOULD — the same pump
 * `voice_loop_intent_test.c` uses, for the same reason: the mount chain's
 * length is the device's business, not this test's.
 */
static void pump(void) {
  int round;
  for (round = 0; round < 40; ++round) {
    struct iterate_kit_itx_connection *connection =
        iterate_kit_fake_platform_connection();
    bool answered_any = false;
    while (answered < iterate_kit_fake_platform_sent_count()) {
      const char *message = iterate_kit_fake_platform_sent(answered);
      const char *pull = strstr(message, "[\"pull\",");
      ++answered;
      if (pull == NULL) continue;
      {
        char reply[128];
        const long id = strtol(pull + strlen("[\"pull\","), NULL, 10);
        (void)snprintf(
            reply, sizeof(reply), "[\"resolve\",%ld,[\"export\",%ld]]", id,
            -(id + 10));
        assert(
            iterate_kit_itx_connection_receive_text(
                connection, reply, strlen(reply)) == CAPNWEB_OK);
        answered_any = true;
      }
    }
    iterate_kit_fake_esp_idf_advance_ms(50U);
    step();
    if (!answered_any && round > 3) break;
  }
}

/*
 * THE CAPABILITY THE DEVICE ITSELF EXPORTED, FOUND THE WAY THE SERVER FINDS IT.
 *
 * `openConnection` hands the stream a `processEventBatch` capability, and its
 * id is the device's to choose — so it is read out of the message the device
 * SENT rather than assumed. A hard-coded id would be a test that passes because
 * the export table happened to be in a particular order.
 */
static long callback_export_id(void) {
  const char *message =
      iterate_kit_fake_platform_find_sent("processEventBatch");
  const char *field;
  const char *marker;
  assert(message != NULL);
  field = strstr(message, "\"processEventBatch\":");
  assert(field != NULL);
  marker = strstr(field, "[\"export\",");
  assert(marker != NULL);
  return strtol(marker + strlen("[\"export\","), NULL, 10);
}

/* --- the audio itself ----------------------------------------------------- */

/**
 * `frames` whole wire frames of mu-law, base64, all one sample value.
 *
 * Content is irrelevant here — nothing in this file listens — but LENGTH is
 * not: the speaker path refuses any PCM length but 640, so a chunk that is not
 * a whole number of frames would be counted as bad rather than played.
 */
static const char *frames_b64(size_t frames) {
  static char encoded[8192];
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const size_t byte_count = frames * (size_t)ITERATE_KIT_VOICELAB_FRAME_BYTES;
  const uint8_t fill = 0x00U; /* PCM16 silence */
  size_t at = 0U;
  size_t out = 0U;
  assert((byte_count + 2U) / 3U * 4U < sizeof(encoded));
  for (; at + 3U <= byte_count; at += 3U) {
    const uint32_t triple = ((uint32_t)fill << 16) | ((uint32_t)fill << 8) |
        (uint32_t)fill;
    encoded[out++] = alphabet[(triple >> 18) & 0x3FU];
    encoded[out++] = alphabet[(triple >> 12) & 0x3FU];
    encoded[out++] = alphabet[(triple >> 6) & 0x3FU];
    encoded[out++] = alphabet[triple & 0x3FU];
  }
  /* The tail, because 640 is not a multiple of three and a chunk of whole
   * frames therefore usually is not either. Asserting divisibility instead was
   * fine while a frame was 320 mu-law bytes and is not now. */
  if (at < byte_count) {
    const size_t left = byte_count - at;
    const uint32_t triple = ((uint32_t)fill << 16) |
        (left == 2U ? ((uint32_t)fill << 8) : 0U);
    encoded[out++] = alphabet[(triple >> 18) & 0x3FU];
    encoded[out++] = alphabet[(triple >> 12) & 0x3FU];
    if (left == 2U) encoded[out++] = alphabet[(triple >> 6) & 0x3FU];
  }
  encoded[out] = '\0';
  return encoded;
}

/** Offsets must climb: the delivery lane dedupes on them. */
static long long next_offset = 100;
static long long next_release_id = 1;

/** Deliver one `spk-frame` chunk, exactly as the stream delivers one. */
static void deliver_chunk(bool drop, bool last, size_t frames) {
  static char message[16384];
  char release[64];
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  const long long offset = next_offset++;
  assert(connection != NULL);
  (void)snprintf(
      message,
      sizeof(message),
      "[\"push\",[\"pipeline\",%ld,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":%lld,"
      "\"payload\":{%s%s\"pcm\":\"%s\"}}"
      "]],\"scannedThroughOffset\":%lld,\"state\":null}]]]",
      callback_export_id(),
      offset,
      drop ? "\"drop\":true," : "",
      last ? "\"last\":true," : "",
      frames_b64(frames),
      offset);
  assert(
      iterate_kit_itx_connection_receive_text(
          connection, message, strlen(message)) == CAPNWEB_OK);
  (void)snprintf(
      release, sizeof(release), "[\"release\",%lld,1]", next_release_id++);
  assert(
      iterate_kit_itx_connection_receive_text(
          connection, release, strlen(release)) == CAPNWEB_OK);
}

/**
 * Deliver the call's acceptance, exactly as the stream delivers it.
 *
 * The delivery lane refuses `spk-frame`s for a call the device is not on —
 * that refusal is what stops an ended call's in-flight tail from playing
 * after the end chime — so an answer with no accepted call in front of it
 * is now silence by design, in this harness as on the desk.
 */
static void deliver_accepted(void) {
  static char message[512];
  char release[64];
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  const long long offset = next_offset++;
  assert(connection != NULL);
  (void)snprintf(
      message,
      sizeof(message),
      "[\"push\",[\"pipeline\",%ld,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
      "\"offset\":%lld,"
      "\"payload\":{\"conversationId\":\"convtest\",\"handshakeTookMs\":1}}"
      "]],\"scannedThroughOffset\":%lld,\"state\":null}]]]",
      callback_export_id(),
      offset,
      offset);
  assert(
      iterate_kit_itx_connection_receive_text(
          connection, message, strlen(message)) == CAPNWEB_OK);
  (void)snprintf(
      release, sizeof(release), "[\"release\",%lld,1]", next_release_id++);
  assert(
      iterate_kit_itx_connection_receive_text(
          connection, release, strlen(release)) == CAPNWEB_OK);
}

/** A whole answer: a chunk that clears, then a chunk that closes. */
static void deliver_answer(void) {
  deliver_chunk(true, false, CHUNK_FRAMES);
  deliver_chunk(false, true, CHUNK_FRAMES);
}

/* --- the tests ------------------------------------------------------------ */

/*
 * THE FIRST ANSWER OF A SESSION HAS ALWAYS WORKED, WHICH IS WHY THIS BUG TOOK A
 * WEEK. `answer_started_ms` is zero at boot, so the lag it is measured against
 * is zero, so nothing is skipped. Asserted so the scenario below is a
 * comparison rather than an isolated number.
 */
static void the_first_answer_plays_whole(void) {
  deliver_answer();
  play_out();

  assert(board.admitted == (uint32_t)ANSWER_FRAMES);
  assert(frames_written == (uint32_t)ANSWER_FRAMES);
}

/*
 * AND SO DOES THE SECOND, WITH A SILENT MICROPHONE AND SECONDS BETWEEN THEM.
 *
 * THIS IS THE BUG. `drop` reaches the device as SPEECH_STARTED and its branch
 * did two unrelated things behind one gate: it threw the queue away, and it
 * restarted the answer's playout timeline. The gate — the deleted barge-in module's `iterate_kit_barge_in_
 * admit`, a 600 ms window on the local microphone — refused the whole branch on
 * every ordinary turn, because an answer's first chunk arrives one to two
 * seconds after anybody spoke. The next answer was then measured against the
 * PREVIOUS answer's clock, the lag catch-up rule found itself seconds behind,
 * and it "recovered" by deleting the answer: measured on the StackChan at 2590
 * frames skipped with `spkLagMaxMs` of 643,208.
 *
 * The gap here is deliberately longer than both the barge-in window and
 * ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS, because those two numbers are what
 * the failure is made of.
 */
static void a_later_answer_plays_whole_too(void) {
  const uint32_t answer_one_number = board.last_admitted_answer;
  const uint32_t written_before = frames_written;

  /* 5000 ms clears the deleted barge-in module's 600 ms evidence window
   * with room; the surviving bound below is the one that still moves. */
  assert(ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS < 5000);
  iterate_kit_fake_esp_idf_advance_ms(5000U);
  playback(); /* the device notices it is dry and settles back to priming */

  deliver_answer();
  play_out();

  /* The answer began: its frames are its own, not the last answer's. */
  assert(board.last_admitted_answer > answer_one_number);
  /* And every one of them reached the converter. */
  assert(frames_written == written_before + (uint32_t)ANSWER_FRAMES);
}

/*
 * AND A LIVE ANSWER SUPERSEDED AFTER A STALL, WHICH IS BOTH HALVES AT ONCE.
 *
 * The ring never goes dry here — the previous answer is still queued when the
 * next one's `drop` lands — so the idle reset above cannot help, and the flush
 * itself is the only place the clock can restart. That makes this the case that
 * pins the reset to the abandon FUNNEL rather than to any one of its four
 * callers.
 *
 * It is also the case that proves ungating did not become "stop clearing the
 * ring". A `drop` that lands on queued audio has to throw it away: the sender
 * has ALREADY discarded it (`speakerReplace` empties the server's pending bytes
 * before it arms `drop`), so anything still held here is audio nobody will hear
 * sitting in front of the answer they are waiting for.
 */
static void a_live_answer_superseded_after_a_stall(void) {
  const uint32_t abandoned_before = board.abandoned;
  const uint32_t written_before = frames_written;
  int pass;

  iterate_kit_fake_esp_idf_advance_ms(5000U);
  playback();

  /* An answer arrives and only part of it is played. */
  deliver_answer();
  for (pass = 0; pass < 5; ++pass) playback();
  assert(frames_written > written_before);
  assert(frames_written < written_before + (uint32_t)ANSWER_FRAMES);

  {
    const uint32_t written_at_interruption = frames_written;
    const uint32_t unplayed =
        (uint32_t)ANSWER_FRAMES - (written_at_interruption - written_before);
    /*
     * FIVE SECONDS OF STALL, WITH THE RING STILL FULL. This is what makes the
     * assertion below about the CLOCK and not merely about the queue: the
     * interrupted answer is now seconds behind its own timeline, and unless the
     * flush restarts that timeline the replacement inherits the debt and the
     * catch-up rule spends the new answer paying it.
     */
    iterate_kit_fake_esp_idf_advance_ms(5000U);

    deliver_answer();
    play_out();

    assert(board.abandoned > abandoned_before);
    /*
     * The interrupted answer's tail never played: what the converter took is
     * what it had already taken, plus the whole of the new answer.
     */
    assert(unplayed > 0U);
    assert(
        frames_written == written_at_interruption + (uint32_t)ANSWER_FRAMES);
  }
}

/*
 * AND AN ANSWER WHOSE `drop` IS LATE — OR NEVER COMES — IS STILL AN ANSWER.
 *
 * MEASURED, not hypothetical. With the gate ungated, the StackChan still lost
 * 680 ms of its first turn: the sender had delivered four chunks of the new
 * answer BEFORE the `drop` that was supposed to precede them, and a brand new
 * CALL emptied the ring without touching the clock, so those chunks were
 * measured against an answer minutes old (`spkLagMaxMs` 117,083) and skipped.
 *
 * The device does not need to be told. A ring that has gone dry and settled
 * back to priming is playback standing AT THE LIVE EDGE — there is nothing
 * queued to skip into, which is why the catch-up rule already refuses to fire
 * there — so nothing can be late, and the next frame to arrive is the origin of
 * whatever answer it belongs to. This delivers audio with no `drop` at all,
 * which is the strongest form of the case.
 */
static void audio_with_no_clear_at_all_still_plays(void) {
  const uint32_t written_before = frames_written;

  iterate_kit_fake_esp_idf_advance_ms(5000U);
  playback(); /* dry, past the conceal limit: back to priming */

  deliver_chunk(false, false, CHUNK_FRAMES);
  deliver_chunk(false, true, CHUNK_FRAMES);
  play_out();

  assert(frames_written == written_before + (uint32_t)ANSWER_FRAMES);
}

int main(void) {
  iterate_kit_fake_esp_idf_reset();
  iterate_kit_fake_platform_reset();
  memset(&board, 0, sizeof(board));
  iterate_kit_fake_esp_idf_set_now_us(1000000);
  assert(iterate_kit_voice_loop_init(&board_ops, &open_mic_facts, &board));
  assert(!iterate_kit_fake_esp_idf_restart_requested());
  assert(board.started);
  iterate_kit_fake_platform_connect();
  pump();
  /* The call this whole file's audio belongs to; see deliver_accepted. */
  deliver_accepted();

  the_first_answer_plays_whole();
  a_later_answer_plays_whole_too();
  a_live_answer_superseded_after_a_stall();
  audio_with_no_clear_at_all_still_plays();

  assert(!iterate_kit_fake_esp_idf_restart_requested());
  return 0;
}
