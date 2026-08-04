/*
 * The device's own tools, mounted as a live capability at kit.waveshare so
 * an agent or `pnpm cli itx run` can drive the screen, the call, and see
 * what the screen looks like:
 *
 *   await itx.kit.waveshare.setBackground("#1e293b")   // or "navy"
 *   await itx.kit.waveshare.conversation.start()
 *   await itx.kit.waveshare.pushToTalk.start()   // hold
 *   await itx.kit.waveshare.pushToTalk.stop()    // release: commits the turn
 *   await itx.kit.waveshare.conversation.hangUp()
 *   const meta = await itx.kit.waveshare.takeScreenshot()
 *   const part = await itx.kit.waveshare.readScreenshotChunk(0)  // Uint8Array
 *
 * Same shape as the Stick's screen capability (components/capabilities), but
 * this board has a full colour panel, so the tool takes a hex colour rather
 * than the Stick's red/green pair.
 *
 * The screenshot is pulled rather than pushed: one capture into PSRAM, then
 * the caller reads it out in chunks that each fit a control message. That
 * keeps a 80 KiB image inside a peer whose replies are bounded, and means
 * anyone holding the capability can see the screen with ordinary calls.
 */
#include "waveshare_tools.h"

#include <stdio.h>
#include <string.h>

#include "capnweb/capnweb.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "waveshare_audio.h"
#include "waveshare_avatar.h"
#include "waveshare_image.h"

static const char tag[] = "waveshare-tools";
#include "waveshare_audio.h"
#include "waveshare_display.h"
#include "waveshare_recorder.h"

static const char *const set_background_path[] = {"setBackground"};
static const char *const set_face_path[] = {"setFace"};
static const char *const list_faces_path[] = {"listFaces"};
/* Same vocabulary as the M5StickS3's capability, so one agent drives both. */
static const char *const start_call_path[] = {"conversation", "start"};
static const char *const hang_up_path[] = {"conversation", "hangUp"};
static const char *const talk_start_path[] = {"pushToTalk", "start"};
static const char *const talk_stop_path[] = {"pushToTalk", "stop"};
static const char *const take_screenshot_path[] = {"takeScreenshot"};
static const char *const health_path[] = {"health"};
static const char *const restart_path[] = {"restart"};
static const char *const set_volume_path[] = {"setVolume"};
static const char *const set_mic_gain_path[] = {"setMicGain"};
static const char *const recording_status_path[] = {"recording", "status"};
static const char *const recording_size_path[] = {"recording", "size"};
static const char *const recording_read_path[] = {"recording", "read"};
static const char *const read_screenshot_chunk_path[] = {"readScreenshotChunk"};
static const char *const show_image_path[] = {"showImage"};
#ifdef ITERATE_KIT_DIAGNOSTIC_STARVATION
static const char *const inject_starvation_path[] = {"injectStarvation"};
#endif

enum {
  /*
   * One chunk plus its ["bytes","..."] envelope has to fit a single control
   * message: 2400 raw bytes is 3200 base64 characters.
   */
  /*
   * 6000 raw bytes = 8000 base64 characters, which still fits one 8 KiB
   * control message. At 2400 a screenshot cost 35 round trips and dominated
   * every test that took one; at 6000 it is 14.
   */
  SCREENSHOT_CHUNK_BYTES = 6000,
  SCREENSHOT_CHUNKS =
      (WAVESHARE_SNAPSHOT_BYTES + SCREENSHOT_CHUNK_BYTES - 1) /
      SCREENSHOT_CHUNK_BYTES,
};

EXT_RAM_BSS_ATTR static uint8_t screenshot_pixels[WAVESHARE_SNAPSHOT_BYTES];
/* PSRAM, for the same reason as the recorder's read buffer. */
EXT_RAM_BSS_ATTR static uint8_t recording_chunk[SCREENSHOT_CHUNK_BYTES];
static char recording_name[32];
static bool screenshot_valid;
static char screenshot_meta[192];

