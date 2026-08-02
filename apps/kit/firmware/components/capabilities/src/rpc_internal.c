#include "rpc_internal.h"

#include <string.h>

/*
 * Keep the public error vocabulary small while preserving whether the caller
 * supplied a bad command, exceeded a fixed resource, or hit device state/I/O.
 * ITERATE_KIT_OK reaching this function is itself a programming error; turning
 * it into a rejected RPC makes that contradiction visible instead of sending a
 * false success.
 */
enum capnweb_status iterate_kit_reply_status(
    struct capnweb_reply *reply, enum iterate_kit_status status) {
  switch (status) {
    case ITERATE_KIT_INVALID_ARGUMENT:
      return capnweb_reply_set_error(
          reply, "RangeError", "hardware rejected the arguments");
    case ITERATE_KIT_UNAVAILABLE:
      return capnweb_reply_set_error(
          reply, "Error", "hardware capability unavailable");
    case ITERATE_KIT_IO_ERROR:
      return capnweb_reply_set_error(
          reply, "Error", "hardware I/O failed");
    case ITERATE_KIT_LIMIT:
      return capnweb_reply_set_error(
          reply, "RangeError", "hardware resource limit reached");
    case ITERATE_KIT_BACKPRESSURE:
      return capnweb_reply_set_error(
          reply, "Error", "hardware is busy");
    case ITERATE_KIT_STATE_ERROR:
      return capnweb_reply_set_error(
          reply, "Error", "hardware is in the wrong state");
    case ITERATE_KIT_OK:
      return capnweb_reply_set_error(
          reply, "Error", "hardware returned an invalid success status");
  }
  return capnweb_reply_set_error(
      reply, "Error", "hardware returned an unknown status");
}

bool iterate_kit_read_object_argument(
    const struct capnweb_call *call, struct capnweb_value *object) {
  return call != NULL &&
      object != NULL &&
      call->has_arguments &&
      capnweb_value_array_at(&call->arguments, 0U, object) &&
      capnweb_value_get_type(object) == CAPNWEB_JSON_OBJECT;
}

/*
 * Cap'n Web integers are read at their widest signed representation. Each
 * capability must validate its own domain before narrowing to a hardware type;
 * accepting JSON coercions here would hide malformed callers and enable wrap.
 */
bool iterate_kit_read_int_field(
    const struct capnweb_value *object,
    const char *name,
    int64_t *result) {
  struct capnweb_value value = {0};
  return object != NULL &&
      name != NULL &&
      result != NULL &&
      capnweb_value_object_get(object, name, &value) &&
      capnweb_value_get_int64(&value, result);
}

enum capnweb_status iterate_kit_read_subscription_arguments(
    struct capnweb_session *session,
    const struct capnweb_call *call,
    struct capnweb_reply *reply,
    const char *callback_error_message,
    struct capnweb_remote_capability *callback,
    struct iterate_kit_subscription_owner_key *owner_key,
    bool *valid) {
  struct capnweb_value callback_value = {0};
  struct capnweb_value key_value = {0};
  size_t argument_count;
  enum capnweb_status status;
  if (session == NULL || call == NULL || reply == NULL ||
      callback_error_message == NULL || callback == NULL ||
      owner_key == NULL || valid == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  *valid = false;
  memset(owner_key, 0, sizeof(*owner_key));
  argument_count = call->has_arguments
      ? capnweb_value_array_size(&call->arguments)
      : 0U;
  if ((argument_count != 1U && argument_count != 2U) ||
      !capnweb_value_array_at(
          &call->arguments, 0U, &callback_value) ||
      !capnweb_value_get_remote_capability(
          &callback_value, callback)) {
    return capnweb_reply_set_error(
        reply, "TypeError", callback_error_message);
  }
  if (argument_count == 1U) {
    *valid = true;
    return CAPNWEB_OK;
  }

  if (!capnweb_value_array_at(&call->arguments, 1U, &key_value)) {
    status = CAPNWEB_E_INVALID_MESSAGE;
  } else {
    status = capnweb_value_copy_string(
        &key_value,
        owner_key->bytes,
        sizeof(owner_key->bytes),
        &owner_key->length);
  }
  if (status == CAPNWEB_OK && owner_key->length > 0U) {
    owner_key->present = true;
    *valid = true;
    return CAPNWEB_OK;
  }

  /*
   * The export expression was already imported before application argument
   * validation. Release it before rejecting the key; otherwise one malformed
   * retry consumes both the Cap'n Web import table and a remote export ref.
   */
  status = capnweb_session_release_remote(session, *callback);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return capnweb_reply_set_error(
      reply,
      "TypeError",
      "subscription owner key must contain 1 through 31 UTF-8 bytes");
}

bool iterate_kit_subscription_owner_keys_equal(
    const struct iterate_kit_subscription_owner_key *left,
    const struct iterate_kit_subscription_owner_key *right) {
  return left != NULL &&
      right != NULL &&
      left->present &&
      right->present &&
      left->length == right->length &&
      memcmp(left->bytes, right->bytes, left->length) == 0;
}
