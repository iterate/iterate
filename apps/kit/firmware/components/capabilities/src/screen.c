#include "iterate/kit/capabilities/screen.h"
#include "iterate/kit/capabilities/arguments.h"
#include <stdio.h>
#include <string.h>

/*
 * THE LAST CHUNK'S ANSWER IS THE REFRESH'S. `setImage` answers each chunk with
 * the bytes staged so far, except the chunk that completes the frame: that
 * answer waits until the driver leaves PENDING, then carries the frame's length
 * if the panel shows it, or an error if the refresh failed. The caller awaits
 * one call and asks nothing again (apps/agents/voice/worker.ts). An e-paper
 * refresh takes seconds, so the reply is deferred (`capnweb_reply_defer`) and
 * `step`, which the device loop runs every pass, answers it; a driver that
 * shows at once (a reflective LCD) is answered on the spot.
 *
 * `status` stays for the voice workers projects already run: a project keeps
 * the worker it installed (apps/agents/voice/install.ts), and those ask
 * `status` after the last chunk.
 */

static const char *const formats[] = {"mono1", "gray4", "rgb565"};
static const char *const states[] = {"idle", "pending", "shown", "failed"};

size_t iterate_kit_screen_frame_bytes(uint16_t width, uint16_t height,
                                    enum iterate_kit_screen_format format) {
  unsigned bits = format == ITERATE_KIT_SCREEN_MONO1 ? 1 :
    format == ITERATE_KIT_SCREEN_GRAY4 ? 4 : format == ITERATE_KIT_SCREEN_RGB565 ? 16 : 0;
  if (!bits || !width || !height || width > 2048 || height > 2048) return 0;
  return ((size_t)width * bits + 7) / 8 * height;
}

static enum iterate_kit_screen_state refresh_state(struct iterate_kit_screen *screen) {
  enum iterate_kit_screen_state state = screen->showing_image ?
    screen->driver.state(screen->driver.context) : ITERATE_KIT_SCREEN_IDLE;
  if (screen->refresh_pending && state != ITERATE_KIT_SCREEN_PENDING) {
    screen->refresh_pending = false;
    if (state == ITERATE_KIT_SCREEN_SHOWN) ++screen->uploads_completed;
    else ++screen->upload_failures;
  }
  return state;
}

static enum capnweb_status info(void *context, const struct capnweb_call *call,
                               struct capnweb_reply *reply) {
  (void)call;
  const struct iterate_kit_screen *screen = context;
  char supported[64] = {0};
  const char *preferred = NULL;
  size_t used = 0;
  for (unsigned i = 0; i < 3; ++i) {
    if (screen->driver.formats & (1U << i))
      used += (size_t)snprintf(supported + used, sizeof(supported) - used,
                              "%s\"%s\"", used ? "," : "", formats[i]);
    if ((unsigned)screen->driver.preferred_format == (1U << i)) preferred = formats[i];
  }
  static char json[256];
  const int length = snprintf(json, sizeof(json),
    "{\"width\":%u,\"height\":%u,\"formats\":[[%s]],\"preferredFormat\":\"%s\","
    "\"maxChunkBytes\":4096,\"refreshTimeoutMs\":%lu,\"partialRefresh\":%s}",
    screen->driver.width, screen->driver.height, supported, preferred,
    (unsigned long)screen->driver.refresh_timeout_ms, screen->driver.partial_refresh ? "true" : "false");
  return capnweb_reply_set_borrowed_expression(reply, json, (size_t)length, NULL, NULL);
}

static enum capnweb_status status(void *context, const struct capnweb_call *call,
                                 struct capnweb_reply *reply) {
  (void)call;
  struct iterate_kit_screen *screen = context;
  const enum iterate_kit_screen_state state = refresh_state(screen);
  static char json[96];
  const int length = snprintf(json, sizeof(json), "{\"uploadId\":%lu,\"state\":\"%s\"}",
    (unsigned long)screen->upload_id, screen->uploading ? "receiving" : states[state]);
  return capnweb_reply_set_borrowed_expression(reply, json, (size_t)length, NULL, NULL);
}

/* Strict padded RFC4648, capped at one transport chunk. Validate the entire
 * chunk before writing so a rejected chunk cannot corrupt staged pixels. */
static bool decode(const char *text, size_t length, uint8_t *out, size_t capacity, size_t *written) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (!length || length % 4) return false;
  size_t padding = text[length - 1] == '=' ? 1 : 0;
  if (padding && text[length - 2] == '=') ++padding;
  *written = length / 4 * 3 - padding;
  if (*written > 4096 || *written > capacity) return false;
  for (size_t i = 0; i < length; ++i) {
    if (i >= length - padding) { if (text[i] != '=') return false; }
    else if (!text[i] || strchr(alphabet, text[i]) == NULL) return false;
  }
  size_t n = 0;
  for (size_t i = 0; i < length; i += 4) {
    uint32_t value = 0;
    for (unsigned j = 0; j < 4; ++j)
      value = (value << 6) | (text[i + j] == '=' ? 0U : (uint32_t)(strchr(alphabet, text[i + j]) - alphabet));
    for (unsigned j = 0; j < 3 && n < *written; ++j)
      out[n++] = (uint8_t)(value >> (16 - j * 8));
  }
  return true;
}