struct named_colour {
  const char *name;
  uint32_t rgb;
};

/* A few names so the tool is pleasant to call by hand. */
static const struct named_colour named_colours[] = {
  {"black", 0x000000}, {"white", 0xf8fafc}, {"iterate", 0x101820},
  {"red", 0xdc2626},   {"green", 0x16a34a}, {"blue", 0x2563eb},
  {"navy", 0x0f172a},  {"purple", 0x7c3aed}, {"orange", 0xea580c},
  {"pink", 0xdb2777},  {"teal", 0x0d9488},  {"yellow", 0xca8a04},
};

static bool parse_hex_digit(char character, uint32_t *value) {
  if (character >= '0' && character <= '9') {
    *value = (uint32_t)(character - '0');
  } else if (character >= 'a' && character <= 'f') {
    *value = (uint32_t)(character - 'a' + 10);
  } else if (character >= 'A' && character <= 'F') {
    *value = (uint32_t)(character - 'A' + 10);
  } else {
    return false;
  }
  return true;
}

/** "#rrggbb", "rrggbb", "#rgb", or one of the names above. */
static bool parse_colour(const char *text, size_t length, uint32_t *rgb) {
  size_t index;
  uint32_t value = 0U;
  for (index = 0U; index < sizeof(named_colours) / sizeof(named_colours[0]);
       ++index) {
    const size_t name_length = strlen(named_colours[index].name);
    if (name_length == length &&
        strncmp(text, named_colours[index].name, length) == 0) {
      *rgb = named_colours[index].rgb;
      return true;
    }
  }
  if (length > 0U && text[0] == '#') {
    ++text;
    --length;
  }
  if (length == 3U) {
    /* #abc expands to #aabbcc, as in CSS. */
    for (index = 0U; index < 3U; ++index) {
      uint32_t nibble;
      if (!parse_hex_digit(text[index], &nibble)) return false;
      value = (value << 8) | (nibble << 4) | nibble;
    }
    *rgb = value;
    return true;
  }
  if (length != 6U) return false;
  for (index = 0U; index < 6U; ++index) {
    uint32_t nibble;
    if (!parse_hex_digit(text[index], &nibble)) return false;
    value = (value << 4) | nibble;
  }
  *rgb = value;
  return true;
}

static enum capnweb_status set_background(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value value = {0};
  char text[32];
  size_t length = 0U;
  uint32_t rgb = 0U;
  (void)context;
  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      capnweb_value_copy_string(&value, text, sizeof(text), &length) !=
          CAPNWEB_OK) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected a colour string, e.g. \"#1e293b\"");
  }
  if (!parse_colour(text, length, &rgb)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "unrecognised colour");
  }
  waveshare_display_set_background(rgb);
  return capnweb_reply_set_boolean(reply, true);
}

/*
 * Which faces this build carries, as a JSON array of slugs.
 *
 * Listed rather than documented, because the answer is whatever was compiled in
 * — a caller that trusted a hard-coded list would go wrong the first time an
 * atlas was added or dropped, and the failure would look like setFace refusing a
 * name that "should" work.
 */
static enum capnweb_status list_faces(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  static char faces[256];
  size_t used = 0U;
  size_t index;
  (void)context;
  (void)call;

  /*
   * DOUBLE-WRAPPED, because Cap'n Web reserves the bare top-level array.
   *
   * `["a","b"]` on the wire is an escape form whose first element names a
   * special type, so a plain array of slugs came back as
   * `unknown special value: ["dot-matrix-oracle",...]`. An array literal is
   * written as an array containing it — the same rule the protocol applies to
   * every nested array, and the reason this is not simply JSON.
   */
  faces[used++] = '[';
  faces[used++] = '[';
  for (index = 0U; index < waveshare_avatar_count(); ++index) {
    const int written = snprintf(
        faces + used,
        sizeof(faces) - used,
        "%s\"%s\"",
        index == 0U ? "" : ",",
        waveshare_avatar_slug_at(index));
    if (written <= 0 || (size_t)written >= sizeof(faces) - used) {
      return capnweb_reply_set_error(reply, "Error", "face list overflow");
    }
    used += (size_t)written;
  }
  if (used + 3U >= sizeof(faces)) {
    return capnweb_reply_set_error(reply, "Error", "face list overflow");
  }
  faces[used++] = ']';
  faces[used++] = ']';
  faces[used] = '\0';
  return capnweb_reply_set_borrowed_expression(
      reply, faces, used, NULL, NULL);
}

