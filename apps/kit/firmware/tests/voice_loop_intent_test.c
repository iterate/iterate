/*
 * WHAT A PRESS MEANS, TESTED ON A BOARD THAT HAS NO BUTTONS.
 *
 * `components/voice/src/voice_loop.c` is the one program all four boards run,
 * and until this file it was in no host build: its intent mapping was verified
 * by diffing it against the four device files it replaced, and that is exactly
 * where the bug lived. This fixture drives conversation control through the
 * mounted capability, exercising the same route a real caller uses.
 *
 * This is that test. The board here has no `poll` op at all, so there is no
 * physical button in the program: every intent has to come from the capability
 * the loop mounts, over the same Cap'n Web session a real caller uses, through
 * the same transport seam a real socket delivers on.
 */

#include "fake_esp_idf.h"
#include "fake_esp_idf_platform.h"

#include "iterate/kit/voice/loop.h"

#include "esp_timer.h"

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/voice_device_profile.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

static void test_assert(
    bool condition, const char *expression, const char *file, int line) {
  if (condition) return;
  (void)fprintf(
      stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

/* --- a board that is nothing but a screen --------------------------------- */

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  .capture_channels = 1U,
  .playback_channels = 1U,
  .has_reference_channel = false,
  .has_output_gain_control = false,
  .output_gain_ceiling_centi_db = 0,
};

/*
 * How many 20 ms frames the "microphone" still owes. Zero — the default —
 * is a silent board, which is what every scenario but the speech ones
 * wants; see speak_frames.
 */
static size_t capture_frames_pending;
static int16_t capture_frame_value = 1000;
static void (*capture_read_hook)(void);

static enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  size_t index;
  (void)context;
  (void)reference;
  if (capture_frames_pending == 0U) {
    /* Silent by default; speech tests arm frames explicitly. */
    return ITERATE_KIT_UNAVAILABLE;
  }
  --capture_frames_pending;
  for (index = 0U; index < capacity_samples; ++index) {
    capture[index] = capture_frame_value;
  }
  ++capture_frame_value;
  if (capture_read_hook != NULL) {
    void (*hook)(void) = capture_read_hook;
    capture_read_hook = NULL;
    hook();
  }
  *sample_count = capacity_samples;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status codec_write(
    void *context, const int16_t *playback, size_t sample_count) {
  (void)context;
  (void)playback;
  (void)sample_count;
  return ITERATE_KIT_OK;
}

static const struct iterate_kit_audio_codec_ops codec_ops = {
  .read = codec_read,
  .write = codec_write,
};

struct board {
  struct iterate_kit_voice_view last_view;
  size_t presented;
  bool started;
  bool microphone_muted;
};

static bool board_start(void *context, struct iterate_kit_board_audio *out) {
  struct board *board = context;
  board->started = true;
  out->codec.ops = &codec_ops;
  out->codec.properties = &codec_properties;
  out->codec.context = NULL;
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void board_present(
    void *context, const struct iterate_kit_voice_view *view) {
  struct board *board = context;
  board->last_view = *view;
  ++board->presented;
}

static void board_poll(void *context, struct iterate_kit_voice_intent *out) {
  const struct board *board = context;
  out->microphone_muted = board->microphone_muted;
}

/*
 * The fixture reports only its mute level. It has no physical start/end control,
 * so every conversation intent below arrives over the mounted capability.
 */
static const struct iterate_kit_board_ops board_ops = {
  .start = board_start,
  .present = board_present,
  .poll = board_poll,
};

static const struct iterate_kit_board_facts voice_facts = {
  .device_name = "host-test",
  .speaker = {0},
  .speaker_dry_wait_ms = 40U,
  .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_stack_bytes = 4096U,
};

/* --- driving the loop ----------------------------------------------------- */

static struct board board;

/*
 * ONE BOOT, AND THEN SCENARIOS IN ORDER.
 *
 * The loop is a program rather than an object: its state is one file-static
 * because a board has one of everything, and it brings itself up once. Calling
 * init twice fails its own bounded-runtime guard and parks — correctly, since a
 * device that re-initialised its rings under a live session would be a worse
 * bug than any this file tests. So the fixture boots once and each scenario
 * starts by putting the intent back down, exactly as a person hanging up does.
 */
static void boot(void) {
  iterate_kit_fake_esp_idf_reset();
  iterate_kit_fake_platform_reset();
  memset(&board, 0, sizeof(board));
  iterate_kit_fake_esp_idf_set_now_us(1000000);
  assert(
      iterate_kit_voice_loop_init(
          &board_ops, &voice_facts, &board));
  /* Boot ran to the end rather than parking: both audio tasks were asked for. */
  assert(iterate_kit_fake_esp_idf_tasks_created() == 2U);
  assert(!iterate_kit_fake_esp_idf_restart_requested());
  assert(board.started);
  iterate_kit_fake_platform_connect();
}

static void step(void) {
  iterate_kit_fake_esp_idf_advance_ms(50U);
  iterate_kit_voice_loop_step((uint64_t)(esp_timer_get_time() / 1000));
}

/*
 * A REMOTE CONVERSATION CONTROL, AS BYTES.
 *
 * Target 0 is the session's main capability, which is the peer the loop
 * assembled out of conversation control, the speaker, health and
 * whatever the board added. So this is not a test hook or a shortcut into the
 * loop's internals: it is the message a caller sends, arriving where a caller's
 * message arrives.
 */
static int64_t next_inbound_call_id = 1;

static void deliver(
    struct iterate_kit_itx_connection *connection, const char *message) {
  assert(
      iterate_kit_itx_connection_receive_text(
          connection, message, strlen(message)) == CAPNWEB_OK);
}

static void remote_call(const char *first, const char *second) {
  char message[256];
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  assert(connection != NULL);
  (void)snprintf(
      message,
      sizeof(message),
      "[\"push\",[\"pipeline\",0,[\"%s\",\"%s\"],[[]]]]",
      first,
      second);
  deliver(connection, message);
  /*
   * AND RELEASE IT, because a caller that never does is a caller that fills the
   * device's fixed pending-call table and wedges the session — which the device
   * would report and this test would then be about. Inbound calls are numbered
   * from one by the session, so the id is ours to predict.
   */
  (void)snprintf(
      message, sizeof(message), "[\"release\",%lld,1]",
      (long long)next_inbound_call_id++);
  deliver(connection, message);
}

/* Model a wake/control edge arriving while codec read has not returned. */
static void activate_during_codec_read(void) {
  remote_call("conversation", "start");
}

/** Back to idle, and prove it, so the next scenario starts from nothing. */
static void quiescent(void) {
  remote_call("conversation", "end");
  step();
  assert(!board.last_view.wants_call);
}

/*
 * ANSWER WHATEVER THE DEVICE ASKED, THE WAY A LIVE /api WOULD.
 *
 * The mount is a chain of one-way pushes each followed by a pull —
 * authenticate, projects.connect, projects.get, streams.get, openConnection —
 * and every one of them resolves to a capability. Replying to each pull by id
 * is the whole of it, which is why this is a loop rather than a script: the
 * chain's length is the device's business, not this test's.
 */
static size_t answered;

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
    step();
    if (!answered_any && round > 3) break;
  }
}

