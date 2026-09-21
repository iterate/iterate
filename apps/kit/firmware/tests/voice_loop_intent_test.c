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

#include "esp_idf.h"
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
static void (*board_poll_hook)(void);

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
  if (board_poll_hook != NULL) {
    void (*hook)(void) = board_poll_hook;
    board_poll_hook = NULL;
    hook();
  }
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
  iterate_kit_host_esp_idf_reset();
  iterate_kit_fake_platform_reset();
  memset(&board, 0, sizeof(board));
  iterate_kit_host_esp_idf_set_now_us(1000000);
  assert(
      iterate_kit_voice_loop_init(
          &board_ops, &voice_facts, &board));
  /* Boot ran to the end rather than parking: both audio tasks were asked for. */
  assert(iterate_kit_host_esp_idf_tasks_created() == 2U);
  assert(!iterate_kit_host_esp_idf_restart_requested());
  assert(board.started);
  iterate_kit_fake_platform_connect();
}

static void step(void) {
  iterate_kit_host_esp_idf_advance_ms(50U);
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
  const enum capnweb_status status = iterate_kit_itx_connection_receive_text(
      connection, message, strlen(message));
  assert(status == CAPNWEB_OK);
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

static void fill_outbox_during_board_poll(void) {
  iterate_kit_fake_platform_fill_control_outbox();
}

static bool sent_after_contains(size_t from, const char *needle);
static void pump(void);

/** Back to idle, and prove it, so the next scenario starts from nothing. */
static void quiescent(void) {
  remote_call("conversation", "end");
  step();
  /* Drain setup replies and callback releases even when no PCM reached the
   * stream. Those RPC contexts remain owned until the fake server replies. */
  pump();
  assert(!board.last_view.wants_call);
}

/*
 * ANSWER WHATEVER THE DEVICE ASKED, THE WAY A LIVE /api WOULD.
 *
 * The mount is a chain of one-way pushes each followed by a pull —
 * authenticate, projects.get, provide, cd, subscribe —
 * and every one of them resolves to a capability. Replying to each pull by id
 * is the whole of it, which is why this is a loop rather than a script: the
 * chain's length is the device's business, not this test's.
 */
static size_t answered;
static bool defer_voice_setup;
static bool defer_stream_get;
static long deferred_stream_get_id;
static struct {
  long id;
  char stream_path[160];
} deferred_voice_setups[2];
static size_t deferred_voice_setup_count;
struct open_connection {
  long capability;
  long callback;
  char stream_path[160];
};
static struct open_connection open_connections[8];
static struct {
  long callback;
  char stream_path[160];
} pending_open_connections[8];
static size_t pending_open_connection_count;
/* Cap'n Web emits each call's push before its pull, preserving this FIFO even
 * while setup replies for separate activations overlap. */
static struct {
  long capability;
  char stream_path[160];
} stream_capabilities[8];
static char pending_stream_paths[8][160];
static size_t pending_stream_path_count;

static bool copy_pipeline_target(const char *message, long *out) {
  const char *target = strstr(message, "[\"pipeline\",");
  if (target == NULL) return false;
  target += strlen("[\"pipeline\",");
  *out = strtol(target, NULL, 10);
  return true;
}

static const char *stream_path_for_capability(long capability) {
  for (size_t slot = 0U; slot < 8U; ++slot) {
    if (stream_capabilities[slot].capability == capability) {
      return stream_capabilities[slot].stream_path;
    }
  }
  return NULL;
}

static void remember_stream_capability(long capability, const char *stream_path) {
  for (size_t slot = 0U; slot < 8U; ++slot) {
    if (stream_capabilities[slot].capability == 0L) {
      stream_capabilities[slot].capability = capability;
      (void)snprintf(stream_capabilities[slot].stream_path,
          sizeof(stream_capabilities[slot].stream_path), "%s", stream_path);
      return;
    }
  }
  assert(false);
}

static void enqueue_open_connection(long callback, const char *stream_path) {
  assert(pending_open_connection_count <
         sizeof(pending_open_connections) / sizeof(pending_open_connections[0]));
  pending_open_connections[pending_open_connection_count].callback = callback;
  (void)snprintf(
      pending_open_connections[pending_open_connection_count].stream_path,
      sizeof(pending_open_connections[pending_open_connection_count].stream_path),
      "%s", stream_path != NULL ? stream_path : "");
  ++pending_open_connection_count;
}

static void remember_open_connection(long capability) {
  size_t slot;
  assert(pending_open_connection_count > 0U);
  for (slot = 0U; slot < 8U; ++slot) {
    if (open_connections[slot].capability == 0L) break;
  }
  assert(slot < 8U);
  open_connections[slot].capability = capability;
  open_connections[slot].callback = pending_open_connections[0].callback;
  (void)snprintf(open_connections[slot].stream_path,
      sizeof(open_connections[slot].stream_path), "%s",
      pending_open_connections[0].stream_path);
  memmove(&pending_open_connections[0], &pending_open_connections[1],
      (pending_open_connection_count - 1U) * sizeof(pending_open_connections[0]));
  --pending_open_connection_count;
}

static bool copy_setup_stream_path(const char *message, char *out, size_t capacity) {
  const char *field = strstr(message, "\"streamPath\":\"");
  size_t length;
  if (field == NULL) return false;
  field += strlen("\"streamPath\":\"");
  length = strcspn(field, "\"");
  if (length == 0U || length >= capacity) return false;
  memcpy(out, field, length);
  out[length] = '\0';
  return true;
}

static bool copy_stream_get_path(const char *message, char *out, size_t capacity) {
  const char *call = strstr(message, "[\"cd\"]");
  const char *path;
  size_t length;
  if (call == NULL) return false;
  path = strstr(call, ",[\"");
  if (path == NULL) return false;
  path += strlen(",[\"");
  length = strcspn(path, "\"");
  if (length == 0U || length >= capacity) return false;
  memcpy(out, path, length);
  out[length] = '\0';
  return true;
}

static void enqueue_stream_get(const char *stream_path) {
  assert(pending_stream_path_count <
         sizeof(pending_stream_paths) / sizeof(pending_stream_paths[0]));
  (void)snprintf(pending_stream_paths[pending_stream_path_count],
      sizeof(pending_stream_paths[pending_stream_path_count]), "%s", stream_path);
  ++pending_stream_path_count;
}

static void remember_pending_stream_capability(long capability) {
  assert(pending_stream_path_count > 0U);
  remember_stream_capability(capability, pending_stream_paths[0]);
  memmove(&pending_stream_paths[0], &pending_stream_paths[1],
      (pending_stream_path_count - 1U) * sizeof(pending_stream_paths[0]));
  --pending_stream_path_count;
}

static void resolve_deferred_voice_setup(size_t index) {
  char reply[256];
  struct iterate_kit_itx_connection *connection =
      iterate_kit_fake_platform_connection();
  assert(index < deferred_voice_setup_count);
  assert(connection != NULL);
  (void)snprintf(
      reply,
      sizeof(reply),
      "[\"resolve\",%ld,{\"streamPath\":\"%s\",\"warmMs\":0}]",
      deferred_voice_setups[index].id,
      deferred_voice_setups[index].stream_path);
  deliver(connection, reply);
}

static void pump(void) {
  int round;
  char setup_stream_path[160] = "";
  char stream_get_path[160] = "";
  for (round = 0; round < 40; ++round) {
    struct iterate_kit_itx_connection *connection =
        iterate_kit_fake_platform_connection();
    bool answered_any = false;
    while (answered < iterate_kit_fake_platform_sent_count()) {
      const char *message = iterate_kit_fake_platform_sent(answered);
      const char *pull = strstr(message, "[\"pull\",");
      ++answered;
      if (strstr(message, "[\"subscribe\"]") != NULL) {
        const char *exported = strstr(message, "[\"export\",");
        long target;
        assert(exported != NULL);
        assert(copy_pipeline_target(message, &target));
        enqueue_open_connection(
            strtol(exported + strlen("[\"export\","), NULL, 10),
            stream_path_for_capability(target));
      }
      if (strncmp(message, "[\"release\",", sizeof("[\"release\",") - 1U) == 0) {
        const long released = strtol(message + sizeof("[\"release\",") - 1U, NULL, 10);
        for (size_t slot = 0U; slot < 8U; ++slot) {
          if (open_connections[slot].capability == released) {
            char release[64];
            (void)snprintf(release, sizeof(release), "[\"release\",%ld,1]", open_connections[slot].callback);
            deliver(connection, release);
            open_connections[slot].capability = 0L;
            open_connections[slot].callback = 0L;
            open_connections[slot].stream_path[0] = '\0';
          }
          if (stream_capabilities[slot].capability == released) {
            stream_capabilities[slot].capability = 0L;
            stream_capabilities[slot].stream_path[0] = '\0';
          }
        }
      }
      if (strstr(message, "setupVoiceAgent") != NULL) {
        assert(copy_setup_stream_path(
            message, setup_stream_path, sizeof(setup_stream_path)));
      }
      if (strstr(message, "[\"cd\"]") != NULL) {
        assert(copy_stream_get_path(
            message, stream_get_path, sizeof(stream_get_path)));
      }
      if (pull == NULL) continue;
      {
        char reply[256];
        const long id = strtol(pull + strlen("[\"pull\","), NULL, 10);
        if (setup_stream_path[0] != '\0') {
          if (defer_voice_setup) {
            assert(deferred_voice_setup_count <
                   sizeof(deferred_voice_setups) / sizeof(deferred_voice_setups[0]));
            deferred_voice_setups[deferred_voice_setup_count].id = id;
            (void)snprintf(
                deferred_voice_setups[deferred_voice_setup_count].stream_path,
                sizeof(deferred_voice_setups[deferred_voice_setup_count].stream_path),
                "%s", setup_stream_path);
            ++deferred_voice_setup_count;
            setup_stream_path[0] = '\0';
            continue;
          }
          (void)snprintf(
              reply,
              sizeof(reply),
              "[\"resolve\",%ld,{\"streamPath\":\"%s\",\"warmMs\":0}]",
              id,
              setup_stream_path);
          setup_stream_path[0] = '\0';
        } else {
          if (stream_get_path[0] != '\0' && defer_stream_get) {
            assert(deferred_stream_get_id == 0L);
            deferred_stream_get_id = id;
            stream_get_path[0] = '\0';
            answered_any = true;
            continue;
          }
          const long capability = -(id + 10);
          (void)snprintf(
              reply, sizeof(reply), "[\"resolve\",%ld,[\"export\",%ld]]", id, capability);
          if (stream_get_path[0] != '\0') {
            enqueue_stream_get(stream_get_path);
            stream_get_path[0] = '\0';
          }
          if (pending_stream_path_count > 0U) {
            remember_pending_stream_capability(capability);
          } else if (pending_open_connection_count > 0U) {
            remember_open_connection(capability);
          }
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

static size_t sent_after_count(size_t from, const char *needle) {
  size_t count = 0U;
  for (size_t index = from; index < iterate_kit_fake_platform_sent_count(); ++index) {
    if (strstr(iterate_kit_fake_platform_sent(index), needle) != NULL) ++count;
  }
  return count;
}

static size_t collect_setup_paths(
    size_t from, char paths[][160], size_t capacity) {
  size_t count = 0U;
  for (size_t index = from; index < iterate_kit_fake_platform_sent_count(); ++index) {
    const char *message = iterate_kit_fake_platform_sent(index);
    if (message == NULL || strstr(message, "setupVoiceAgent") == NULL) continue;
    assert(count < capacity);
    assert(copy_setup_stream_path(message, paths[count], sizeof(paths[count])));
    ++count;
  }
  return count;
}

static bool sent_microphone_to_stream(size_t from, const char *stream_path) {
  for (size_t index = from; index < iterate_kit_fake_platform_sent_count(); ++index) {
    long target;
    const char *message = iterate_kit_fake_platform_sent(index);
    const char *actual_path;
    if (message == NULL || strstr(message, "\"pcm\":\"") == NULL ||
        !copy_pipeline_target(message, &target)) continue;
    actual_path = stream_path_for_capability(target);
    if (actual_path != NULL && strcmp(actual_path, stream_path) == 0) return true;
  }
  return false;
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

/** The callback held by the currently open connection, never a closed one. */
static long latest_callback_export_id(void) {
  long latest = 0L;
  for (size_t slot = 0U; slot < 8U; ++slot) {
    if (open_connections[slot].callback < latest) latest = open_connections[slot].callback;
  }
  assert(latest != 0L);
  return latest;
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
      "[\"push\",[\"pipeline\",%ld,[],[[["
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\","
      "\"offset\":%ld,"
      "\"payload\":{\"activation\":\"%s\",\"conversationId\":\"convdial\",\"deviceSpeakerFrameSeq\":%ld,%s"
      "\"pcm\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}}"
      "]],{\"after\":%ld,\"through\":%ld}]]]",
      export_id, offset, current_activation(), offset,
      last ? "\"lastFrameOfAnswer\":true," : "", offset - 1, offset);
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
      "[\"push\",[\"pipeline\",%ld,[],[[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
      "\"offset\":%ld,"
      "\"payload\":{\"activation\":\"%s\",\"conversationId\":\"convdial\",\"handshakeTookMs\":2000}}"
      "]],{\"after\":%ld,\"through\":%ld}]]]",
      export_id, offset, current_activation(), offset - 1, offset);
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
      "[\"push\",[\"pipeline\",%ld,[],[[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-ended\","
      "\"offset\":%ld,"
      "\"payload\":{\"activation\":\"%s\",\"reason\":\"server-ended\"}}"
      "]],{\"after\":%ld,\"through\":%ld}]]]",
      export_id, offset, current_activation(), offset - 1, offset);
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
  assert(!iterate_kit_host_esp_idf_restart_requested());
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
  pump();
  speak_frames(1U);
  run_ms(50U);

  assert(board.last_view.wants_call);
  assert(strcmp(current_activation(), activation_a) != 0);
  assert(sent_after_contains(
      before, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\""));
  quiescent();
}

/* An accepted A may end and restart B before A's terminal leaves the outbox. */
static void accepted_call_end_then_start_creates_b_after_a_terminal(void) {
  char activation_a[65];
  size_t before;
  quiescent();
  before = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(50U);
  (void)snprintf(activation_a, sizeof(activation_a), "%s", current_activation());
  deliver_accepted_latest();
  step();

  remote_call("conversation", "end");
  remote_call("conversation", "start");
  step();
  pump();
  assert(board.last_view.wants_call);
  speak_frames(1U);
  run_ms(50U);
  assert(strcmp(current_activation(), activation_a) != 0);
  assert(sent_after_contains(
      before, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\""));
  assert(sent_after_contains(before, "\"pcm\":"));
  quiescent();
}

/* A terminal waits for control-outbox capacity instead of killing the session. */
static void terminal_waits_for_outbox_headroom(void) {
  size_t before;
  quiescent();
  before = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(50U);
  assert(sent_after_contains(before, "\"pcm\":"));

  remote_call("conversation", "end");
  board_poll_hook = fill_outbox_during_board_poll;
  step();
  assert(!sent_after_contains(
      before, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\""));

  iterate_kit_fake_platform_drain_control_outbox();
  step();
  assert(sent_after_contains(
      before, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\""));
  assert(!iterate_kit_host_esp_idf_restart_requested());
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

/* A setup reply belongs to the press that made it, even if a later press is
 * already opening when that old reply arrives. */
static void delayed_a_setup_cannot_cancel_or_mount_b(void) {
  char paths[2][160];
  size_t after_b_setup;
  quiescent();
  const size_t before = iterate_kit_fake_platform_sent_count();
  defer_voice_setup = true;
  remote_call("conversation", "start");
  step();
  pump();
  assert(deferred_voice_setup_count == 1U);

  remote_call("conversation", "end");
  step();
  remote_call("conversation", "start");
  step();
  defer_voice_setup = false;
  pump();
  assert(board.last_view.wants_call);
  assert(collect_setup_paths(before, paths, 2U) == 2U);
  assert(strcmp(paths[0], paths[1]) != 0);

  after_b_setup = iterate_kit_fake_platform_sent_count();
  resolve_deferred_voice_setup(0U);
  step();
  pump();
  speak_frames(1U);
  run_ms(100U);

  assert(board.last_view.wants_call);
  assert(strcmp(board.last_view.status, "voice setup failed") != 0);
  assert(sent_after_contains(before, "\"pcm\":"));
  assert(sent_microphone_to_stream(after_b_setup, paths[1]));
  assert(!sent_after_contains(after_b_setup, "[\"subscribe\"]"));
  deferred_voice_setup_count = 0U;
  quiescent();
}

/* A terminal that missed its old socket reopens that exact child after a
 * reconnect, then leaves the next press free to open its own child. */
static void queued_terminal_survives_session_loss_before_b(void) {
  size_t after_reconnect;
  quiescent();
  const size_t before = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(100U);

  remote_call("conversation", "end");
  board_poll_hook = fill_outbox_during_board_poll;
  step();
  assert(!sent_after_contains(
      before, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\""));

  iterate_kit_itx_connection_lost(iterate_kit_fake_platform_connection());
  iterate_kit_fake_platform_drain_control_outbox();
  next_inbound_call_id = 1;
  pending_open_connection_count = 0U;
  pending_stream_path_count = 0U;
  memset(open_connections, 0, sizeof(open_connections));
  memset(stream_capabilities, 0, sizeof(stream_capabilities));
  iterate_kit_fake_platform_connect();
  after_reconnect = iterate_kit_fake_platform_sent_count();
  pump();
  step();
  assert(sent_after_count(
      after_reconnect, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\"") == 1U);

  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(100U);
  assert(board.last_view.wants_call);
  assert(sent_after_contains(after_reconnect, "\"pcm\":"));
  quiescent();
}

/* A call cannot outlive the session under it: once the next session is up the loop
 * ends the call, its terminal rides that session, and the next press opens a NEW
 * child instead of streaming into the dead one (measured 2026-09-16: a deploy roll
 * cut the session mid-call and the board sat wanting the old call for 20 minutes). */
static void losing_the_session_ends_the_call_and_the_next_press_opens_a_new_one(void) {
  size_t after_reconnect;
  quiescent();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(100U);
  deliver_accepted_latest();
  step();
  assert(board.last_view.wants_call);

  iterate_kit_itx_connection_lost(iterate_kit_fake_platform_connection());
  iterate_kit_fake_platform_drain_control_outbox();
  next_inbound_call_id = 1;
  pending_open_connection_count = 0U;
  pending_stream_path_count = 0U;
  memset(open_connections, 0, sizeof(open_connections));
  memset(stream_capabilities, 0, sizeof(stream_capabilities));
  iterate_kit_fake_platform_connect();
  after_reconnect = iterate_kit_fake_platform_sent_count();
  pump();
  step();
  step(); /* the end lands in one pass; the board sees the view on the next */
  assert(!board.last_view.wants_call);
  assert(sent_after_count(
      after_reconnect, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\"") == 1U);
  assert(sent_after_contains(after_reconnect, "\"reason\":\"session-lost\""));

  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(100U);
  assert(board.last_view.wants_call);
  assert(sent_after_contains(after_reconnect, "\"pcm\":"));
  quiescent();
}

/* B may already have captured while A's terminal waits for outbox space, but
 * that PCM waits for B's own newly opened child rather than using A's stub. */
static void b_pcm_waits_for_its_own_child_after_a_terminal(void) {
  char paths[2][160];
  size_t before;
  size_t after_b_capture;
  size_t b_open;
  size_t b_microphone;

  quiescent();
  before = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(100U);

  remote_call("conversation", "end");
  remote_call("conversation", "start");
  board_poll_hook = fill_outbox_during_board_poll;
  step();
  speak_frames(2U);
  after_b_capture = iterate_kit_fake_platform_sent_count();
  run_ms(100U);
  assert(!sent_after_contains(after_b_capture, "\"pcm\":"));

  iterate_kit_fake_platform_drain_control_outbox();
  step();
  pump();
  run_ms(100U);
  b_open = first_sent_after_containing(after_b_capture, "[\"subscribe\"]");
  b_microphone = first_sent_after_containing(after_b_capture, "\"pcm\":");
  assert(sent_after_contains(
      after_b_capture, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\""));
  assert(b_open < iterate_kit_fake_platform_sent_count());
  assert(b_microphone < iterate_kit_fake_platform_sent_count());
  assert(b_open < b_microphone);
  assert(collect_setup_paths(before, paths, 2U) == 2U);
  assert(strcmp(paths[0], paths[1]) != 0);
  assert(sent_microphone_to_stream(after_b_capture, paths[1]));
  quiescent();
}

/* Reclaimable FAILED handles must be opened again for the next child path. */
static void rejected_stream_can_be_reused_by_an_immediate_new_activation(void) {
  char reply[160];
  char activation_a[65];
  quiescent();
  const size_t before = iterate_kit_fake_platform_sent_count();
  defer_stream_get = true;
  remote_call("conversation", "start");
  step();
  pump();
  assert(deferred_stream_get_id != 0L);
  (void)snprintf(activation_a, sizeof(activation_a), "%s", current_activation());
  (void)snprintf(reply, sizeof(reply),
      "[\"reject\",%ld,[\"error\",\"Error\",\"stream denied\"]]",
      deferred_stream_get_id);
  deliver(iterate_kit_fake_platform_connection(), reply);
  deferred_stream_get_id = 0L;
  defer_stream_get = false;

  /* Reuse FAILED storage before idle housekeeping has closed it. */
  remote_call("conversation", "end");
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(50U);
  assert(board.last_view.wants_call);
  assert(strcmp(activation_a, current_activation()) != 0);
  assert(sent_after_count(before, "[\"cd\"]") == 2U);
  assert(sent_after_contains(before, "\"pcm\":"));
  quiescent();
}

/*
 * Wake detection reaches the app after audio has already crossed the codec.
 * The first, middle and following frames must therefore survive the mount
 * and reach the stream in chronological order, even though no call was ready
 * while they were captured.
 */
static void pre_mount_speech_is_preserved_and_sent_immediately(void) {
  uint8_t pcm[6U * ITERATE_KIT_VOICE_FRAME_BYTES];
  quiescent();
  const size_t before = iterate_kit_fake_platform_sent_count();
  capture_frame_value = 1000;

  remote_call("conversation", "start");
  step();
  speak_frames(1U); /* prefix */
  speak_frames(4U); /* middle */
  speak_frames(1U); /* following frame */
  run_ms(3000U); /* Backend setup can take seconds; opening words remain queued. */

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
  pump();
  speak_frames(1U);
  run_ms(50U);
  assert(strcmp(current_activation(), activation_a) != 0);
}

/* A ends after uploading PCM but before acceptance; its terminal still reaches
 * its own stream before B uploads to the new child. */
static void ending_before_acceptance_terminates_a_before_b(void) {
  size_t terminal;
  size_t microphone;
  quiescent();
  const size_t before = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  step();
  pump();
  speak_frames(1U);
  run_ms(50U);
  assert(sent_after_contains(before, "\"pcm\":"));
  remote_call("conversation", "end");
  step();

  const size_t after_end = iterate_kit_fake_platform_sent_count();
  remote_call("conversation", "start");
  step();
  speak_frames(1U);
  pump();
  run_ms(50U);

  terminal = first_sent_after_containing(
      before, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\"");
  microphone = first_sent_after_containing(after_end, "\"pcm\":");
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
  defer_voice_setup = true;
  pump();
  assert(deferred_voice_setup_count == 1U);
  defer_voice_setup = false;
  resolve_deferred_voice_setup(0U);
  deferred_voice_setup_count = 0U;
  pump();
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
  pump();
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
  assert(!sent_after_contains(after_answer, "[\"subscribe\"]"));
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
  pump();
  speak_frames(10U);
  run_ms(200U);
  step();
  deliver_accepted_latest();
  run_ms(2000U);
  assert(sent_after_contains(after_accept, "mic-frame"));
  deliver_spk_chunk(false);
  after_chunk = iterate_kit_fake_platform_sent_count();
  run_ms(ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS + 2000U);
  assert(sent_after_contains(after_chunk, "[\"subscribe\"]"));
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
  assert(sent_after_contains(
      before, "\"type\":\"events.iterate.com/voice-agent/conversation-ended\""));
  assert(sent_after_contains(before, "opening-timeout"));
}

/*
 * AN IDLE BOARD KEEPS ITS OWN SOCKET, AND THIS IS THE ONE THING THAT DOES IT.
 *
 * Between calls this device sends no application message at all, which is the
 * only kind os-next's idle close counts (voice_device_profile.h), so the period
 * has to be reached from the loop's own clock while NOTHING else is happening.
 *
 * PINNED BECAUSE THE FIRST ATTEMPT GOT IT WRONG. The probe was first put beside
 * the call keepalive, inside a block that runs only while a voice_stream is bound
 * and ready — that is, only while the socket was busy anyway. It would have
 * passed every conversation test and kept exactly the connections that did not
 * need keeping.
 */
static void an_idle_session_probes_the_root_once_a_period(void) {
  size_t before;
  quiescent();
  before = iterate_kit_fake_platform_sent_count();
  assert(!sent_after_contains(before, "[\"whoami\"]"));

  run_ms(ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS + 500U);
  assert(sent_after_contains(before, "[\"whoami\"]"));
  /* One probe, not one a tick: an unanswered probe must not become a storm. */
  assert(sent_after_count(before, "[\"whoami\"]") == 1U);
  /* Answer it, so the next scenario starts with an empty pending-call table. */
  pump();
}

/*
 * AND AN ANSWERED PROBE IS LIVENESS, WHICH A PONG-ONLY WATCHDOG MISSED.
 *
 * The 420 s liveness watchdog restarts the chip when a READY transport shows no
 * answered round trip. The transport originates its PING only after inbound
 * SILENCE, and a probe answer on the same period is inbound — so a healthy
 * mounted board suppressed the very PINGs the watchdog was counting and rebooted
 * itself on a good network. This fake reports zero PONGs forever, which is
 * exactly that board: eight answered periods, well past the restart bound.
 */
static void answered_probes_are_liveness_without_any_pong(void) {
  size_t before;
  unsigned period;
  quiescent();
  before = iterate_kit_fake_platform_sent_count();
  for (period = 0U; period < 8U; ++period) {
    run_ms(ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS + 500U);
    pump();
  }
  assert(sent_after_count(before, "[\"whoami\"]") >= 7U);
  assert(!iterate_kit_host_esp_idf_restart_requested());
}

int main(void) {
  boot();
  pump();
  assert(board.last_view.api_ready);
  assert(board.last_view.screen == ITERATE_KIT_VOICE_SCREEN_IDLE);
  assert(!board.last_view.wants_call);
  conversation_start_raises_wants_call_with_no_button();
  conversation_control_opens_and_ends_a_call();
  nothing_physical_was_involved();
  an_idle_session_probes_the_root_once_a_period();
  answered_probes_are_liveness_without_any_pong();

  pre_mount_speech_is_preserved_and_sent_immediately();
  rejected_stream_can_be_reused_by_an_immediate_new_activation();
  same_pass_end_then_start_creates_a_new_activation();
  accepted_call_end_then_start_creates_b_after_a_terminal();
  terminal_waits_for_outbox_headroom();
  muted_remote_start_does_not_open_capture();

  ending_a_never_sends_its_tail_as_b();
  ending_before_acceptance_terminates_a_before_b();
  server_end_discards_a_tail_before_b();
  pump();
  an_idle_accepted_call_is_not_recycled_for_silence();
  a_lane_silent_mid_answer_is_recycled();
  activation_during_codec_read_keeps_idle_pre_roll();
  an_unaccepted_activation_times_out_once();
  delayed_a_setup_cannot_cancel_or_mount_b();
  /* Every activation above used the same authenticated WebSocket session. */
  assert(sent_after_count(0U, "\"authenticate\"") == 1U);
  assert(iterate_kit_fake_platform_connection()->generation == 1U);
  queued_terminal_survives_session_loss_before_b();
  losing_the_session_ends_the_call_and_the_next_press_opens_a_new_one();
  b_pcm_waits_for_its_own_child_after_a_terminal();
  failed_microphone_append_ends_the_activation();
  return 0;
}
