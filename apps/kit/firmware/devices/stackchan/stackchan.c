#include "iterate/kit/devices/stackchan.h"

#include <string.h>

/*
 * StackChan is the first rich capability profile: metrics, screen, servos,
 * LEDs, and camera are generic modules, while this file records only the
 * board/product-specific composition and safe geometry. Hardware access stays
 * behind injected drivers so the same capability contract can run in the host
 * rig and on ESP-IDF without preprocessor forks.
 *
 * Audio is deliberately absent from this profile until its board path meets
 * the realtime guarantees. Reusing a known-bad queued audio implementation
 * would make the manifest promise behavior the hardware layer cannot deliver.
 */
static const char description[] =
    "{\"instructions\":\"An Iterate StackChan with health metrics, screen, "
    "head servos, RGB LEDs, and camera. This profile does not yet expose "
    "audio.\",\"children\":{"
    "\"subscribeToMetrics\":\"Call a callback immediately and once per "
    "configured interval with bounded runtime metrics.\","
    "\"renderOnScreen\":\"Download and render a PNG from {url}.\","
    "\"servos\":\"Head servos; call servos.move(...).\","
    "\"leds\":\"RGB LEDs; call leds.set(...) or leds.fill(...).\","
    "\"takePhoto\":\"Capture and return one bounded image byte array.\"}}";

const struct iterate_kit_device_manifest iterate_kit_stackchan_manifest = {
  "stackchan",
  "M5Stack StackChan",
  ITERATE_KIT_AUDIO_NONE,
};

enum capnweb_status iterate_kit_stackchan_init(
    struct iterate_kit_stackchan *device,
    const struct iterate_kit_stackchan_options *options) {
  static const struct iterate_kit_servo_limits servo_limits = {
    -128,
    128,
    0,
    90,
    1000U,
  };
  /*
   * These are StackChan mechanical/speed limits, not universal servo ranges.
   * Keeping them here prevents the generic servo capability from baking one
   * enclosure's geometry into every future device.
   */
  struct iterate_kit_peer_options peer_options;
  if (device == NULL || options == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(device, 0, sizeof(*device));
  /*
   * Do not expose a partially assembled peer. Every module validates its
   * driver and fixed resource budget first; failure leaves the profile
   * unreachable and gives the platform one deterministic boot error.
   */
  if (iterate_kit_screen_init(
          &device->screen,
          &options->screen,
          options->screen_url_scratch,
          options->screen_url_scratch_size) != ITERATE_KIT_OK ||
      iterate_kit_servos_init(
          &device->servos,
          &options->servos,
          &servo_limits) != ITERATE_KIT_OK ||
      iterate_kit_leds_init(
          &device->leds, &options->leds, 12U) != ITERATE_KIT_OK ||
      iterate_kit_camera_init(
          &device->camera,
          &options->camera,
          options->maximum_photo_bytes) != ITERATE_KIT_OK ||
      iterate_kit_metrics_init(
          &device->metrics, &options->metrics) != ITERATE_KIT_OK) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  device->modules[0] = iterate_kit_metrics_module(&device->metrics);
  device->modules[1] = iterate_kit_screen_module(&device->screen);
  device->modules[2] = iterate_kit_servos_module(&device->servos);
  device->modules[3] = iterate_kit_leds_module(&device->leds);
  device->modules[4] = iterate_kit_camera_module(&device->camera);
  /*
   * Routing remains one fixed table even though the public description is
   * nested. Each generic module owns its method path, avoiding a per-profile
   * dynamic capability tree and its RAM/lifetime complexity.
   */
  peer_options = (struct iterate_kit_peer_options){
    description,
    sizeof(description) - 1U,
    device->modules,
    sizeof(device->modules) / sizeof(device->modules[0]),
  };
  return iterate_kit_peer_init(&device->peer, &peer_options);
}

struct capnweb_capability iterate_kit_stackchan_capability(
    struct iterate_kit_stackchan *device) {
  return iterate_kit_peer_capability(&device->peer);
}

struct iterate_kit_poll_result iterate_kit_stackchan_poll(
    struct iterate_kit_stackchan *device, uint64_t now_ms) {
  return iterate_kit_peer_poll(&device->peer, now_ms);
}

struct iterate_kit_poll_result iterate_kit_stackchan_close(
    struct iterate_kit_stackchan *device) {
  return iterate_kit_peer_close(&device->peer);
}

static struct iterate_kit_poll_result poll_device(
    void *context, uint64_t now_ms) {
  return iterate_kit_stackchan_poll(context, now_ms);
}

static struct iterate_kit_poll_result close_device(void *context) {
  return iterate_kit_stackchan_close(context);
}

struct iterate_kit_device iterate_kit_stackchan_device(
    struct iterate_kit_stackchan *device) {
  const struct iterate_kit_device runtime = {
    &iterate_kit_stackchan_manifest,
    iterate_kit_stackchan_capability(device),
    device,
    poll_device,
    close_device,
  };
  return runtime;
}