static void run_ms(uint32_t milliseconds) {
  uint32_t elapsed;
  for (elapsed = 0U; elapsed < milliseconds; elapsed += 50U) step();
}

/** Say something: `frames` 20 ms frames leave the codec and enter the loop. */
static void speak_frames(size_t frames) {
  capture_frames_pending = frames;
  while (capture_frames_pending > 0U) iterate_kit_voice_loop_capture_step();
}

/** Did the device put `needle` on the wire anywhere after message `from`? */
static bool sent_after_contains(size_t from, const char *needle) {
  size_t index;
  for (index = from; index < iterate_kit_fake_platform_sent_count(); ++index) {
    if (strstr(iterate_kit_fake_platform_sent(index), needle) != NULL) {
      return true;
    }
  }
  return false;
}

static size_t first_sent_after_containing(size_t from, const char *needle) {
  for (size_t index = from; index < iterate_kit_fake_platform_sent_count(); ++index) {
    if (strstr(iterate_kit_fake_platform_sent(index), needle) != NULL) {
      return index;
    }
  }
  return iterate_kit_fake_platform_sent_count();
}

static const char *current_activation(void) {
  static char activation[65];
  for (size_t index = iterate_kit_fake_platform_sent_count(); index-- > 0U;) {
    const char *message = iterate_kit_fake_platform_sent(index);
    const char *field = message == NULL ? NULL : strstr(message, "\"activation\":\"");
    if (field != NULL) {
      field += strlen("\"activation\":\"");
      size_t length = strcspn(field, "\"");
      assert(length < sizeof(activation));
      memcpy(activation, field, length);
      activation[length] = '\0';
      return activation;
    }
  }
  return "ignored-activation";
}

