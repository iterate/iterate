#ifndef ITERATE_KIT_CAPABILITIES_LOGICAL_INPUT_H
#define ITERATE_KIT_CAPABILITIES_LOGICAL_INPUT_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Product-level controls which can have physical and remote input adapters.
 *
 * These names describe intent rather than board geometry. A front button,
 * keyboard shortcut, touch target, and remote diagnostic call can all drive
 * TALK without teaching the interaction reducer about their hardware source.
 */
enum iterate_kit_logical_control {
  ITERATE_KIT_LOGICAL_CONTROL_TALK = 0,
  ITERATE_KIT_LOGICAL_CONTROL_MENU = 1,
  ITERATE_KIT_LOGICAL_CONTROL_COUNT,
};

/**
 * Synchronous adapter into the device's sole logical-input reducer.
 *
 * `set_pressed` must be idempotent for an unchanged source level. Success
 * means the remote level was accepted locally; it does not mean that a
 * resulting conversation event reached the network peer. The driver context
 * and callback must remain valid for the module lifetime.
 */
struct iterate_kit_logical_input_driver {
  void *context;
  enum iterate_kit_status (*set_pressed)(
      void *context,
      enum iterate_kit_logical_control control,
      bool pressed);
};

struct iterate_kit_logical_input {
  struct iterate_kit_logical_input_driver driver;
  bool initialized;
};

enum iterate_kit_status iterate_kit_logical_input_init(
    struct iterate_kit_logical_input *input,
    const struct iterate_kit_logical_input_driver *driver);
struct iterate_kit_module iterate_kit_logical_input_module(
    struct iterate_kit_logical_input *input);

#ifdef __cplusplus
}
#endif

#endif