/*
 * Show a different face, by the exact slug listFaces returns.
 *
 * Refused rather than approximated for an unknown name, and the refusal SAYS
 * WHICH names exist — an agent that mistypes a slug has to be able to fix it
 * from the error, not from a document.
 */
static enum capnweb_status set_face(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value value = {0};
  char slug[48];
  size_t length = 0U;
  (void)context;

  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      capnweb_value_copy_string(&value, slug, sizeof(slug), &length) !=
          CAPNWEB_OK) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected a face slug; call listFaces() for them");
  }
  if (!waveshare_avatar_request_slug(slug)) {
    return capnweb_reply_set_error(
        reply, "Error", "no such face; call listFaces() for the exact slugs");
  }
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status start_call(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  waveshare_display_request_call(true);
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status hang_up(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  waveshare_display_hold_talk(false);
  waveshare_display_request_call(false);
  return capnweb_reply_set_boolean(reply, true);
}

/*
 * Push-to-talk over RPC lands on the same held flag the PWR button and the
 * on-screen button set, so a remote turn is indistinguishable from a local
 * one — which is what makes the device testable without hands.
 */
static enum capnweb_status talk_start(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  waveshare_display_hold_talk(true);
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status talk_stop(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  waveshare_display_hold_talk(false);
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status take_screenshot(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  int length;
  (void)context;
  (void)call;
  if (!waveshare_display_snapshot(
          screenshot_pixels, sizeof(screenshot_pixels))) {
    screenshot_valid = false;
    return capnweb_reply_set_error(
        reply, "Error", "screen capture unavailable");
  }
  screenshot_valid = true;
  length = snprintf(
      screenshot_meta,
      sizeof(screenshot_meta),
      "{\"width\":%d,\"height\":%d,\"format\":\"rgb565le\","
      "\"bytes\":%d,\"chunkSize\":%d,\"chunks\":%d}",
      (int)WAVESHARE_SNAPSHOT_WIDTH,
      (int)WAVESHARE_SNAPSHOT_HEIGHT,
      (int)WAVESHARE_SNAPSHOT_BYTES,
      (int)SCREENSHOT_CHUNK_BYTES,
      (int)SCREENSHOT_CHUNKS);
  if (length < 0 || (size_t)length >= sizeof(screenshot_meta)) {
    return capnweb_reply_set_error(reply, "Error", "metadata overflow");
  }
  return capnweb_reply_set_borrowed_expression(
      reply, screenshot_meta, (size_t)length, NULL, NULL);
}

static enum capnweb_status read_screenshot_chunk(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value value = {0};
  int64_t index = -1;
  size_t offset;
  size_t length;
  (void)context;
  if (!screenshot_valid) {
    return capnweb_reply_set_error(
        reply, "Error", "call takeScreenshot() first");
  }
  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      !capnweb_value_get_int64(&value, &index) || index < 0 ||
      index >= (int64_t)SCREENSHOT_CHUNKS) {
    return capnweb_reply_set_error(
        reply, "RangeError", "chunk index out of range");
  }
  offset = (size_t)index * (size_t)SCREENSHOT_CHUNK_BYTES;
  length = sizeof(screenshot_pixels) - offset;
  if (length > (size_t)SCREENSHOT_CHUNK_BYTES) {
    length = (size_t)SCREENSHOT_CHUNK_BYTES;
  }
  return capnweb_reply_set_bytes(
      reply, &screenshot_pixels[offset], length, NULL, NULL);
}

/*
 * Recordings come off the device the same way screenshots do: ask for the
 * size, then read chunks that each fit one control message. No second
 * transport, and nobody has to take the card out.
 */
static enum capnweb_status set_volume(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value value = {0};
  int64_t percent = -1;
  (void)context;
  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      !capnweb_value_get_int64(&value, &percent) || percent < 0 ||
      percent > 100) {
    return capnweb_reply_set_error(reply, "RangeError", "expected 0-100");
  }
  waveshare_audio_set_volume((int)percent);
  return capnweb_reply_set_int64(reply, percent);
}

static enum capnweb_status set_mic_gain(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value value = {0};
  int64_t db = -1;
  (void)context;
  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      !capnweb_value_get_int64(&value, &db) || db < 0 || db > 48) {
    return capnweb_reply_set_error(reply, "RangeError", "expected 0-48 dB");
  }
  waveshare_audio_set_mic_gain((float)db);
  return capnweb_reply_set_int64(reply, db);
}

