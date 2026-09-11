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
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/conversation_launch.h"
#include "iterate/kit/voice_device_profile.h"

#include <stdbool.h>
#include <inttypes.h>
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
  bool physical_start_edge;
  bool physical_held;
};

/* Deliberately larger than 4096 bytes together with the shared fields: every
 * counter is valid uint32 telemetry, so a health reply must retain them all. */
static size_t board_health(void *context, char *out, size_t capacity) {
  enum { BOARD_HEALTH_COUNTERS = 70 };
  size_t used = 0U;
  (void)context;
  for (size_t index = 0U; index < BOARD_HEALTH_COUNTERS; ++index) {
    char name[32];
    const int named = snprintf(
        name, sizeof(name), "boardMaximumCounter%02u", (unsigned)index);
    const struct iterate_kit_health_field field = {
        .name = name,
        .value = UINT32_MAX,
    };
    if (named <= 0 || (size_t)named >= sizeof(name)) return 0U;
    const size_t added = iterate_kit_health_append_fields(
        out + used, capacity - used, &field, 1U);
    if (added == 0U) return 0U;
    used += added;
  }
  return used;
}

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

/* A controllable already-classified PTT edge/level for the launch timeout. */
static void board_poll(void *context, struct iterate_kit_voice_intent *out) {
  struct board *board = context;
  out->start_call = board->physical_start_edge;
  out->talk_held = board->physical_held;
  board->physical_start_edge = false;
}

/*
 * NO `poll`, WHICH IS THE POINT. A NULL op is a board saying it has no such
 * hardware, so this program contains no physical control of any kind — every
 * intent below had to arrive over the wire to arrive at all.
 */
