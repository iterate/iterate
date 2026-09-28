#include "iterate/kit/capabilities/system_update.h"

#include "iterate/kit/capabilities/arguments.h"

#include <string.h>

static const char *const update_path[] = {"system", "update"};

static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

/*
 * The digest is required: an image the caller cannot name byte for byte is one
 * the board must not boot. Exactly 64 lowercase hex digits, as `sha256sum`
 * prints it and GitHub lists a release asset's `digest` after `sha256:`.
 */
static bool decode_sha256(const char *hex, size_t length, uint8_t sha256[32]) {
  size_t index;
  if (length != 64U) return false;
  for (index = 0U; index < 32U; ++index) {
    const int high = hex_digit(hex[index * 2U]);
    const int low = hex_digit(hex[index * 2U + 1U]);
    if (high < 0 || low < 0) return false;
    sha256[index] = (uint8_t)((high << 4) | low);
  }
  return true;
}

static enum capnweb_status update(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_system_update *state = context;
  struct capnweb_value object = {0};
  char url[ITERATE_KIT_SYSTEM_UPDATE_URL_CAPACITY];
  char hex[65];
  uint8_t sha256[32];
  size_t url_length = 0U;
  size_t hex_length = 0U;
  enum iterate_kit_status status;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_string_field(
          &object, "url", url, sizeof(url), &url_length) ||
      strncmp(url, "https://", 8U) != 0 ||
      !iterate_kit_read_string_field(
          &object, "sha256", hex, sizeof(hex), &hex_length) ||
      !decode_sha256(hex, hex_length, sha256)) {
    return capnweb_reply_set_error(
        reply,
        "TypeError",
        "system.update needs {url, sha256}: an https url and the image's "
        "sha256 as 64 lowercase hex digits");
  }
  status = state->driver.begin(state->driver.context, url, sha256);
  if (status == ITERATE_KIT_OK) {
    /* Scheduled; the board restarts into the image once it is verified. */
    return capnweb_reply_set_boolean(reply, true);
  }
  if (status == ITERATE_KIT_BACKPRESSURE) {
    return capnweb_reply_set_error(
        reply, "Error", "an update is already in flight");
  }
  return iterate_kit_reply_status(reply, status);
}

enum iterate_kit_status iterate_kit_system_update_init(
    struct iterate_kit_system_update *state,
    const struct iterate_kit_system_update_driver *driver) {
  if (state == NULL || driver == NULL || driver->begin == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(state, 0, sizeof(*state));
  state->driver = *driver;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_system_update_module(
    struct iterate_kit_system_update *state) {
  static const struct iterate_kit_method methods[] = {
    {update_path, 2U, update},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = state,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