static enum capnweb_status recording_status(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  static char status_text[288];
  size_t mic_bytes = 0U;
  size_t speaker_bytes = 0U;
  size_t log_bytes = 0U;
  int length;
  (void)context;
  (void)call;
  waveshare_recorder_counters(&mic_bytes, &speaker_bytes, &log_bytes);
  length = snprintf(
      status_text,
      sizeof(status_text),
      "{\"card\":%s,\"recording\":%s,\"begins\":%u,\"ends\":%u,"
      "\"written\":{\"mic\":%u,"
      "\"speaker\":%u,\"log\":%u},\"onDisk\":{\"mic\":%u,"
      "\"speaker\":%u,\"log\":%u}}",
      waveshare_recorder_available() ? "true" : "false",
      waveshare_recorder_recording() ? "true" : "false",
      /* One begin per call is healthy; hundreds is the storm this had. */
      (unsigned int)waveshare_recorder_begins(),
      (unsigned int)waveshare_recorder_ends(),
      (unsigned int)mic_bytes,
      (unsigned int)speaker_bytes,
      (unsigned int)log_bytes,
      (unsigned int)waveshare_recorder_size("mic.pcm"),
      (unsigned int)waveshare_recorder_size("speaker.pcm"),
      (unsigned int)waveshare_recorder_size("call.log"));
  if (length < 0 || (size_t)length >= sizeof(status_text)) {
    return capnweb_reply_set_error(reply, "Error", "status overflow");
  }
  return capnweb_reply_set_borrowed_expression(
      reply, status_text, (size_t)length, NULL, NULL);
}

static enum capnweb_status recording_size(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value value = {0};
  size_t length = 0U;
  (void)context;
  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      capnweb_value_copy_string(
          &value, recording_name, sizeof(recording_name), &length) !=
          CAPNWEB_OK) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected a file name, e.g. \"mic.pcm\"");
  }
  /*
   * An unknown name is a caller mistake, not an empty file. Returning 0 for
   * both meant "nope.txt" and a freshly truncated mic.pcm were indistinguishable,
   * so a typo read as "the recording is empty" forever.
   */
  if (!waveshare_recorder_known_name(recording_name)) {
    return capnweb_reply_set_error(
        reply, "RangeError",
        "unknown recording: expected \"mic.pcm\", \"speaker.pcm\" or \"call.log\"");
  }
  return capnweb_reply_set_int64(
      reply, (int64_t)waveshare_recorder_size(recording_name));
}

