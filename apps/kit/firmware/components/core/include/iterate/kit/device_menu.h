#ifndef ITERATE_KIT_DEVICE_MENU_H
#define ITERATE_KIT_DEVICE_MENU_H

/*
 * WHAT THE TWO BUTTONS MEAN WHEN THERE IS NO CALL.
 *
 * The device has two buttons and, during a call, both are spoken for: hold the
 * lower one to talk, press the upper one to hang up. Between calls they did
 * almost nothing, while the things a person actually wants there — see which
 * stream this is, start a fresh conversation instead of resuming a stale one,
 * reboot a wedged device — needed a laptop and a CLI.
 *
 * So between calls the same two buttons drive a menu: the lower one cycles,
 * the upper one activates. The first press of the lower button opens it, which
 * is why there is no separate "menu" button to find.
 *
 * THIS MODULE IS THE WHOLE DECISION AND NOTHING ELSE. No display, no buttons,
 * no network, no allocation. A press goes in, a state or an action comes out.
 * Every audible and visible defect this device has had lived in code that
 * mixed a decision into the machinery that carried it out, where it could not
 * be tested without hardware and a ten-minute flash cycle.
 */

#include <stdbool.h>
#include <stdint.h>

/** Where the cursor is. Order is the order they appear on screen. */
enum iterate_kit_menu_item {
  /**
   * Resume on the stream this device is already mounted on.
   *
   * First because it is what somebody who opened the menu by accident wants,
   * and because it is the only option that cannot lose anything.
   */
  ITERATE_KIT_MENU_CONTINUE = 0,
  /** A fresh stream path, set up from scratch: a conversation with no past. */
  ITERATE_KIT_MENU_NEW,
  /** Last, because it is the one you cannot undo by pressing again. */
  ITERATE_KIT_MENU_REBOOT,
  ITERATE_KIT_MENU_ITEM_COUNT,
};

/** What the caller must do, once the upper button has chosen it. */
enum iterate_kit_menu_action {
  /** The menu was not open: the press meant whatever it means elsewhere. */
  ITERATE_KIT_MENU_ACTION_NONE = 0,
  ITERATE_KIT_MENU_ACTION_CONTINUE,
  ITERATE_KIT_MENU_ACTION_NEW,
  ITERATE_KIT_MENU_ACTION_REBOOT,
};

/**
 * The menu.
 *
 * `open` is deliberately not implied by "no call in progress": a device
 * sitting idle is not a device showing a menu, and the difference is what
 * makes the first press of the lower button meaningful rather than a
 * no-op the person has to guess at.
 */
struct iterate_kit_menu {
  bool open;
  uint8_t selected;
};

/** Human-readable item name, for the screen and for test failures. */
const char *iterate_kit_menu_item_name(enum iterate_kit_menu_item item);

/** Closed, with the cursor back at the top. */
void iterate_kit_menu_reset(struct iterate_kit_menu *menu);

/**
 * The lower button was pressed: open the menu, or move to the next item.
 *
 * Wrapping rather than stopping at the bottom, because two buttons cannot
 * express "back" and a person who overshoots must not be stuck.
 */
void iterate_kit_menu_cycle(struct iterate_kit_menu *menu);

/**
 * The upper button was pressed: take the selected item and close.
 *
 * Returns NONE when the menu is not open, so the caller can hand the press
 * to whatever owns the button otherwise — which is how the same button ends
 * a call during one and chooses an item between them.
 *
 * Closing here is deliberate: every action either starts a conversation or
 * reboots, and a menu still on screen after that describes a device that no
 * longer exists.
 */
enum iterate_kit_menu_action iterate_kit_menu_activate(
    struct iterate_kit_menu *menu);

/**
 * A call has started, so the menu is no longer what the buttons mean.
 *
 * Called by the owner of the call rather than inferred here, because this
 * module cannot see a call and guessing would put the menu's correctness at
 * the mercy of what else happens to be true.
 */
void iterate_kit_menu_close(struct iterate_kit_menu *menu);

#endif /* ITERATE_KIT_DEVICE_MENU_H */
