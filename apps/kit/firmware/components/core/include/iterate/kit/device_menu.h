#ifndef ITERATE_KIT_DEVICE_MENU_H
#define ITERATE_KIT_DEVICE_MENU_H

/*
 * WHAT THE TWO BUTTONS MEAN, AND THE ONE MENU BEHIND THEM.
 *
 * The endpoint has two logical controls: TALK and MENU. A board adapter maps
 * those meanings onto its actual button positions; position is hardware, not
 * navigation semantics. That is the whole grammar:
 *
 *   MENU, tap: open the menu, or move to the next item
 *   TALK, tap: take the item under the cursor, or — with the menu closed —
 *              start a call
 *   TALK, held: talk
 *
 * ONE MENU, EVERYWHERE. It used to exist only between calls, on the reasoning
 * that a call had spoken for both buttons: the lower one hung up. But the
 * things a person wants mid-conversation are the same things they want either
 * side of it — which stream is this, start a fresh one, reboot a wedged device
 * — and a button that means "menu" between calls and "hang up" during them has
 * a label that must be read every single time.
 *
 * So hanging up became an item, and the item list depends on context. That
 * costs two presses on the way to hanging up, and buys a device whose two
 * buttons mean one thing each.
 *
 * CLOSE IS FIRST, ALWAYS. It is what somebody who opened the menu by accident
 * wants, it is the only item that cannot change anything, and it is why
 * "continue this conversation" is no longer an item: closing the menu IS
 * continuing, and an item that did nothing but agree with the cursor's
 * starting position was a choice offered for no reason.
 *
 * THIS MODULE IS THE WHOLE DECISION AND NOTHING ELSE. No display, no buttons,
 * no network, no allocation. A press and a context go in, a state or an action
 * comes out. Every audible and visible defect this device has had lived in code
 * that mixed a decision into the machinery that carried it out, where it could
 * not be tested without hardware and a ten-minute flash cycle.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Everything an item exists in. Passed to every call that could depend on it,
 * rather than remembered here: a menu that cached whether a call was up would
 * be one more thing that can disagree with the device.
 */
struct iterate_kit_menu_context {
  /** A call is up: hanging up is worth offering, and starting one is not. */
  bool call_active;
  /** This endpoint can allocate or select a fresh conversation stream. */
  bool new_conversation_available;
  /** This endpoint has more than one locally selectable visual identity. */
  bool next_sprite_available;
  /** Firmware may safely perform an explicit software restart. */
  bool reboot_available;
};

/**
 * Every item this menu can ever offer. Order is the order on screen.
 *
 * START CALL and HANG UP are one position wearing two faces: exactly one of
 * them is ever offered, because "start" with a call up and "hang up" without
 * one are both items that would do nothing. Optional endpoint capabilities are
 * also withheld rather than rendering actions that cannot settle successfully.
 */
enum iterate_kit_menu_item {
  /**
   * Put the menu away and change nothing.
   *
   * First because it is what an accidental press wants, and because it is the
   * only item with nothing to undo.
   */
  ITERATE_KIT_MENU_CLOSE = 0,
  /** Start a call on this stream. Offered only while there is not one. */
  ITERATE_KIT_MENU_START_CALL,
  /** End the call that is up. Offered only while one is. */
  ITERATE_KIT_MENU_HANG_UP,
  /** A fresh stream path, set up from scratch: a conversation with no past. */
  ITERATE_KIT_MENU_NEW,
  /**
   * The next compiled face.
   *
   * Cycles rather than opening a picker, because two buttons cannot navigate a
   * list of faces without becoming a second menu — and with a handful compiled
   * in, pressing until you like one IS the picker.
   */
  ITERATE_KIT_MENU_NEXT_SPRITE,
  /** Last, because it is the one you cannot undo by pressing again. */
  ITERATE_KIT_MENU_REBOOT,
  ITERATE_KIT_MENU_ITEM_COUNT,
};

