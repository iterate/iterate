#ifndef ITERATE_KIT_DEBOUNCED_BUTTON_H
#define ITERATE_KIT_DEBOUNCED_BUTTON_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Platform-neutral state for a polled physical button.
 *
 * GPIO ownership deliberately stays in the target: M5Unified, an ESP-IDF
 * GPIO, and an I2C expander have different sampling and failure semantics.
 * What they share is the temporal contract. A level must remain unchanged for
 * `debounce_ms` before it becomes stable, and only stable transitions may
 * become device events. Centralising that contract prevents each board from
 * acquiring subtly different bounce, clock-rollback, and boot-held behaviour.
 *
 * This object allocates nothing, blocks nowhere, and retains only the newest
 * level. A noisy switch therefore cannot create a queue whose later replay
 * toggles a conversation after the user has stopped touching the device.
 */
struct iterate_kit_debounced_button {
  uint64_t candidate_since_ms;
  uint32_t debounce_ms;
  bool candidate_pressed;
  bool stable_pressed;
  bool initialized;
};

enum iterate_kit_status iterate_kit_debounced_button_init(
    struct iterate_kit_debounced_button *button,
    bool initially_pressed,
    uint32_t debounce_ms,
    uint64_t now_ms);

/**
 * Observes one sampled level and reports at most one stable edge.
 *
 * `pressed_edge` and `released_edge` are cleared on every valid call. A clock
 * that moves backwards rebases the candidate instead of converting unsigned
 * subtraction into an immediate false edge. Callers remain responsible for
 * classifying GPIO/I2C read failures; feeding a fabricated level would hide a
 * hardware fault inside otherwise-valid input state.
 */
enum iterate_kit_status iterate_kit_debounced_button_update(
    struct iterate_kit_debounced_button *button,
    bool sampled_pressed,
    uint64_t now_ms,
    bool *pressed_edge,
    bool *released_edge);

#ifdef __cplusplus
}
#endif

#endif
