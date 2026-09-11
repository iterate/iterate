#ifndef ITERATE_KIT_BUTTON_H
#define ITERATE_KIT_BUTTON_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Debounced tap/hold classifier. Zero-initialize; serialize updates and takes.
 * Supply monotonic milliseconds. HAVPE uses GPIO0, a boot strap: never
 * restart while held low, because that enters the ROM downloader. This only
 * classifies gestures; end-hold cannot re-arm until a debounced release.
 * The 250 ms hold onset trades latency for the one-button grammar; a person
 * normally covers it with their press-then-speak lead.
 */
struct iterate_kit_button {
  bool level_pressed;
  bool debounced_pressed;
  uint64_t changed_at_ms;
  uint64_t pressed_since_ms;
  bool talk_latched;
  bool press_pending;
  bool tap_pending;
  /* The deliberate end: latched ONCE when a press crosses 800 ms,
   * fired while still pressed so the answer is immediate. An ordinary
   * press crosses the 250 ms talk threshold without meaning anything —
   * measured on the desk as "call ended" the moment a call opened. */
  bool end_hold_latched;
  bool end_hold_pending;
};

/** Sample a level: 30 ms debounce, 250 ms talk threshold, 800 ms end-hold. */
void iterate_kit_button_update(
    struct iterate_kit_button *button, bool pressed, uint64_t now_ms);
/** Consume the debounced down-edge once. */
bool iterate_kit_button_take_press(struct iterate_kit_button *button);
/** Consume a completed short release or injected tap once. */
bool iterate_kit_button_take_tap(struct iterate_kit_button *button);
/** Consume the deliberate end once, while the button may still be down. */
bool iterate_kit_button_take_end_hold(struct iterate_kit_button *button);
/** Whether the debounced button is down and has crossed the talk threshold. */
bool iterate_kit_button_held(const struct iterate_kit_button *button);
/** Queue one synthetic tap without changing the physical hold state. */
void iterate_kit_button_inject_tap(struct iterate_kit_button *button);

#ifdef __cplusplus
}
#endif

#endif