static int base64_value(char value) {
  if (value >= 'A' && value <= 'Z') return value - 'A';
  if (value >= 'a' && value <= 'z') return value - 'a' + 26;
  if (value >= '0' && value <= '9') return value - '0' + 52;
  if (value == '+') return 62;
  if (value == '/') return 63;
  return -1;
}

/* Collect the PCM from every microphone event without trusting batch shape. */
static size_t collect_sent_microphone(
    size_t from, uint8_t *destination, size_t capacity) {
  size_t written = 0U;
  for (size_t index = from; index < iterate_kit_fake_platform_sent_count(); ++index) {
    const char *message = iterate_kit_fake_platform_sent(index);
    const char *pcm = message == NULL ? NULL : strstr(message, "\"pcm\":\"");
    if (pcm == NULL) continue;
    pcm += strlen("\"pcm\":\"");
    while (pcm[0] != '\0' && pcm[0] != '"') {
      const int a = base64_value(pcm[0]);
      const int b = base64_value(pcm[1]);
      const int c = pcm[2] == '=' ? 0 : base64_value(pcm[2]);
      const int d = pcm[3] == '=' ? 0 : base64_value(pcm[3]);
      assert(a >= 0 && b >= 0 && c >= 0 && d >= 0);
      assert(written + 1U <= capacity);
      destination[written++] = (uint8_t)((a << 2) | (b >> 4));
      if (pcm[2] != '=') {
        assert(written + 1U <= capacity);
        destination[written++] = (uint8_t)((b << 4) | (c >> 2));
      }
      if (pcm[3] != '=') {
        assert(written + 1U <= capacity);
        destination[written++] = (uint8_t)((c << 6) | d);
      }
      pcm += 4;
    }
  }
  return written;
}

static int16_t collected_sample(const uint8_t *pcm, size_t frame) {
  const size_t offset = frame * ITERATE_KIT_VOICE_FRAME_BYTES;
  return (int16_t)((uint16_t)pcm[offset] | ((uint16_t)pcm[offset + 1U] << 8));
}

/** One speaker chunk for the accepted call: 30 bytes of PCM, optionally `last`. */
/** The callback export of the NEWEST connection this device opened. */
static long latest_callback_export_id(void) {
  size_t index = iterate_kit_fake_platform_sent_count();
  while (index-- > 0U) {
    const char *sent = iterate_kit_fake_platform_sent(index);
    const char *field = sent == NULL ? NULL : strstr(sent, "\"processEventBatch\":");
    const char *marker = field == NULL ? NULL : strstr(field, "[\"export\",");
    if (marker != NULL) return strtol(marker + strlen("[\"export\","), NULL, 10);
  }
  assert(!"no openConnection on the recorder");
  return 0;
}

/*
 * ONE OFFSET COUNTER FOR EVERY SYNTHETIC EVENT. The stream dedupes by offset,
 * so a helper with its own numbering silently dropped its event once another
 * helper had pushed the watermark past it — an hour of "the call is accepted
 * and the device disagrees" before that showed up.
 */
static long next_event_offset = 200;

static void deliver_spk_chunk(bool last) {
  static char message[768];
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  const long export_id = latest_callback_export_id();
  const long offset = next_event_offset++;
  assert(connection != NULL);
  (void)snprintf(
      message,
      sizeof(message),
      "[\"push\",[\"pipeline\",%ld,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\","
      "\"offset\":%ld,"
      "\"payload\":{\"activation\":\"%s\",\"conversationId\":\"convdial\",\"deviceSpeakerFrameSeq\":%ld,%s"
      "\"pcm\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}}"
      "]],\"scannedThroughOffset\":%ld,\"state\":null}]]]",
      export_id, offset, current_activation(), offset,
      last ? "\"lastFrameOfAnswer\":true," : "", offset);
  deliver(connection, message);
  {
    char release[64];
    (void)snprintf(
        release, sizeof(release), "[\"release\",%lld,1]",
        (long long)next_inbound_call_id++);
    deliver(connection, release);
  }
}

