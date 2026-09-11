/*
 * WHAT A PRESS MEANS, TESTED ON A BOARD THAT HAS NO BUTTONS.
 *
 * `components/voice/src/voice_loop.c` is the one program all four boards run,
 * and until this file it was in no host build: its intent mapping was verified
 * by diffing it against the four device files it replaced, and that is exactly
 * where the bug lived. Driving a button board with `pushToTalk.start()` alone
 * looked completely dead — the press was accepted, latched, and never consulted
 * because the turn machine reads the latch only inside `wants_call`. An
 * afternoon of hardware bisection, and no test anywhere could have failed.
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
#include "iterate/kit/conversation_launch.h"
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
 * is a silent board, which is what every scenario but the dial-speech one
 * wants; see speak_frames.
 */
static size_t capture_frames_pending;

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
    /* Silent by default; the dial-speech test arms frames explicitly. */
    return ITERATE_KIT_UNAVAILABLE;
  }
  --capture_frames_pending;
  for (index = 0U; index < capacity_samples; ++index) capture[index] = 1000;
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

/*
 * NO `poll`, WHICH IS THE POINT. A NULL op is a board saying it has no such
 * hardware, so this program contains no physical control of any kind — every
 * intent below had to arrive over the wire to arrive at all.
 */
static const struct iterate_kit_board_ops board_ops = {
  .start = board_start,
  .present = board_present,
};

static const struct iterate_kit_board_facts push_to_talk_facts = {
  .stream_path = "/agents/voice/host-test",
  .client_path = "/clients/host-test",
  .conversation_id = "hosttest",
  .greeting = "hello",
  .instructions = "a board that exists only in a test",
  .peer_description = "{\"instructions\":\"host test\",\"children\":{}}",
  .talk_hint = "hold to talk",
  .call_hint = "press to call",
  .speaker = {0},
  .speaker_dry_wait_ms = 40U,
  .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_stack_bytes = 4096U,
  .turns = ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK,
  .radio_before_codec = false,
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
          &board_ops, &push_to_talk_facts, &board));
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
 * A REMOTE PRESS, AS BYTES.
 *
 * Target 0 is the session's main capability, which is the peer the loop
 * assembled out of push-to-talk, conversation control, the speaker, health and
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

/** Back to idle, and prove it, so the next scenario starts from nothing. */
static void quiescent(void) {
  remote_call("pushToTalk", "stop");
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

/*
 * Deliver the call's acceptance, exactly as the stream delivers it — through
 * the `processEventBatch` callback the loop itself exported, whose id is read
 * out of the message the device SENT rather than assumed. The same shape
 * `voice_loop_answer_clock_test.c` delivers, for the same reason.
 */
static void deliver_accepted(void) {
  static char message[512];
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  const char *found = iterate_kit_fake_platform_find_sent("processEventBatch");
  const char *field;
  const char *marker;
  long export_id;
  assert(connection != NULL);
  assert(found != NULL);
  field = strstr(found, "\"processEventBatch\":");
  assert(field != NULL);
  marker = strstr(field, "[\"export\",");
  assert(marker != NULL);
  export_id = strtol(marker + strlen("[\"export\","), NULL, 10);
  (void)snprintf(
      message,
      sizeof(message),
      "[\"push\",[\"pipeline\",%ld,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
      "\"offset\":100,"
      "\"payload\":{\"conversationId\":\"convdial\",\"handshakeTookMs\":2000}}"
      "]],\"scannedThroughOffset\":100,\"state\":null}]]]",
      export_id);
  deliver(connection, message);
  {
    char release[64];
    (void)snprintf(
        release, sizeof(release), "[\"release\",%lld,1]",
        (long long)next_inbound_call_id++);
    deliver(connection, release);
  }
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
      "\"payload\":{\"conversationId\":\"convdial\",\"deviceSpeakerFrameSeq\":%ld,%s"
      "\"pcm\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}}"
      "]],\"scannedThroughOffset\":%ld,\"state\":null}]]]",
      export_id, offset, offset, last ? "\"lastFrameOfAnswer\":true," : "", offset);
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
      "\"payload\":{\"conversationId\":\"convdial\",\"handshakeTookMs\":2000}}"
      "]],\"scannedThroughOffset\":%ld,\"state\":null}]]]",
      export_id, offset, offset);
  deliver(connection, message);
  {
    char release[64];
    (void)snprintf(
        release, sizeof(release), "[\"release\",%lld,1]",
        (long long)next_inbound_call_id++);
    deliver(connection, release);
  }
}

/* --- the tests ------------------------------------------------------------ */

/*
 * THE ONE THAT WOULD HAVE SAVED THE AFTERNOON.
 *
 * No preamble, no `conversation.start()`, no button: one press, and this device
 * is trying to be in a call. Reverting the two-line collapse in
 * handle_device_event fails exactly this assertion.
 */
static void a_remote_press_raises_wants_call_with_no_button(void) {
  quiescent();

  remote_call("pushToTalk", "start");
  step();

  assert(board.last_view.wants_call);
}

/*
 * AND RELEASING TALK DOES NOT HANG UP. A release closes the microphone gate
 * and says nothing to the far end; it does not end the conversation, and
 * neither does this. A device that dropped the call on every release would
 * take one turn and stop.
 */
static void releasing_talk_keeps_the_call(void) {
  quiescent();
  remote_call("pushToTalk", "start");
  step();
  assert(board.last_view.wants_call);

  remote_call("pushToTalk", "stop");
  step();

  assert(board.last_view.wants_call);
}