/** What the caller must do, once the TALK control has chosen it. */
enum iterate_kit_menu_action {
  /** The menu was not open: the press meant whatever it means elsewhere. */
  ITERATE_KIT_MENU_ACTION_NONE = 0,
  ITERATE_KIT_MENU_ACTION_CLOSE,
  ITERATE_KIT_MENU_ACTION_START_CALL,
  ITERATE_KIT_MENU_ACTION_HANG_UP,
  ITERATE_KIT_MENU_ACTION_NEW,
  ITERATE_KIT_MENU_ACTION_NEXT_SPRITE,
  ITERATE_KIT_MENU_ACTION_REBOOT,
};

/**
 * The menu.
 *
 * `selected` is an index into the items THIS CONTEXT offers, not into the enum
 * above — the two differ the moment an item is withheld, and storing the enum
 * value instead would put the cursor on a hidden item every time a call ended
 * under an open menu.
 *
 * `open` is deliberately not implied by anything else. A device sitting idle is
 * not a device showing a menu, and the difference is what makes the first press
 * of the MENU control meaningful rather than a no-op to be guessed at.
 */
struct iterate_kit_menu {
  bool open;
  uint8_t selected;
};

/**
 * How many items this context offers. Never zero: CLOSE is always one of them.
 */
uint8_t iterate_kit_menu_item_count(struct iterate_kit_menu_context context);

/**
 * The item at `index` in this context, or ITERATE_KIT_MENU_ITEM_COUNT when
 * there is no such item.
 */
enum iterate_kit_menu_item iterate_kit_menu_item_at(
    struct iterate_kit_menu_context context, uint8_t index);

/** Human-readable item name, for the screen and for test failures. */
const char *iterate_kit_menu_item_name(enum iterate_kit_menu_item item);

/** Closed, with the cursor back at the top. */
void iterate_kit_menu_reset(struct iterate_kit_menu *menu);

/**
 * The MENU control was pressed: open the menu, or move to the next item.
 *
 * Wrapping rather than stopping at the bottom, because two buttons cannot
 * express "back" and a person who overshoots must not be stuck.
 */
void iterate_kit_menu_cycle(
    struct iterate_kit_menu *menu, struct iterate_kit_menu_context context);

/**
 * The TALK control was pressed: take the selected item and close.
 *
 * Returns NONE when the menu is not open, so the caller can hand the press to
 * whatever owns the button otherwise — which is how the same button starts a
 * call with the menu closed and chooses an item with it open.
 *
 * Closing here is deliberate: every action either changes the conversation or
 * reboots, and a menu still on screen after that describes a device that no
 * longer exists. CLOSE closes too, which is the whole of what it does.
 */
enum iterate_kit_menu_action iterate_kit_menu_activate(
    struct iterate_kit_menu *menu, struct iterate_kit_menu_context context);

/**
 * Keep the cursor on the item it was on, now that the context has changed.
 *
 * Called when a call starts or ends with the menu open, which moves HANG UP in
 * or out of the list underneath the cursor. Without this, a call ending while
 * the cursor sat on "new conversation" would leave it on "reboot" — the same
 * index, one item along — and the next press of TALK would restart
 * the device somebody was trying to talk to.
 *
 * An item that no longer exists puts the cursor back on CLOSE, because the
 * alternative is guessing which of the remaining items the person meant.
 */
void iterate_kit_menu_recontext(
    struct iterate_kit_menu *menu,
    struct iterate_kit_menu_context was,
    struct iterate_kit_menu_context now);

/**
 * Reopen the menu with the cursor on `item`, for an action meant to be repeated.
 *
 * "Next face" is the case this exists for: it changes the thing you are looking
 * at while you are looking at it, so closing the menu each time would make
 * trying five faces fifteen presses instead of five. An item this context does
 * not offer puts the cursor on CLOSE, the same rule recontext follows.
 *
 * Every other action closes, and should: they start conversations, end them, or
 * reboot, and none of those leave you wanting to choose again.
 */
void iterate_kit_menu_reopen_on(
    struct iterate_kit_menu *menu,
    struct iterate_kit_menu_context context,
    enum iterate_kit_menu_item item);

/**
 * Put the menu away because something else took the screen.
 *
 * Called by whoever owns that something rather than inferred here: this module
 * cannot see a call or an image, and guessing would put the menu's correctness
 * at the mercy of what else happens to be true.
 */
void iterate_kit_menu_close(struct iterate_kit_menu *menu);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_DEVICE_MENU_H */