/** conversation-accepted for the NEWEST connection (deliver_accepted aims at the first). */
static void deliver_accepted_latest(void) {
  static char message[512];
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  const long export_id = latest_callback_export_id();
  const long offset = next_event_offset++;
  assert(connection != NULL);
  (void)snprintf(
      message,
      sizeof(message),
      "[\"push\",[\"pipeline\",%ld,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
      "\"offset\":%ld,"
      "\"payload\":{\"activation\":\"%s\",\"conversationId\":\"convdial\",\"handshakeTookMs\":2000}}"
      "]],\"scannedThroughOffset\":%ld,\"state\":null}]]]",
      export_id, offset, current_activation(), offset);
  deliver(connection, message);
  {
    char release[64];
    (void)snprintf(
        release, sizeof(release), "[\"release\",%lld,1]",
        (long long)next_inbound_call_id++);
    deliver(connection, release);
  }
}

static void deliver_ended_latest(void) {
  static char message[512];
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  const long export_id = latest_callback_export_id();
  const long offset = next_event_offset++;
  assert(connection != NULL);
  (void)snprintf(
      message,
      sizeof(message),
      "[\"push\",[\"pipeline\",%ld,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-ended\","
      "\"offset\":%ld,"
      "\"payload\":{\"activation\":\"%s\",\"reason\":\"server-ended\"}}"
      "]],\"scannedThroughOffset\":%ld,\"state\":null}]]]",
      export_id, offset, current_activation(), offset);
  deliver(connection, message);
  (void)snprintf(
      message, sizeof(message), "[\"release\",%lld,1]",
      (long long)next_inbound_call_id++);
  deliver(connection, message);
}

/* --- the tests ------------------------------------------------------------ */

/*
 * THE ONE THAT WOULD HAVE SAVED THE AFTERNOON.
 *
 * One `conversation.start()` reaches the loop through the mounted capability
 * and opens continuous capture.
 */
static void conversation_start_raises_wants_call_with_no_button(void) {
  quiescent();

  remote_call("conversation", "start");
  step();

  assert(board.last_view.wants_call);
}

/*
 * Conversation control opens continuous capture and `conversation.end()` puts
 * it back down.
 */
static void conversation_control_opens_and_ends_a_call(void) {
  quiescent();
  remote_call("conversation", "start");
  step();
  assert(board.last_view.wants_call);

  remote_call("conversation", "end");
  step();

  assert(!board.last_view.wants_call);
}

/*
 * No physical start/end control is involved in the scenarios above.
 */
static void nothing_physical_was_involved(void) {
  assert(!board.microphone_muted);
  assert(!iterate_kit_fake_esp_idf_restart_requested());
  assert(board.presented > 0U);
}

/* Ending and starting in one inbound drain creates B, never revives A. */
static void same_pass_end_then_start_creates_a_new_activation(void) {
  char activation_a[65];
  const size_t before = iterate_kit_fake_platform_sent_count();
  quiescent();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(50U);
  (void)snprintf(activation_a, sizeof(activation_a), "%s", current_activation());

  remote_call("conversation", "end");
  remote_call("conversation", "start");
  step();
  speak_frames(1U);
  run_ms(50U);

  assert(board.last_view.wants_call);
  assert(strcmp(current_activation(), activation_a) != 0);
  assert(sent_after_contains(before, "conversation-ended"));
  quiescent();
}

/* A capability start cannot override an already asserted physical mute. */
static void muted_remote_start_does_not_open_capture(void) {
  const size_t before = iterate_kit_fake_platform_sent_count();
  quiescent();
  board.microphone_muted = true;
  step();
  remote_call("conversation", "start");
  step();
  speak_frames(1U);
  run_ms(50U);
  assert(!board.last_view.wants_call);
  assert(!sent_after_contains(before, "\"pcm\":\""));
  board.microphone_muted = false;
  step();
}