static const struct iterate_kit_board_ops board_ops = {
  .start = board_start,
  .poll = board_poll,
  .present = board_present,
  .health = board_health,
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
    bool stream_head = false;
    while (answered < iterate_kit_fake_platform_sent_count()) {
      const char *message = iterate_kit_fake_platform_sent(answered);
      const char *pull = strstr(message, "[\"pull\",");
      if (strstr(message, "getEventPage") != NULL) stream_head = true;
      ++answered;
      if (pull == NULL) continue;
      {
        char reply[128];
        const long id = strtol(pull + strlen("[\"pull\","), NULL, 10);
        if (stream_head) {
          (void)snprintf(
              reply, sizeof(reply), "[\"resolve\",%ld,{\"streamMaxOffset\":0}]", id);
          stream_head = false;
        } else {
          (void)snprintf(
              reply, sizeof(reply), "[\"resolve\",%ld,[\"export\",%ld]]", id,
              -(id + 10));
        }
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

/** Everything the device sent from now on is somebody else's problem. */
static void ignore_pending_replies(void) {
  answered = iterate_kit_fake_platform_sent_count();
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

/* Resolve one ptt-start append successfully while deliberately withholding its
 * conversation-accepted reduction. */
static void resolve_start_append(size_t from) {
  size_t index;
  bool saw_start = false;
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  assert(connection != NULL);
  for (index = from; index < iterate_kit_fake_platform_sent_count(); ++index) {
    const char *message = iterate_kit_fake_platform_sent(index);
    const char *pull;
    if (strstr(message, "ptt-start") != NULL) saw_start = true;
    if (saw_start) {
      pull = strstr(message, "[\"pull\",");
      if (pull == NULL) continue;
      char reply[96];
      const long id = strtol(pull + strlen("[\"pull\","), NULL, 10);
      (void)snprintf(reply, sizeof(reply), "[\"resolve\",%ld,[{\"ok\":true}]]", id);
      deliver(connection, reply);
      return;
    }
  }
  assert(saw_start);
  assert(false);
}

/*
 * Deliver the call's acceptance, exactly as the stream delivers it — through
 * the `processEventBatch` callback the loop itself exported, whose id is read
 * out of the message the device SENT rather than assumed. The same shape
 * `voice_loop_answer_clock_test.c` delivers, for the same reason.
 */
static void deliver_accepted(void) {
  static char message[512];
  static uint64_t next_offset = 1000U;
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
      "\"offset\":%" PRIu64 ","
      "\"payload\":{\"conversationId\":\"convdial\",\"handshakeTookMs\":2000}}"
      "]],\"scannedThroughOffset\":%" PRIu64 ",\"state\":null}]]]",
      export_id, next_offset, next_offset);
  ++next_offset;
  deliver(connection, message);
  {
    char release[64];
    (void)snprintf(
        release, sizeof(release), "[\"release\",%lld,1]",
        (long long)next_inbound_call_id++);
    deliver(connection, release);
  }
}

static void deliver_ended(void) {
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
      "{\"type\":\"events.iterate.com/voice-agent/conversation-ended\","
      "\"offset\":10000000,\"payload\":{\"conversationId\":\"convdial\"}}"
      "]],\"scannedThroughOffset\":10000000,\"state\":null}]]]",
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
 * AND RELEASING TALK DOES NOT HANG UP. `ptt-end` commits a turn on the stream;
 * it does not end the conversation, and neither does this. A device that
 * dropped the call on every release would take one turn and stop.
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
 * NOTHING PHYSICAL WAS INVOLVED IN ANY OF THE ABOVE. The test board exposes a
 * controllable poll only for the held-timeout regression below; it begins idle,
 * so these RPC scenarios still arrive through the mounted capability alone.
 */
static void nothing_physical_was_involved(void) {
  assert(!board.physical_start_edge && !board.physical_held);
  assert(!iterate_kit_fake_esp_idf_restart_requested());
  assert(board.presented > 0U);
}

/*
 * A PRESS ASKS THE HOP WHETHER IT IS STILL THERE, AND ONE ANSWER IS ENOUGH.
 *
 * These two need a MOUNTED device, because arming happens where the call is
 * placed and that is behind the loop's whole ready gate. Everything above needs
 * only a session, which is why the mount is paid for here and not in boot().
 */
static void a_press_into_a_live_hop_asks_once(void) {
  const size_t probes = iterate_kit_fake_platform_probes_requested();
  iterate_kit_fake_platform_set_hop_answers(true);
  quiescent();

  remote_call("pushToTalk", "start");
  step();
  /* The press placed a call, and the call asked. */
  assert(iterate_kit_fake_platform_probes_requested() == probes + 1U);

  /*
   * AND THEN NOTHING HAPPENS, which is the assertion. A hop that answers is
   * asked once; a second probe or a replaced socket here would mean the device
   * tears down healthy sessions, which is worse than the bug this fixes.
   */
  run_ms(4000U);
  assert(iterate_kit_fake_platform_probes_requested() == probes + 1U);
  assert(iterate_kit_fake_platform_restarts_requested() == 0U);
}

/*
 * A held wake cannot turn a healthy-but-unreduced append stream into an
 * infinite client-side retry. It needs a new physical edge or a new RPC after
 * the full cold-start budget has failed; a late acceptance is closed because
 * the person no longer wants that call.
 */
static void a_held_unaccepted_call_times_out_until_an_explicit_retry(void) {
  size_t after_failure;
  size_t retry_from;
  size_t restarts_before;
  quiescent();
  pump();
  run_ms(ITERATE_KIT_LAUNCH_PLACE_RETRY_MS + 500U);
  iterate_kit_fake_platform_set_hop_answers(true);
  restarts_before = iterate_kit_fake_platform_restarts_requested();

  const size_t first_start = iterate_kit_fake_platform_sent_count();
  board.physical_held = true;
  board.physical_start_edge = true;
  step();
  assert(sent_after_contains(first_start, "ptt-start"));
  step();
  resolve_start_append(first_start);
  step();

  /* The append succeeded and the PONGs are healthy, but no acceptance arrives.
   * Switch to open mic before expiry: its post-launch edge must not overwrite
   * the terminal state with "listening" on this same pass or the next. */
  iterate_kit_voice_loop_set_turns(ITERATE_KIT_VOICE_TURNS_SERVER_VAD);
  run_ms(ITERATE_KIT_LAUNCH_ACCEPTANCE_TIMEOUT_MS + 500U);
  assert(!board.last_view.wants_call);
  assert(!board.last_view.listening);
  assert(strcmp(board.last_view.status, "call start timed out — press to retry") == 0);
  step();
  assert(!board.last_view.listening);
  assert(strcmp(board.last_view.status, "call start timed out — press to retry") == 0);
  assert(iterate_kit_fake_platform_restarts_requested() == restarts_before);

  after_failure = iterate_kit_fake_platform_sent_count();
  run_ms(5000U);
  assert(!sent_after_contains(after_failure, "ptt-start"));
  assert(!board.last_view.wants_call);

  /* A late stream event must be ended, never revive the failed local intent. */
  retry_from = iterate_kit_fake_platform_sent_count();
  deliver_accepted();
  run_ms(200U);
  assert(!board.last_view.wants_call);
  assert(sent_after_contains(retry_from, "conversation-ended"));
  deliver_ended();
  run_ms(200U);

  /* Held across failure is spent. Release then a new edge places exactly once. */
  board.physical_held = false;
  run_ms(100U);
  retry_from = iterate_kit_fake_platform_sent_count();
  board.physical_held = true;
  board.physical_start_edge = true;
  step();
  assert(sent_after_contains(retry_from, "ptt-start"));
  run_ms(500U);
  assert(!sent_after_contains(retry_from + 1U, "ptt-start"));
  board.physical_held = false;
  run_ms(100U);
}

/*
 * SPEECH RELEASED INTO THE DIAL IS THE FIRST TURN, NOT NOTHING.
 *
 * Press from sleep, say "count to forty", let go — and the call connects
 * seconds later. The words were captured from the moment the device started
 * listening, so the accepted call must carry them as its FIRST turn: drain
 * the queue, commit, get an answer. The old doctrine cleared the dial buffer
 * on a release the call had not caught up with yet, and a person who spoke
 * into the dial and let go got a call that opened onto silence. Reverting
 * the release-during-dial reversal in voice_loop.c fails the last three
 * assertions here.
 */
static void released_dial_speech_becomes_the_first_turn(void) {
  size_t after_release;
  size_t after_accept;
  quiescent();
  /* Wait out the ladder, so the press below is a fresh dial. */
  run_ms(ITERATE_KIT_LAUNCH_PLACE_RETRY_MS + 500U);

  /* Press from sleep and speak into the dial: 400 ms of words. */
  remote_call("pushToTalk", "start");
  step();
  speak_frames(20U);

  /* Let go before anything answered. */
  remote_call("pushToTalk", "stop");
  step();
  after_release = iterate_kit_fake_platform_sent_count();

  /* Seconds pass with no call: the words are HELD — not sent, not dropped,
   * and above all not committed into a call that does not exist. */
  run_ms(2000U);
  assert(!sent_after_contains(after_release, "mic-frame"));
  assert(!sent_after_contains(after_release, "ptt-end"));

  /* The call connects late, with the button long since up. */
  after_accept = iterate_kit_fake_platform_sent_count();
  deliver_accepted();
  run_ms(1000U);

  /* The buffered words opened a turn, drained into the call, and the turn
   * committed — the provider now owes an answer to what was said. */
  assert(sent_after_contains(after_accept, "ptt-start"));
  assert(sent_after_contains(after_accept, "mic-frame"));
  assert(sent_after_contains(after_accept, "ptt-end"));
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
 * A PRESS INTO A HALF-OPEN SOCKET IS ANSWERED IN ~3 s, NOT 10.
 *
 * The hop stops answering: TCP still accepts every byte, the transport stays
 * READY, and the call request the press sent is gone into nothing. Before this
 * probe existed, the first failure looked like a healthy quiet call. Two
 * probes, then the socket is replaced — one miss is a dropped
 * packet, and the second is what makes it evidence.
 */
static void a_press_into_a_dead_hop_replaces_the_socket(void) {
  size_t probes;
  quiescent();
  /*
   * WAIT OUT THE LADDER. Placing a call arms PLACE_RETRY_MS, so a second press
   * inside that window is deliberately not a second call — and the probe rides
   * the call, not the press. Virtual time, so this costs nothing.
   */
  run_ms(ITERATE_KIT_LAUNCH_PLACE_RETRY_MS + 500U);
  /*
   * Stop answering the device's calls as well as its probes: a socket that has
   * stopped carrying PONGs has stopped carrying replies too, and leaving the
   * application lane alive would test a hop that does not exist.
   */
  ignore_pending_replies();
  iterate_kit_fake_platform_set_hop_answers(false);
  probes = iterate_kit_fake_platform_probes_requested();

  remote_call("pushToTalk", "start");
  step();
  assert(iterate_kit_fake_platform_probes_requested() == probes + 1U);
  assert(iterate_kit_fake_platform_restarts_requested() == 0U);

  /* One unanswered probe is a dropped packet, so it asks again rather than act. */
  run_ms(1700U);
  assert(iterate_kit_fake_platform_probes_requested() == probes + 2U);
  assert(iterate_kit_fake_platform_restarts_requested() == 0U);

  /* Two in a row is a dead socket, and only a new socket fixes one. */
  run_ms(1700U);
  assert(iterate_kit_fake_platform_restarts_requested() == 1U);
}

/*
 * A SPEAKING DEVICE MUST NOT REBOOT MERELY BECAUSE ITS PERIODIC PING WAS
 * SUPPRESSED BY OUTBOUND TRAFFIC.
 *
 * The real WebSocket owner emits a PING after an inbound-silent interval even
 * while microphone frames go out. This loop-level witness models the result:
 * a mounted peer keeps delivering complete frames for more than the seven
 * minute restart deadline. The old PONG-only watchdog reboots here. Then the
 * peer goes silent, and the same READY transport must still reboot — outbound
 * writes are never allowed to renew this lease.
 */
static void inbound_hop_frames_keep_a_live_stream_alive_but_not_a_dead_one(void) {
  uint32_t elapsed;
  for (elapsed = 0U;
       elapsed < ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS + 60000U;
       elapsed += 60000U) {
    iterate_kit_fake_platform_receive_hop_frame();
    run_ms(60000U);
    assert(!iterate_kit_fake_esp_idf_restart_requested());
  }

  run_ms(ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS + 100U);
  assert(iterate_kit_fake_esp_idf_restart_requested());
}

/** health() follows adopted turns, including changes after boot. */
static void iterate_kit_health_reports_runtime_turns(void) {
  const struct {
    enum iterate_kit_voice_turns turns;
    const char *field;
  } rows[] = {
    {ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK, "\"pushToTalk\":true"},
    {ITERATE_KIT_VOICE_TURNS_SERVER_VAD, "\"pushToTalk\":false"},
    {ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK, "\"pushToTalk\":true"},
  };
  struct iterate_kit_itx_connection *connection = iterate_kit_fake_platform_connection();
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    char message[64];
    const size_t before = iterate_kit_fake_platform_sent_count();
    iterate_kit_voice_loop_set_turns(rows[i].turns);
    deliver(connection, "[\"push\",[\"pipeline\",0,[\"health\"],[[]]]]");
    (void)snprintf(message, sizeof(message), "[\"pull\",%lld]", (long long)next_inbound_call_id);
    deliver(connection, message);
    assert(sent_after_contains(before, rows[i].field));
    (void)snprintf(message, sizeof(message), "[\"release\",%lld,1]", (long long)next_inbound_call_id++);
    deliver(connection, message);
  }
}

static void health_keeps_large_board_counter_documents(void) {
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  const size_t before = iterate_kit_fake_platform_sent_count();
  assert(connection != NULL);
  deliver(connection, "[\"push\",[\"pipeline\",0,[\"health\"],[[]]]]");
  char pull[64];
  (void)snprintf(pull, sizeof(pull), "[\"pull\",%lld]", (long long)next_inbound_call_id++);
  deliver(connection, pull);
  const char *response = iterate_kit_fake_platform_find_sent("boardMaximumCounter69");
  assert(response != NULL);
  assert(strlen(response) > 4096U);
  assert(sent_after_contains(before, "boardMaximumCounter69"));
  (void)snprintf(pull, sizeof(pull), "[\"release\",%lld,1]", (long long)(next_inbound_call_id - 1));
  deliver(connection, pull);
}

int main(void) {
  boot();
  a_remote_press_raises_wants_call_with_no_button();
  releasing_talk_keeps_the_call();
  conversation_control_opens_and_ends_a_call();
  nothing_physical_was_involved();
  iterate_kit_health_reports_runtime_turns();
  health_keeps_large_board_counter_documents();

  /* From here on the device is mounted, so the launch ladder can run. */
  pump();
  a_press_into_a_live_hop_asks_once();
  pump();
  released_dial_speech_becomes_the_first_turn();
  a_silent_dial_release_commits_no_turn();
  pump();
  a_press_into_a_dead_hop_replaces_the_socket();
  a_held_unaccepted_call_times_out_until_an_explicit_retry();
  inbound_hop_frames_keep_a_live_stream_alive_but_not_a_dead_one();
  return 0;
}
