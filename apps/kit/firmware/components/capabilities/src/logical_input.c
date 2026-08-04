#include "iterate/kit/capabilities/logical_input.h"

#include "rpc_internal.h"

#include <string.h>

/*
 * Raw input simulation is deliberately distinct from pushToTalk.start/stop.
 * These methods inject levels into the same gesture reducer as hardware, so a
 * remote caller exercises hold, double-tap, menu claiming, and arbitration
 * rather than bypassing them with an already-decided semantic action.
 */
static const char *const talk_path[] = {
  "logicalInput", "talk", "setPressed",
};
static const char *const menu_path[] = {
  "logicalInput", "menu", "setPressed",
};

static enum capnweb_status set_pressed(
    struct iterate_kit_logical_input *input,
    enum iterate_kit_logical_control control,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value value = {0};
  bool pressed = false;
  enum iterate_kit_status status;
  if (input == NULL || !input->initialized ||
      call == NULL || !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      !capnweb_value_get_boolean(&value, &pressed)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected one boolean pressed level");
  }
  status = input->driver.set_pressed(
      input->driver.context, control, pressed);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status set_talk_pressed(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  return set_pressed(
      context, ITERATE_KIT_LOGICAL_CONTROL_TALK, call, reply);
}

static enum capnweb_status set_menu_pressed(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  return set_pressed(
      context, ITERATE_KIT_LOGICAL_CONTROL_MENU, call, reply);
}

static void session_ended(void *context) {
  struct iterate_kit_logical_input *input = context;
  if (input == NULL || !input->initialized) {
    return;
  }
  /*
   * A remote down level is a lease on one Cap'n Web session, not durable
   * device state. Release both controls when that session disappears so a
   * disconnected test client cannot leave the microphone or menu claimed.
   * The target turns a saturated TALK release into its existing retryable stop
   * obligation, so the void session hook cannot silently strand capture.
   */
  (void)input->driver.set_pressed(
      input->driver.context, ITERATE_KIT_LOGICAL_CONTROL_MENU, false);
  (void)input->driver.set_pressed(
      input->driver.context, ITERATE_KIT_LOGICAL_CONTROL_TALK, false);
}

enum iterate_kit_status iterate_kit_logical_input_init(
    struct iterate_kit_logical_input *input,
    const struct iterate_kit_logical_input_driver *driver) {
  if (input == NULL || driver == NULL ||
      driver->set_pressed == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(input, 0, sizeof(*input));
  input->driver = *driver;
  input->initialized = true;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_logical_input_module(
    struct iterate_kit_logical_input *input) {
  static const struct iterate_kit_method methods[] = {
    {talk_path, 3U, set_talk_pressed},
    {menu_path, 3U, set_menu_pressed},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = input,
    .poll = NULL,
    .close = NULL,
    .session_ended = session_ended,
  };
  return module;
}