/* A rejected local append ends the activation with an explicit classification. */
static void failed_microphone_append_ends_the_activation(void) {
  quiescent();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  iterate_kit_fake_platform_fail_next_send();
  run_ms(50U);
  assert(!board.last_view.wants_call);
  assert(strcmp(board.last_view.status, "microphone append failed") == 0);
}

/*
 * Wake detection reaches the app after audio has already crossed the codec.
 * The first, middle and following frames must therefore survive the mount
 * and reach the stream in chronological order, even though no call was ready
 * while they were captured.
 */
static void pre_mount_speech_is_preserved_and_sent_immediately(void) {
  uint8_t pcm[6U * ITERATE_KIT_VOICE_FRAME_BYTES];
  const size_t before = iterate_kit_fake_platform_sent_count();
  quiescent();
  capture_frame_value = 1000;

  remote_call("conversation", "start");
  step();
  speak_frames(1U); /* prefix */
  speak_frames(4U); /* middle */
  speak_frames(1U); /* following frame */
  step();

  assert(!sent_after_contains(before, "mic-frame"));
  pump();
  run_ms(50U);
  assert(sent_after_contains(before, "mic-frame"));
  assert(collect_sent_microphone(before, pcm, sizeof(pcm)) == sizeof(pcm));
  assert(collected_sample(pcm, 0U) == 1000);
  assert(collected_sample(pcm, 3U) == 1003);
  assert(collected_sample(pcm, 5U) == 1005);
}

/* Ending A fences its queued tail before B gets a fresh activation. */
static void ending_a_never_sends_its_tail_as_b(void) {
  char activation_a[65];
  size_t after_end;
  quiescent();
  remote_call("conversation", "start");
  step();
  speak_frames(3U);
  run_ms(50U);
  (void)snprintf(activation_a, sizeof(activation_a), "%s", current_activation());

  remote_call("conversation", "end");
  step();
  after_end = iterate_kit_fake_platform_sent_count();
  run_ms(100U);
  assert(!sent_after_contains(after_end, "mic-frame"));

  remote_call("conversation", "start");
  step();
  speak_frames(1U);
  run_ms(50U);
  assert(strcmp(current_activation(), activation_a) != 0);
}

/* A cancellation before mount is durable and ordered ahead of B's microphone. */
static void ending_before_acceptance_terminates_a_before_b(void) {
  const size_t before = iterate_kit_fake_platform_sent_count();
  size_t terminal;
  size_t microphone;
  quiescent();
  remote_call("conversation", "start");
  step();
  speak_frames(1U);
  remote_call("conversation", "end");
  step();

  remote_call("conversation", "start");
  step();
  speak_frames(1U);
  pump();
  run_ms(50U);

  terminal = first_sent_after_containing(before, "conversation-ended");
  microphone = first_sent_after_containing(before, "\"pcm\":");
  assert(terminal < iterate_kit_fake_platform_sent_count());
  assert(microphone < iterate_kit_fake_platform_sent_count());
  assert(terminal < microphone);
  assert(sent_after_contains(terminal, "\"reason\":\"button\""));
  quiescent();
}

/* A server terminal fences queued A audio before a later local B starts. */
static void server_end_discards_a_tail_before_b(void) {
  uint8_t pcm[12U * ITERATE_KIT_VOICE_FRAME_BYTES];
  size_t after_end;
  quiescent();
  capture_frame_value = 4000;
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(50U);
  deliver_accepted_latest();
  step();
  speak_frames(10U);
  deliver_ended_latest();
  for (size_t wait = 0U; wait < 10U; ++wait) step();
  after_end = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  step();
  capture_frame_value = 5000;
  speak_frames(1U);
  speak_frames(1U);
  run_ms(50U);
  assert(collect_sent_microphone(after_end, pcm, sizeof(pcm)) ==
         2U * ITERATE_KIT_VOICE_FRAME_BYTES);
  assert(collected_sample(pcm, 0U) == 5000);
  quiescent();
}