static enum capnweb_status recording_read(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value name_value = {0};
  struct capnweb_value offset_value = {0};
  int64_t offset = -1;
  size_t name_length = 0U;
  size_t read_bytes;
  (void)context;
  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &name_value) ||
      capnweb_value_copy_string(
          &name_value, recording_name, sizeof(recording_name), &name_length) !=
          CAPNWEB_OK ||
      !capnweb_value_array_at(&call->arguments, 1U, &offset_value) ||
      !capnweb_value_get_int64(&offset_value, &offset) || offset < 0) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected (name, byteOffset)");
  }
  /* Same reasoning as recording.size: a typo must not read as an empty file. */
  if (!waveshare_recorder_known_name(recording_name)) {
    return capnweb_reply_set_error(
        reply, "RangeError",
        "unknown recording: expected \"mic.pcm\", \"speaker.pcm\" or \"call.log\"");
  }
  read_bytes = waveshare_recorder_read(
      recording_name, (size_t)offset, recording_chunk,
      sizeof(recording_chunk));
  return capnweb_reply_set_bytes(reply, recording_chunk, read_bytes, NULL, NULL);
}

/*
 * The one call that works when nothing else does.
 *
 * dev-stats is appended only from inside the "everything is READY" gate, so
 * the exact state worth diagnosing — connected enough to answer RPCs, wedged
 * enough to do nothing else — is the state that appends no telemetry at all.
 * A device that can be asked how it is does not need a serial cable, and on
 * this board attaching one reboots the evidence away.
 */
static enum capnweb_status health(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  /*
   * The same object dev-stats carries, so it is sized like the stats line
   * and not like a guess — a health call that overflows is a health call
   * that is useless exactly when it is needed.
   *
   * Which duly happened: two counters were added and the whole thing started
   * returning "health overflow", so the device went dark at the moment its
   * telemetry was being extended. Sized with real headroom now, because the
   * cost of a spare kilobyte is nothing against the cost of a diagnostic
   * that fails when somebody adds a field to it.
   */
  static char health_text[2560];
  size_t length;
  (void)context;
  (void)call;
  length = waveshare_health_json(health_text, sizeof(health_text));
  if (length == 0U) {
    return capnweb_reply_set_error(reply, "Error", "health overflow");
  }
  return capnweb_reply_set_borrowed_expression(reply, health_text, length, NULL, NULL);
}

/*
 * A power cycle anyone can ask for. Every remedy this device has for a wedged
 * state ends in a reboot, and until now the only way to get one was to be in
 * the room — which meant "restart it and try again" could not be part of any
 * test, and the very failures worth measuring are the ones that need it.
 */
static enum capnweb_status restart(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  waveshare_request_restart();
  return capnweb_reply_set_boolean(reply, true);
}


#ifdef ITERATE_KIT_DIAGNOSTIC_STARVATION
/**
 * Make the speaker starve on purpose, once, mid-answer.
 *
 * COMPILE-TIME GATED, and deliberately absent from production firmware: a tool
 * whose whole job is to break the audio has no business being callable on a
 * device someone is talking to. Built only with
 * -DITERATE_KIT_DIAGNOSTIC_STARVATION, for the run that proves the underrun
 * detector still fires.
 *
 * Exists so the DMA underrun detector can be SHOWN to work rather than asserted
 * to. Bounded to a range that produces a real gap without wedging anything, and
 * it does nothing unless an answer is actually playing when the speaker task
 * next asks for a frame.
 */
static enum capnweb_status inject_starvation(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value value = {0};
  int64_t ms = -1;
  (void)context;
  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      !capnweb_value_get_int64(&value, &ms) || ms < 20 || ms > 2000) {
    return capnweb_reply_set_error(reply, "RangeError", "expected 20-2000 ms");
  }
  waveshare_audio_inject_starvation((uint32_t)ms);
  return capnweb_reply_set_int64(reply, ms);
}
#endif /* ITERATE_KIT_DIAGNOSTIC_STARVATION */

/* --- showImage ------------------------------------------------------------ */

