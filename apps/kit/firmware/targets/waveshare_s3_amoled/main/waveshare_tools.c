/*
 * The device's own tools, mounted as a live capability at kit.waveshare so
 * an agent or `pnpm cli itx run` can drive the screen, the call, and see
 * what the screen looks like:
 *
 *   await itx.kit.waveshare.setBackground("#1e293b")   // or "navy"
 *   await itx.kit.waveshare.startCall()
 *   await itx.kit.waveshare.hangUp()
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
#include "waveshare_display.h"

static const char *const set_background_path[] = {"setBackground"};
static const char *const start_call_path[] = {"startCall"};
static const char *const hang_up_path[] = {"hangUp"};
static const char *const take_screenshot_path[] = {"takeScreenshot"};
static const char *const read_screenshot_chunk_path[] = {"readScreenshotChunk"};

enum {
  /*
   * One chunk plus its ["bytes","..."] envelope has to fit a single control
   * message: 2400 raw bytes is 3200 base64 characters.
   */
  SCREENSHOT_CHUNK_BYTES = 2400,
  SCREENSHOT_CHUNKS =
      (WAVESHARE_SNAPSHOT_BYTES + SCREENSHOT_CHUNK_BYTES - 1) /
      SCREENSHOT_CHUNK_BYTES,
};

EXT_RAM_BSS_ATTR static uint8_t screenshot_pixels[WAVESHARE_SNAPSHOT_BYTES];
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
  waveshare_display_request_call(false);
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

struct iterate_kit_module waveshare_tools_module(void) {
  static const struct iterate_kit_method methods[] = {
    {set_background_path, 1U, set_background},
    {start_call_path, 1U, start_call},
    {hang_up_path, 1U, hang_up},
    {take_screenshot_path, 1U, take_screenshot},
    {read_screenshot_chunk_path, 1U, read_screenshot_chunk},
  };
  struct iterate_kit_module module = {0};
  module.methods = methods;
  module.method_count = sizeof(methods) / sizeof(methods[0]);
  return module;
}