/*
 * THE OTHER VERB STILL EXISTS, and it is not the same verb. An open-mic board
 * has no press at all, and on a button board this is how you open a call to be
 * greeted without holding the microphone open — so it must raise the intent and
 * `conversation.end()` must put it back down.
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
 * NOTHING PHYSICAL WAS INVOLVED IN ANY OF THE ABOVE. This board declares no
 * `poll` op, which is a board saying it has no such hardware — asserted rather
 * than assumed, because a fixture that quietly grew a button would make every
 * scenario here meaningless.
 */
static void nothing_physical_was_involved(void) {
  assert(board_ops.poll == NULL);
  assert(!iterate_kit_fake_esp_idf_restart_requested());
  assert(board.presented > 0U);
}

/*
 * SPEECH SPOKEN INTO THE DIAL FLOWS AT ONCE, AND NO TURN IS EVER MARKED.
 *
 * Press from sleep, say "count to forty", let go — the words go up as mic
 * frames the moment the stream is up, call or no call: the first frame is
 * what opens the call and the facet holds the rest while it dials (it did
 * this device's holding for it; the device used to queue until accepted
 * behind a durable `ptt-start`). Push-to-talk left the wire on 2026-09-11:
 * no `ptt-start` on the press, no `ptt-end` on the release, nothing when the
 * call connects — the button is a microphone gate and the far side's own
 * voice activity decides the turn.
 */
static void dial_speech_flows_at_once_and_no_turn_is_marked(void) {
  size_t after_press;
  size_t after_accept;
  quiescent();
  /* Wait out the ladder, so the press below is a fresh dial. */
  run_ms(ITERATE_KIT_LAUNCH_PLACE_RETRY_MS + 500U);

  /* Press from sleep and speak into the dial: 400 ms of words. */
  after_press = iterate_kit_fake_platform_sent_count();
  remote_call("pushToTalk", "start");
  step();
  speak_frames(20U);
  run_ms(500U);
  /* Already on the wire, with no call accepted yet. */
  assert(sent_after_contains(after_press, "mic-frame"));
  assert(!sent_after_contains(after_press, "ptt-start"));

  /* Let go before anything answered: nothing is said about it. */
  remote_call("pushToTalk", "stop");
  step();
  run_ms(2000U);
  assert(!sent_after_contains(after_press, "ptt-end"));

  /* The call connects late, with the button long since up: still nothing. */
  after_accept = iterate_kit_fake_platform_sent_count();
  deliver_accepted_latest();
  run_ms(1000U);
  assert(!sent_after_contains(after_accept, "ptt-start"));
  assert(!sent_after_contains(after_accept, "ptt-end"));
  assert(!sent_after_contains(after_press, "button-pressed"));
}

/*
 * A PROMISE WITH NO WORDS IN IT COMMITS NOTHING. `dial_speech_queued` is
 * raised from intent — wanting the call while it dialled — but on a board
 * whose microphone only owns its pins behind the capture fence, the dial can
 * end with an empty queue. The accept path once opened a turn anyway and
 * committed an empty ptt-end, asking the provider to answer silence; now the
 * empty promise is consumed silently and the call waits for a real press.
 */
static void a_silent_dial_release_commits_no_turn(void) {
  size_t after_accept;
  quiescent();
  run_ms(ITERATE_KIT_LAUNCH_PLACE_RETRY_MS + 500U);

  /* Press from sleep, HOLD — long enough to be a hold, not a tap — and let
   * go without a single captured frame, the stick's fence-closed dial. */
  remote_call("pushToTalk", "start");
  run_ms(400U);
  remote_call("pushToTalk", "stop");
  step();

  /* Seconds pass with no call, exactly like the spoken sibling above. */
  run_ms(2000U);

  after_accept = iterate_kit_fake_platform_sent_count();
  deliver_accepted();
  run_ms(2000U);

  /* No turn opened on the empty queue: no commit, no mic audio. */
  assert(!sent_after_contains(after_accept, "ptt-end"));
  assert(!sent_after_contains(after_accept, "mic-frame"));
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
  run_ms(ITERATE_KIT_LAUNCH_PLACE_RETRY_MS + 500U);
  after_accept = iterate_kit_fake_platform_sent_count();
  remote_call("pushToTalk", "start");
  /* A HOLD, not a tap: a tap is the end-call gesture. */
  run_ms(1500U);
  speak_frames(10U);
  run_ms(200U);
  remote_call("pushToTalk", "stop");
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
  run_ms(ITERATE_KIT_LAUNCH_PLACE_RETRY_MS + 500U);
  after_accept = iterate_kit_fake_platform_sent_count();
  remote_call("pushToTalk", "start");
  /* A HOLD, not a tap: a tap is the end-call gesture. */
  run_ms(1500U);
  speak_frames(10U);
  run_ms(200U);
  remote_call("pushToTalk", "stop");
  step();
  deliver_accepted_latest();
  run_ms(2000U);
  assert(sent_after_contains(after_accept, "mic-frame"));
  deliver_spk_chunk(false);
  after_chunk = iterate_kit_fake_platform_sent_count();
  run_ms(ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS + 2000U);
  assert(sent_after_contains(after_chunk, "openConnection"));
}

int main(void) {
  boot();
  a_remote_press_raises_wants_call_with_no_button();
  releasing_talk_keeps_the_call();
  conversation_control_opens_and_ends_a_call();
  nothing_physical_was_involved();

  /* From here on the device is mounted, so the launch ladder can run. */
  pump();
  dial_speech_flows_at_once_and_no_turn_is_marked();
  a_silent_dial_release_commits_no_turn();
  pump();
  an_idle_accepted_call_is_not_recycled_for_silence();
  a_lane_silent_mid_answer_is_recycled();
  return 0;
}