/*
 * A PICTURE ON THE SCREEN FOR A WHILE, FETCHED FROM A URL.
 *
 * The fetch is the awkward part. It is bounded (see waveshare_image.h) but the
 * bound is seconds, and the RPC arrives on the task that also carries audio —
 * blocking it for a TLS handshake and a decode would starve the speaker. So the
 * call is DEFERRED: a worker task does the slow part and the reply is resolved
 * from poll() once it finishes. The caller therefore learns the real outcome —
 * a 404, a decode failure, a timeout — rather than an "accepted" that hides it.
 *
 *   await itx.kit.waveshare.showImage("https://…/cat.jpg", 10)
 */
enum {
  /*
   * Matches waveshare_image.c's own URL bound. Copied rather than shared
   * because the fetch re-validates anyway, and a caller sending something
   * longer should be refused here, before a task is woken for it.
   */
  IMAGE_URL_CAPACITY = 1024,
  /* How often the worker looks for a picture whose time is up. */
  IMAGE_HOUSEKEEPING_MS = 200,
  /*
   * Longest the worker waits for the panel to stop drawing from a bitmap it is
   * about to free. The display takes it down on its next refresh, so this is
   * many refreshes' worth; it exists so a wedged LVGL task cannot turn a free
   * into an unbounded wait.
   */
  IMAGE_TAKEDOWN_WAIT_MS = 1000,
  IMAGE_WORKER_STACK_BYTES = 6144,
  /* Below the audio tasks: a picture must never delay a spoken word. */
  IMAGE_WORKER_PRIORITY = 3,
  /*
   * Longest a caller may be left waiting for its answer. The worker's own
   * deadline is shorter, so reaching this means the worker itself is wedged —
   * and a caller that waits forever on a device is worse than a clear failure.
   */
  IMAGE_REPLY_DEADLINE_MS = 40000,
};

struct image_request {
  char url[IMAGE_URL_CAPACITY];
  uint32_t seconds;
};

static struct {
  /* Depth one, both: a second request in flight is refused, not queued. */
  QueueHandle_t requests;
  QueueHandle_t results;
  /*
   * Touched only from the owner task — the dispatch that stores it and the
   * poll that resolves it both run there — so it needs no lock.
   */
  struct capnweb_responder responder;
  bool responder_active;
  uint64_t deferred_at_ms;
  bool worker_running;
} image_tool;

/** Free a held bitmap once the panel has genuinely stopped drawing from it. */
static bool release_when_idle(void) {
  const TickType_t deadline =
      xTaskGetTickCount() + pdMS_TO_TICKS(IMAGE_TAKEDOWN_WAIT_MS);

  waveshare_display_hide_image();
  while (waveshare_display_image_active()) {
    if (xTaskGetTickCount() >= deadline) {
      /*
       * Refusing to free is the safe half of this choice: the bitmap leaks one
       * slot until the display lets go, whereas freeing it now would hand the
       * panel a dangling pointer.
       */
      ESP_LOGE(tag, "display still holds the image; not freeing it");
      return false;
    }
    vTaskDelay(1);
  }
  waveshare_image_release();
  return true;
}

