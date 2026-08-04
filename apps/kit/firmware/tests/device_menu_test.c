#include "iterate/kit/device_menu.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * Two buttons, one menu, and two contexts. Everything below is about the seams:
 * between what a button means with the menu open and closed, and between the
 * item list during a call and the item list without one.
 */

static const struct iterate_kit_menu_context IDLE = {
  .call_active = false,
  .new_conversation_available = true,
  .next_sprite_available = true,
  .reboot_available = true,
};
static const struct iterate_kit_menu_context IN_CALL = {
  .call_active = true,
  .new_conversation_available = true,
  .next_sprite_available = true,
  .reboot_available = true,
};

/*
 * The menu is an action projection, not a wish list. A small endpoint without
 * stream creation or selectable sprites must never lead somebody through an
 * item that can only fail after activation.
 */
static void unavailable_endpoint_actions_are_not_offered(void)
{
  const struct iterate_kit_menu_context minimal = {
    .call_active = false,
    .new_conversation_available = false,
    .next_sprite_available = false,
    .reboot_available = false,
  };

  assert(iterate_kit_menu_item_count(minimal) == 2U);
  assert(iterate_kit_menu_item_at(minimal, 0U) == ITERATE_KIT_MENU_CLOSE);
  assert(iterate_kit_menu_item_at(minimal, 1U) ==
         ITERATE_KIT_MENU_START_CALL);
  assert(iterate_kit_menu_item_at(minimal, 2U) ==
         ITERATE_KIT_MENU_ITEM_COUNT);
}

/* The first press opens ON the first item, not past it. */
static void the_first_press_opens_at_the_top(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  assert(!menu.open);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(menu.open);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_CLOSE);
}

/*
 * Two buttons cannot express "back", so a person who overshoots must be able
 * to keep going rather than be stuck at the bottom. It wraps at the length of
 * THIS context's list, which is why the count is asked for rather than assumed.
 */
static void the_cursor_wraps_rather_than_stopping(void)
{
  struct iterate_kit_menu menu;
  uint8_t index;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE); /* opens at CLOSE */
  for (index = 0U; index < iterate_kit_menu_item_count(IDLE); ++index) {
    iterate_kit_menu_cycle(&menu, IDLE);
  }
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_CLOSE);

  /* And the in-call list wraps at its own length, which today is the same
   * length — the wrap must come from the count, not from a constant. */
  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  for (index = 0U; index < iterate_kit_menu_item_count(IN_CALL); ++index) {
    iterate_kit_menu_cycle(&menu, IN_CALL);
  }
  assert(iterate_kit_menu_item_at(IN_CALL, menu.selected) ==
         ITERATE_KIT_MENU_CLOSE);
}

/*
 * THE CALL ITEM IS WHICHEVER ONE WOULD DO SOMETHING.
 *
 * "Start call" during a call and "hang up" without one are both items that do
 * nothing, and an item that does nothing is worse than no item: it teaches the
 * person that pressing things does not work. So exactly one of the pair is
 * offered, which is also why the two contexts have the same item COUNT — a
 * property worth pinning, because it is what stops the cursor's index meaning
 * two different things at two different times for the items after it.
 */
static void the_call_item_is_whichever_one_would_do_something(void)
{
  uint8_t index;
  bool idle_offers_hang_up = false;
  bool in_call_offers_start = false;

  assert(iterate_kit_menu_item_count(IDLE) ==
         iterate_kit_menu_item_count(IN_CALL));
  for (index = 0U; index < iterate_kit_menu_item_count(IDLE); ++index) {
    if (iterate_kit_menu_item_at(IDLE, index) == ITERATE_KIT_MENU_HANG_UP) {
      idle_offers_hang_up = true;
    }
    if (iterate_kit_menu_item_at(IN_CALL, index) ==
        ITERATE_KIT_MENU_START_CALL) {
      in_call_offers_start = true;
    }
  }
  assert(!idle_offers_hang_up);
  assert(!in_call_offers_start);
  /* Same position, opposite meaning. */
  assert(iterate_kit_menu_item_at(IDLE, 1U) == ITERATE_KIT_MENU_START_CALL);
  assert(iterate_kit_menu_item_at(IN_CALL, 1U) == ITERATE_KIT_MENU_HANG_UP);
  /* Past the end is not an item, in either context. */
  assert(iterate_kit_menu_item_at(IDLE, iterate_kit_menu_item_count(IDLE)) ==
         ITERATE_KIT_MENU_ITEM_COUNT);
}