/*
 * AN ACCEPTED CALL WITH NOTHING OWED IS QUIET, NOT DEAD. GPT-Live's facet
 * drops idle silence, so a person thinking and a model listening deliver no
 * batch at all; the downlink deadline must not read that as a lost lane and
 * recycle the connection (it did, every ten seconds, 2026-09-11).
 */
static void an_idle_accepted_call_is_not_recycled_for_silence(void) {
  size_t after_accept;
  size_t after_answer;
  quiescent();
  after_accept = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  run_ms(1500U);
  speak_frames(10U);
  run_ms(200U);
  step();
  deliver_accepted_latest();
  run_ms(2000U);
  /* The words went up (the first frame opens the call) and the call is live. */
  assert(sent_after_contains(after_accept, "mic-frame"));
  /* The answer came and finished: nothing more is owed. */
  deliver_spk_chunk(false);
  deliver_spk_chunk(true);
  run_ms(1000U);
  after_answer = iterate_kit_fake_platform_sent_count();
  run_ms(ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS * 3U);
  assert(!sent_after_contains(after_answer, "openConnection"));
}

/*
 * A LANE THAT GOES SILENT MID-ANSWER IS DEAD. An answer began and its `last`
 * never came: ten seconds of nothing owed-and-undelivered is the failure the
 * deadline exists for, and the recycle still fires.
 */
static void a_lane_silent_mid_answer_is_recycled(void) {
  size_t after_accept;
  size_t after_chunk;
  quiescent();
  after_accept = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  run_ms(1500U);
  speak_frames(10U);
  run_ms(200U);
  step();
  deliver_accepted_latest();
  run_ms(2000U);
  assert(sent_after_contains(after_accept, "mic-frame"));
  deliver_spk_chunk(false);
  after_chunk = iterate_kit_fake_platform_sent_count();
  run_ms(ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS + 2000U);
  assert(sent_after_contains(after_chunk, "openConnection"));
}

/* The frame that was in a blocking read when wake arrived remains behind the
 * idle history. The next active frame flushes all of it in chronological order. */
static void activation_during_codec_read_keeps_idle_pre_roll(void) {
  uint8_t pcm[7U * ITERATE_KIT_VOICE_FRAME_BYTES];
  const size_t before = iterate_kit_fake_platform_sent_count();
  quiescent();
  /* Let capture consume the terminal fence before building fresh idle history. */
  speak_frames(1U);
  capture_frame_value = 3000;
  speak_frames(5U);
  capture_read_hook = activate_during_codec_read;
  speak_frames(1U);
  step();
  speak_frames(1U);
  pump();
  run_ms(50U);
  assert(collect_sent_microphone(before, pcm, sizeof(pcm)) == sizeof(pcm));
  assert(collected_sample(pcm, 0U) == 3000);
  assert(collected_sample(pcm, 5U) == 3005);
  assert(collected_sample(pcm, 6U) == 3006);
  step();
}

/* An unanswered activation stops once at 20 seconds and says why. */
static void an_unaccepted_activation_times_out_once(void) {
  const size_t before = iterate_kit_fake_platform_sent_count();
  quiescent();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(50U);
  run_ms(20000U);
  /* The terminal survives an unavailable mount and is appended once it recovers. */
  pump();
  step();
  assert(!board.last_view.wants_call);
  assert(strcmp(board.last_view.status, "opening timed out") == 0);
  assert(sent_after_contains(before, "conversation-ended"));
  assert(sent_after_contains(before, "opening-timeout"));
}

int main(void) {
  boot();
  conversation_start_raises_wants_call_with_no_button();
  conversation_control_opens_and_ends_a_call();
  nothing_physical_was_involved();

  pre_mount_speech_is_preserved_and_sent_immediately();
  same_pass_end_then_start_creates_a_new_activation();
  muted_remote_start_does_not_open_capture();

  ending_a_never_sends_its_tail_as_b();
  ending_before_acceptance_terminates_a_before_b();
  server_end_discards_a_tail_before_b();
  pump();
  an_idle_accepted_call_is_not_recycled_for_silence();
  a_lane_silent_mid_answer_is_recycled();
  activation_during_codec_read_keeps_idle_pre_roll();
  an_unaccepted_activation_times_out_once();
  failed_microphone_append_ends_the_activation();
  return 0;
}