static void image_worker(void *argument) {
  struct image_request request;
  bool holding = false;
  (void)argument;

  for (;;) {
    struct waveshare_image_bitmap bitmap = {0};
    enum waveshare_image_status status;

    if (xQueueReceive(
            image_tool.requests, &request,
            pdMS_TO_TICKS(IMAGE_HOUSEKEEPING_MS)) != pdTRUE) {
      /* Nothing asked for: give back the memory of a picture that has expired. */
      if (holding && !waveshare_display_image_active()) {
        waveshare_image_release();
        holding = false;
      }
      continue;
    }
    /*
     * Latest wins. The previous picture comes down first because the fetch
     * holds a single slot, so the new one cannot even be decoded until the old
     * one is freed.
     */
    if (holding) {
      if (!release_when_idle()) {
        status = WAVESHARE_IMAGE_BUSY;
        (void)xQueueOverwrite(image_tool.results, &status);
        continue;
      }
      holding = false;
    }
    status = waveshare_image_fetch(request.url, &bitmap);
    if (status == WAVESHARE_IMAGE_OK) {
      if (waveshare_display_show_image(&bitmap, request.seconds)) {
        holding = true;
      } else {
        /* The display refused it, so nothing will ever take it down. */
        waveshare_image_release();
        status = WAVESHARE_IMAGE_TOO_LARGE;
      }
    }
    ESP_LOGI(
        tag, "showImage %s -> %s", request.url,
        waveshare_image_status_name(status));
    (void)xQueueOverwrite(image_tool.results, &status);
  }
}

bool waveshare_tools_start_image_worker(void) {
  if (image_tool.worker_running) {
    return true;
  }
  image_tool.requests = xQueueCreate(1U, sizeof(struct image_request));
  image_tool.results = xQueueCreate(1U, sizeof(enum waveshare_image_status));
  if (image_tool.requests == NULL || image_tool.results == NULL) {
    ESP_LOGE(tag, "image queues unavailable");
    return false;
  }
  if (xTaskCreate(
          image_worker, "image", IMAGE_WORKER_STACK_BYTES, NULL,
          IMAGE_WORKER_PRIORITY, NULL) != pdPASS) {
    ESP_LOGE(tag, "image worker unavailable");
    return false;
  }
  image_tool.worker_running = true;
  return true;
}

static enum capnweb_status show_image(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value url_value = {0};
  struct capnweb_value seconds_value = {0};
  struct image_request request;
  enum capnweb_status status;
  int64_t seconds = 0;
  size_t url_length = 0U;
  (void)context;

  if (!image_tool.worker_running) {
    return capnweb_reply_set_error(reply, "Error", "image worker unavailable");
  }
  if (call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &url_value) ||
      capnweb_value_copy_string(
          &url_value, request.url, sizeof(request.url), &url_length) !=
          CAPNWEB_OK ||
      url_length == 0U) {
    return capnweb_reply_set_error(
        reply, "TypeError",
        "expected (url, seconds); url must be http(s) and under 1024 bytes");
  }
  if (!capnweb_value_array_at(&call->arguments, 1U, &seconds_value) ||
      !capnweb_value_get_int64(&seconds_value, &seconds) || seconds <= 0 ||
      seconds > (int64_t)WAVESHARE_IMAGE_SECONDS_MAX) {
    /* Refused rather than clamped: a silently shortened display is a lie. */
    return capnweb_reply_set_error(
        reply, "RangeError", "seconds must be 1-30");
  }
  request.seconds = (uint32_t)seconds;
  /*
   * One at a time, and said so. Queueing a second request would make the
   * caller wait an unbounded time behind a fetch it cannot see.
   */
  if (image_tool.responder_active ||
      xQueueSend(image_tool.requests, &request, 0) != pdTRUE) {
    return capnweb_reply_set_error(
        reply, "Error", "an image request is already in flight");
  }
  status = capnweb_reply_defer(reply);
  if (status == CAPNWEB_OK) {
    image_tool.responder = call->responder;
    image_tool.responder_active = true;
    image_tool.deferred_at_ms = 0U; /* stamped by the first poll that sees it */
  }
  /*
   * If deferral fails the worker still runs and still frees what it fetched;
   * only the answer is lost. Better than refusing work that is already queued.
   */
  return status;
}

/**
 * The failure, in words a caller can act on.
 *
 * "unsupported-format" alone sends people hunting for a network fault. The
 * decoder is the ESP32-S3 mask ROM's TJpgDec, which does BASELINE JPEG and
 * nothing else, so the two things a person will actually hand this tool — a
 * PNG, or a progressive JPEG from an image CDN — both land here and both
 * deserve to be told why.
 */