/* Every item is reachable, in the order it is drawn. */
static void every_item_can_be_chosen(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_CLOSE);

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_START_CALL);

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_NEW);

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_NEXT_SPRITE);

  /* REBOOT stays last, whatever is inserted above it. */
  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_REBOOT);

  /* During a call the same two presses reach hanging up instead. */
  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  assert(iterate_kit_menu_activate(&menu, IN_CALL) ==
         ITERATE_KIT_MENU_ACTION_HANG_UP);
}

/*
 * THE SEAM THAT MATTERS. The upper button starts a call with the menu closed
 * and chooses an item with it open. A closed menu must therefore report NONE,
 * so the caller can hand the press to whatever owns the button otherwise — and
 * a menu that claimed a press it had no business claiming would make calling
 * impossible.
 */
static void a_closed_menu_claims_nothing(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_NONE);
  assert(iterate_kit_menu_activate(NULL, IDLE) ==
         ITERATE_KIT_MENU_ACTION_NONE);
}

/*
 * Activating closes — including CLOSE, whose whole job that is. A menu still on
 * screen afterwards describes a device that no longer exists, and worse, the
 * NEXT press of the upper button would choose again.
 */
static void activating_closes_the_menu(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_CLOSE);
  assert(!menu.open);
  /* And the press after it belongs to whoever owns the button now. */
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_NONE);
}

/*
 * A CALL ENDING MUST NOT MOVE THE CURSOR ONTO ANOTHER ITEM.
 *
 * During a call the list is CLOSE, HANG UP, NEW, REBOOT; without one it is
 * CLOSE, START CALL, NEW, REBOOT. The cursor follows the ITEM across that
 * change, not the index — which is the rule this pins even where the two
 * happen to agree. See the note at the end of the case.
 */
static void a_call_ending_keeps_the_cursor_on_its_item(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  assert(iterate_kit_menu_item_at(IN_CALL, menu.selected) ==
         ITERATE_KIT_MENU_NEW);

  iterate_kit_menu_recontext(&menu, IN_CALL, IDLE);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_NEW);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_NEW);
  /*
   * NEW happens to sit at the same index in both contexts now that the call
   * pair are mutually exclusive, so this case passes even without recontext.
   * It is kept because that coincidence is a property of today's item list, not
   * a guarantee — a fifth item offered in one context and not the other brings
   * the sliding straight back.
   */
}

/*
 * And the item that disappeared takes the cursor back to CLOSE rather than to
 * whatever now occupies its index — which for hanging up is the sharpest case
 * on this device: index 1 becomes START CALL, so a cursor left where it was
 * would turn "end this call" into "start another one" at the same press. A
 * person about to hang up a call that has already ended has got what they
 * wanted; the safe item is the one that changes nothing.
 */
static void a_vanished_item_returns_the_cursor_to_close(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  assert(iterate_kit_menu_item_at(IN_CALL, menu.selected) ==
         ITERATE_KIT_MENU_HANG_UP);

  iterate_kit_menu_recontext(&menu, IN_CALL, IDLE);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_CLOSE);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_CLOSE);
}

/*
 * A call STARTING under an open menu inserts hang up at index 1, so a cursor
 * on "new conversation" would slide onto "reboot" the same way.
 */
static void a_call_starting_keeps_the_cursor_on_its_item(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_NEW);

  iterate_kit_menu_recontext(&menu, IDLE, IN_CALL);
  assert(iterate_kit_menu_item_at(IN_CALL, menu.selected) ==
         ITERATE_KIT_MENU_NEW);

  /*
   * And the mirror of the vanishing case, which a device can really reach: the
   * cursor is on START CALL when a call arrives from somewhere else — the
   * capability, or the upper button — so the item under it stops existing. Back
   * to CLOSE, not on to HANG UP, because ending a call is not what somebody who
   * asked to start one meant.
   */
  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_START_CALL);
  iterate_kit_menu_recontext(&menu, IDLE, IN_CALL);
  assert(iterate_kit_menu_item_at(IN_CALL, menu.selected) ==
         ITERATE_KIT_MENU_CLOSE);
}

