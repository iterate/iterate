#include "iterate/kit/device_menu.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * Two buttons, and the whole difficulty is that both already mean something
 * during a call. Everything below is about the seams between those meanings.
 */

/* The first press opens ON the first item, not past it. */
static void the_first_press_opens_at_the_top(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  assert(!menu.open);
  iterate_kit_menu_cycle(&menu);
  assert(menu.open);
  assert(menu.selected == ITERATE_KIT_MENU_CONTINUE);
}

/*
 * Two buttons cannot express "back", so a person who overshoots must be able
 * to keep going rather than be stuck at the bottom.
 */
static void the_cursor_wraps_rather_than_stopping(void)
{
  struct iterate_kit_menu menu;
  uint8_t index;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu); /* opens at CONTINUE */
  for (index = 0U; index < ITERATE_KIT_MENU_ITEM_COUNT; ++index) {
    iterate_kit_menu_cycle(&menu);
  }
  assert(menu.selected == ITERATE_KIT_MENU_CONTINUE);
}

/* Every item is reachable, in the order it is drawn. */
static void every_item_can_be_chosen(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu);
  assert(iterate_kit_menu_activate(&menu) == ITERATE_KIT_MENU_ACTION_CONTINUE);

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu);
  iterate_kit_menu_cycle(&menu);
  assert(iterate_kit_menu_activate(&menu) == ITERATE_KIT_MENU_ACTION_NEW);

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu);
  iterate_kit_menu_cycle(&menu);
  iterate_kit_menu_cycle(&menu);
  assert(iterate_kit_menu_activate(&menu) == ITERATE_KIT_MENU_ACTION_REBOOT);
}

/*
 * THE SEAM THAT MATTERS. The upper button hangs up during a call and chooses
 * an item between calls. A closed menu must therefore report NONE, so the
 * caller can hand the press to whatever owns the button otherwise — and a
 * menu that claimed a press it had no business claiming would make the
 * hang-up button dead.
 */
static void a_closed_menu_claims_nothing(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  assert(iterate_kit_menu_activate(&menu) == ITERATE_KIT_MENU_ACTION_NONE);
  assert(iterate_kit_menu_activate(NULL) == ITERATE_KIT_MENU_ACTION_NONE);
}

/*
 * Activating closes. Every action either starts a conversation or reboots, so
 * a menu still on screen afterwards describes a device that no longer exists —
 * and worse, the NEXT press of the upper button would choose again.
 */
static void activating_closes_the_menu(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu);
  assert(iterate_kit_menu_activate(&menu) == ITERATE_KIT_MENU_ACTION_CONTINUE);
  assert(!menu.open);
  /* And the press after it belongs to whoever owns the button now. */
  assert(iterate_kit_menu_activate(&menu) == ITERATE_KIT_MENU_ACTION_NONE);
}

/*
 * A call starting takes the buttons back. Without this the menu would still be
 * open underneath a live conversation, and the first press of the lower button
 * would move a cursor instead of opening the microphone.
 */
static void a_call_takes_the_buttons_back(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu);
  iterate_kit_menu_cycle(&menu);
  assert(menu.open);
  iterate_kit_menu_close(&menu);
  assert(!menu.open);
  assert(menu.selected == ITERATE_KIT_MENU_CONTINUE);
  assert(iterate_kit_menu_activate(&menu) == ITERATE_KIT_MENU_ACTION_NONE);
}

/* Reopening starts at the top rather than where it was left. */
static void reopening_starts_at_the_top(void)
{
  struct iterate_kit_menu menu;

  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu);
  iterate_kit_menu_cycle(&menu); /* NEW */
  iterate_kit_menu_close(&menu);
  iterate_kit_menu_cycle(&menu);
  assert(menu.selected == ITERATE_KIT_MENU_CONTINUE);
}

static void items_have_names_and_null_is_survivable(void)
{
  struct iterate_kit_menu menu;

  assert(strcmp(iterate_kit_menu_item_name(ITERATE_KIT_MENU_NEW),
                "new conversation") == 0);
  assert(strcmp(iterate_kit_menu_item_name(ITERATE_KIT_MENU_REBOOT),
                "reboot") == 0);
  iterate_kit_menu_reset(NULL);
  iterate_kit_menu_cycle(NULL);
  iterate_kit_menu_close(NULL);
  /* And a live menu is untouched by any of that. */
  iterate_kit_menu_reset(&menu);
  iterate_kit_menu_cycle(&menu);
  assert(menu.open);
}

int main(void)
{
  the_first_press_opens_at_the_top();
  the_cursor_wraps_rather_than_stopping();
  every_item_can_be_chosen();
  a_closed_menu_claims_nothing();
  activating_closes_the_menu();
  a_call_takes_the_buttons_back();
  reopening_starts_at_the_top();
  items_have_names_and_null_is_survivable();
  printf("device_menu_test ok\n");
  return 0;
}