static enum capnweb_status set_image(void *context, const struct capnweb_call *call,
                                    struct capnweb_reply *reply) {
  struct iterate_kit_screen *screen = context;
  struct capnweb_value input = {0};
  int64_t upload_id = 0, offset = 0;
  size_t encoded_length = 0, decoded = 0, format_length = 0;
  char format[16];
  if (!call || !call->has_arguments || !capnweb_value_array_at(&call->arguments, 0, &input))
    return capnweb_reply_set_error(reply, "TypeError", "screen.setImage needs null or an image chunk");
  if (screen->shown_answer_owed || refresh_state(screen) == ITERATE_KIT_SCREEN_PENDING)
    return capnweb_reply_set_error(reply, "BusyError", "screen refresh is still pending");
  if (capnweb_value_get_type(&input) == CAPNWEB_JSON_NULL) {
    screen->uploading = false;
    screen->next_offset = 0;
    screen->showing_image = false;
    return capnweb_reply_set_boolean(reply, true);
  }
  if (!iterate_kit_read_int_field(&input, "uploadId", &upload_id) || upload_id < 0 || upload_id > UINT32_MAX ||
      !iterate_kit_read_int_field(&input, "offset", &offset) || offset < 0 ||
      !iterate_kit_read_string_field(&input, "format", format, sizeof(format), &format_length) ||
      !iterate_kit_read_string_field(&input, "data", screen->encoded, sizeof(screen->encoded), &encoded_length))
    goto invalid;
  enum iterate_kit_screen_format selected = 0;
  for (unsigned i = 0; i < 3; ++i) if (strcmp(format, formats[i]) == 0) selected = 1U << i;
  if (!selected || !(screen->driver.formats & selected)) goto invalid;
  if (offset == 0) {
    screen->uploading = true;
    screen->upload_id = (uint32_t)upload_id;
    screen->next_offset = 0;
    screen->format = selected;
    screen->expected_bytes = iterate_kit_screen_frame_bytes(screen->driver.width, screen->driver.height, selected);
    ++screen->uploads_started;
  }
  if (!screen->uploading || screen->upload_id != (uint32_t)upload_id || selected != screen->format ||
      (uint64_t)offset != screen->next_offset ||
      !decode(screen->encoded, encoded_length, screen->bitmap + screen->next_offset,
              screen->expected_bytes - screen->next_offset, &decoded) || decoded == 0) goto invalid;
  screen->next_offset += decoded;
  screen->bytes_received += (uint32_t)decoded;
  if (screen->next_offset == screen->expected_bytes) {
    screen->uploading = false;
    if (!screen->driver.submit(screen->driver.context, screen->format, screen->bitmap, screen->expected_bytes)) {
      ++screen->upload_failures;
      return capnweb_reply_set_error(reply, "Error", "screen rejected frame");
    }
    screen->showing_image = true;
    screen->refresh_pending = true;
    const enum iterate_kit_screen_state state = refresh_state(screen);
    if (state == ITERATE_KIT_SCREEN_PENDING) {
      screen->shown_answer = call->responder;
      screen->shown_answer_owed = true;
      return capnweb_reply_defer(reply);
    }
    if (state != ITERATE_KIT_SCREEN_SHOWN)
      return capnweb_reply_set_error(reply, "Error", "screen refresh failed");
  }
  return capnweb_reply_set_int64(reply, (int64_t)screen->next_offset);
invalid:
  ++screen->upload_failures;
  return capnweb_reply_set_error(reply, "RangeError", "invalid screen format, upload, offset or base64 chunk");
}

static void step(void *context) {
  struct iterate_kit_screen *screen = context;
  if (!screen->shown_answer_owed) return;
  const enum iterate_kit_screen_state state = refresh_state(screen);
  if (state == ITERATE_KIT_SCREEN_PENDING) return;
  screen->shown_answer_owed = false;
  /* A session that ended meanwhile has no one to answer; the call failed with it. */
  if (state == ITERATE_KIT_SCREEN_SHOWN)
    (void)capnweb_responder_set_int64(screen->shown_answer, (int64_t)screen->next_offset);
  else
    (void)capnweb_responder_set_error(screen->shown_answer, "Error", "screen refresh failed");
}

static void session_ended(void *context) {
  struct iterate_kit_screen *screen = context;
  screen->uploading = false;
  screen->next_offset = 0;
  screen->shown_answer_owed = false;
}

bool iterate_kit_screen_init(struct iterate_kit_screen *screen,
                            const struct iterate_kit_screen_driver *driver,
                            uint8_t *buffer, size_t capacity) {
  if (!screen || !driver || !buffer || !driver->submit || !driver->state ||
      !driver->formats || (driver->formats & ~7U) ||
      !iterate_kit_screen_frame_bytes(driver->width, driver->height, driver->preferred_format) ||
      !(driver->formats & driver->preferred_format) || !driver->refresh_timeout_ms ||
      driver->refresh_timeout_ms > 60000) return false;
  for (unsigned i = 0; i < 3; ++i) if (driver->formats & (1U << i)) {
    const size_t bytes = iterate_kit_screen_frame_bytes(driver->width, driver->height, 1U << i);
    if (!bytes || bytes > capacity) return false;
  }
  memset(screen, 0, sizeof(*screen));
  screen->driver = *driver;
  screen->bitmap = buffer;
  screen->capacity = capacity;
  return true;
}

struct iterate_kit_module iterate_kit_screen_module(struct iterate_kit_screen *screen) {
  static const char *const paths[][2] = {{"screen", "info"}, {"screen", "setImage"}, {"screen", "status"}};
  static const struct iterate_kit_method methods[] = {{paths[0], 2, info}, {paths[1], 2, set_image}, {paths[2], 2, status}};
  return (struct iterate_kit_module){.methods = methods, .method_count = 3,
    .context = screen, .session_ended = session_ended, .step = step};
}