/*
 * Something else taking the screen puts the menu away. An image overlay covers
 * it completely, and a menu that was still open underneath would take the next
 * press of the upper button as a choice nobody could see themselves making.
 */
static void closing_puts_the_menu_away(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  iterate_kit_menu_cycle(&menu, IN_CALL);
  assert(menu.open);
  iterate_kit_menu_close(&menu);
  assert(!menu.open);
  assert(menu.selected == 0U);
  assert(iterate_kit_menu_activate(&menu, IN_CALL) ==
         ITERATE_KIT_MENU_ACTION_NONE);
}

/* Reopening starts at the top rather than where it was left. */
static void reopening_starts_at_the_top(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE); /* NEW */
  iterate_kit_menu_close(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_CLOSE);
}

static void items_have_names_and_null_is_survivable(void)
{
  struct iterate_kit_menu menu;

  assert(strcmp(iterate_kit_menu_item_name(ITERATE_KIT_MENU_CLOSE),
                "close menu") == 0);
  assert(strcmp(iterate_kit_menu_item_name(ITERATE_KIT_MENU_HANG_UP),
                "hang up") == 0);
  assert(strcmp(iterate_kit_menu_item_name(ITERATE_KIT_MENU_NEW),
                "new conversation") == 0);
  assert(strcmp(iterate_kit_menu_item_name(ITERATE_KIT_MENU_NEXT_SPRITE),
                "next face") == 0);
  assert(strcmp(iterate_kit_menu_item_name(ITERATE_KIT_MENU_REBOOT),
                "reboot") == 0);
  iterate_kit_menu_reset(NULL);
  iterate_kit_menu_cycle(NULL, IDLE);
  iterate_kit_menu_recontext(NULL, IDLE, IN_CALL);
  iterate_kit_menu_close(NULL);
  /* And a live menu is untouched by any of that. */
  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(menu.open);
}

/*
 * AN ACTION MEANT TO BE REPEATED LEAVES THE MENU WHERE IT WAS.
 *
 * "Next face" is chosen over and over — it is how a person finds the one they
 * like — so unlike every other action it reopens with the cursor still on it.
 * Getting this wrong is not a crash: it is a menu that shuts on every press and
 * makes trying five faces fifteen presses.
 */
static void a_repeatable_action_reopens_where_it_was(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  iterate_kit_menu_cycle(&menu, IDLE);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_NEXT_SPRITE);
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_NEXT_SPRITE);
  /* Activating closed it, as it does for everything. */
  assert(!menu.open);

  iterate_kit_menu_reopen_on(&menu, IDLE, ITERATE_KIT_MENU_NEXT_SPRITE);
  assert(menu.open);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_NEXT_SPRITE);
  /* So the very next press of the upper button is the next face again. */
  assert(iterate_kit_menu_activate(&menu, IDLE) ==
         ITERATE_KIT_MENU_ACTION_NEXT_SPRITE);

  /* An item this context does not offer lands on CLOSE, never out of range. */
  iterate_kit_menu_reopen_on(&menu, IDLE, ITERATE_KIT_MENU_HANG_UP);
  assert(menu.open);
  assert(iterate_kit_menu_item_at(IDLE, menu.selected) ==
         ITERATE_KIT_MENU_CLOSE);
  iterate_kit_menu_reopen_on(NULL, IDLE, ITERATE_KIT_MENU_CLOSE);
}

int main(void)
{
  unavailable_endpoint_actions_are_not_offered();
  the_first_press_opens_at_the_top();
  the_cursor_wraps_rather_than_stopping();
  the_call_item_is_whichever_one_would_do_something();
  every_item_can_be_chosen();
  a_closed_menu_claims_nothing();
  activating_closes_the_menu();
  a_call_ending_keeps_the_cursor_on_its_item();
  a_vanished_item_returns_the_cursor_to_close();
  a_call_starting_keeps_the_cursor_on_its_item();
  closing_puts_the_menu_away();
  reopening_starts_at_the_top();
  a_repeatable_action_reopens_where_it_was();
  items_have_names_and_null_is_survivable();
  printf("device_menu_test ok\n");
  return 0;
}