static const char *image_error_message(enum waveshare_image_status status) {
  if (status == WAVESHARE_IMAGE_UNSUPPORTED) {
    return "unsupported-format: this device decodes BASELINE JPEG only. "
           "PNG is refused, and so is progressive JPEG (SOF2), which is what "
           "many image CDNs serve by default. Re-encode as baseline JPEG.";
  }
  return waveshare_image_status_name(status);
}

/** Resolve a deferred showImage once the worker has an answer. */
static struct iterate_kit_poll_result image_poll(void *context, uint64_t now_ms) {
  struct iterate_kit_poll_result result = {ITERATE_KIT_POLL_OK, CAPNWEB_OK};
  enum waveshare_image_status status;
  (void)context;
  (void)now_ms;

  if (image_tool.responder_active && image_tool.deferred_at_ms == 0U) {
    image_tool.deferred_at_ms = now_ms;
  }
  if (image_tool.results == NULL ||
      xQueueReceive(image_tool.results, &status, 0) != pdTRUE) {
    /* No answer yet. Fail an answer that is never coming rather than wait. */
    if (image_tool.responder_active &&
        now_ms - image_tool.deferred_at_ms > (uint64_t)IMAGE_REPLY_DEADLINE_MS) {
      image_tool.responder_active = false;
      result.capnweb_status = capnweb_responder_set_error(
          image_tool.responder, "Error", "image worker did not answer");
      if (result.capnweb_status != CAPNWEB_OK) {
        result.status = ITERATE_KIT_POLL_CAPNWEB_ERROR;
      }
    }
    return result;
  }
  if (!image_tool.responder_active) {
    return result; /* Nobody is waiting: the session went away mid-fetch. */
  }
  image_tool.responder_active = false;
  result.capnweb_status = status == WAVESHARE_IMAGE_OK
      ? capnweb_responder_set_boolean(image_tool.responder, true)
      : capnweb_responder_set_error(
            image_tool.responder, "Error", image_error_message(status));
  if (result.capnweb_status != CAPNWEB_OK) {
    result.status = ITERATE_KIT_POLL_CAPNWEB_ERROR;
  }
  return result;
}

/**
 * The session that asked for a picture has gone.
 *
 * The responder belongs to that session, so resolving it later would be a
 * write through a dangling handle. The worker is left alone deliberately: it
 * still frees whatever it fetched, and a picture already on screen still comes
 * down on its own clock.
 */
static void image_session_ended(void *context) {
  (void)context;
  image_tool.responder_active = false;
}

struct iterate_kit_module waveshare_tools_module(void) {
  static const struct iterate_kit_method methods[] = {
    {health_path, 1U, health},
    {restart_path, 1U, restart},
    {set_background_path, 1U, set_background},
    {set_face_path, 1U, set_face},
    {list_faces_path, 1U, list_faces},
    {start_call_path, 2U, start_call},
    {hang_up_path, 2U, hang_up},
    {talk_start_path, 2U, talk_start},
    {talk_stop_path, 2U, talk_stop},
    {take_screenshot_path, 1U, take_screenshot},
    {set_volume_path, 1U, set_volume},
    {set_mic_gain_path, 1U, set_mic_gain},
    {recording_status_path, 2U, recording_status},
    {recording_size_path, 2U, recording_size},
    {recording_read_path, 2U, recording_read},
    {read_screenshot_chunk_path, 1U, read_screenshot_chunk},
    {show_image_path, 1U, show_image},
#ifdef ITERATE_KIT_DIAGNOSTIC_STARVATION
    {inject_starvation_path, 1U, inject_starvation},
#endif
  };
  struct iterate_kit_module module = {0};
  module.methods = methods;
  module.method_count = sizeof(methods) / sizeof(methods[0]);
  module.poll = image_poll;
  module.session_ended = image_session_ended;
  return module;
}
