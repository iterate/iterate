#include "iterate/kit/capabilities/system_update.h"

#include "rpc_internal.h"

#include <string.h>

static const char *const update_path[] = {"system", "update"};

/*
 * The digest is required, not optional: an update the server cannot name
 * byte-for-byte is an update the device must not boot. Scheme and length are
 * checked here so the driver only ever sees a request worth starting.
 */
static bool valid_sha256_hex(const char *digest) {
  size_t index;
  for (index = 0U; index < 64U; ++index) {
    const char c = digest[index];
    const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    if (!hex) return false;
  }
  return digest[64] == '\0';
}

static enum capnweb_status update(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_system_update *state = context;
  struct capnweb_value object = {0};
  struct capnweb_value url_value = {0};
  struct capnweb_value digest_value = {0};
  char url[512];
  char digest[65];
  size_t url_length = 0U;
  size_t digest_length = 0U;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !capnweb_value_object_get(&object, "url", &url_value) ||
      capnweb_value_copy_string(&url_value, url, sizeof(url), &url_length) !=
          CAPNWEB_OK ||
      !capnweb_value_object_get(&object, "sha256", &digest_value) ||
      capnweb_value_copy_string(
          &digest_value, digest, sizeof(digest), &digest_length) !=
          CAPNWEB_OK) {
    return capnweb_reply_set_error(
        reply, "TypeError", "system.update needs {url, sha256}");
  }
  if ((strncmp(url, "http://", 7U) != 0 &&
       strncmp(url, "https://", 8U) != 0) ||
      digest_length != 64U || !valid_sha256_hex(digest)) {
    return capnweb_reply_set_error(
        reply,
        "TypeError",
        "system.update needs an http(s) url and a 64-char lowercase "
        "sha256 hex digest");
  }
  switch (state->driver.begin(state->driver.context, url, digest)) {
    case ITERATE_KIT_OK:
      /* Scheduled. The device reboots into the new image on success. */
      return capnweb_reply_set_boolean(reply, true);
    case ITERATE_KIT_BACKPRESSURE:
      return capnweb_reply_set_error(
          reply, "Error", "busy — an update is already in flight");
    default:
      return capnweb_reply_set_error(
          reply, "Error", "the update could not be started");
  }
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
