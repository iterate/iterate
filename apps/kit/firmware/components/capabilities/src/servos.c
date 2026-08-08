#include "iterate/kit/capabilities/servos.h"

#include "rpc_internal.h"

#include <limits.h>
#include <string.h>

/*
 * Servo safety is enforced before any narrowing conversion or driver call.
 * Device-specific physical limits are copied at initialization, leaving the
 * reusable RPC layer independent of pulse geometry while ensuring a remote
 * integer can never wrap into unintended motion.
 */
static const char *const move_path[] = {"servos", "move"};

static enum capnweb_status move(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_servos *servos = context;
  struct capnweb_value object = {0};
  int64_t yaw = 0;
  int64_t pitch = 0;
  int64_t speed = 0;
  enum iterate_kit_status status;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "yawDegrees", &yaw) ||
      !iterate_kit_read_int_field(&object, "pitchDegrees", &pitch) ||
      !iterate_kit_read_int_field(&object, "speed", &speed) ||
      yaw < servos->limits.minimum_yaw_degrees ||
      yaw > servos->limits.maximum_yaw_degrees ||
      pitch < servos->limits.minimum_pitch_degrees ||
      pitch > servos->limits.maximum_pitch_degrees ||
      speed < 0 ||
      speed > servos->limits.maximum_speed ||
      speed > UINT16_MAX) {
    return capnweb_reply_set_error(
        reply,
        "RangeError",
        "servo command is outside the configured limits");
  }
  status = servos->driver.move(
      servos->driver.context,
      (int32_t)yaw,
      (int32_t)pitch,
      (uint16_t)speed);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_boolean(reply, true);
}

enum iterate_kit_status iterate_kit_servos_init(
    struct iterate_kit_servos *servos,
    const struct iterate_kit_servo_driver *driver,
    const struct iterate_kit_servo_limits *limits) {
  if (servos == NULL ||
      driver == NULL ||
      driver->move == NULL ||
      limits == NULL ||
      limits->minimum_yaw_degrees > limits->maximum_yaw_degrees ||
      limits->minimum_pitch_degrees > limits->maximum_pitch_degrees) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Copy the limit snapshot rather than borrowing it: profiles often declare
   * limits in static tables, but making ownership explicit costs only a few
   * words and prevents later mutation from changing the RPC safety envelope.
   */
  memset(servos, 0, sizeof(*servos));
  servos->driver = *driver;
  servos->limits = *limits;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_servos_module(
    struct iterate_kit_servos *servos) {
  static const struct iterate_kit_method methods[] = {
    {move_path, 2U, move},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = servos,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
