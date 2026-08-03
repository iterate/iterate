/* The two-button menu described in device_menu.h, and nothing else. */

#include "iterate/kit/device_menu.h"

#include <stddef.h>

const char *iterate_kit_menu_item_name(enum iterate_kit_menu_item item) {
  switch (item) {
    case ITERATE_KIT_MENU_CONTINUE:
      return "continue conversation";
    case ITERATE_KIT_MENU_NEW:
      return "new conversation";
    case ITERATE_KIT_MENU_REBOOT:
      return "reboot";
    case ITERATE_KIT_MENU_ITEM_COUNT:
    default:
      return "unknown";
  }
}

void iterate_kit_menu_reset(struct iterate_kit_menu *menu) {
  if (menu == NULL) {
    return;
  }
  menu->open = false;
  menu->selected = 0U;
}

void iterate_kit_menu_cycle(struct iterate_kit_menu *menu) {
  if (menu == NULL) {
    return;
  }
  /*
   * The first press OPENS on the first item rather than moving to the second.
   * A menu that appears with the cursor already past the top makes the person
   * who wanted the top item go all the way round for it.
   */
  if (!menu->open) {
    menu->open = true;
    menu->selected = 0U;
    return;
  }
  menu->selected = (uint8_t)((menu->selected + 1U) % ITERATE_KIT_MENU_ITEM_COUNT);
}

enum iterate_kit_menu_action iterate_kit_menu_activate(
    struct iterate_kit_menu *menu) {
  enum iterate_kit_menu_item item;
  if (menu == NULL || !menu->open) {
    return ITERATE_KIT_MENU_ACTION_NONE;
  }
  item = (enum iterate_kit_menu_item)menu->selected;
  iterate_kit_menu_reset(menu);
  switch (item) {
    case ITERATE_KIT_MENU_CONTINUE:
      return ITERATE_KIT_MENU_ACTION_CONTINUE;
    case ITERATE_KIT_MENU_NEW:
      return ITERATE_KIT_MENU_ACTION_NEW;
    case ITERATE_KIT_MENU_REBOOT:
      return ITERATE_KIT_MENU_ACTION_REBOOT;
    case ITERATE_KIT_MENU_ITEM_COUNT:
    default:
      /*
       * Unreachable while cycle() owns the cursor, and answered anyway: a
       * menu whose state has been corrupted must not start a conversation
       * nobody chose.
       */
      return ITERATE_KIT_MENU_ACTION_NONE;
  }
}

void iterate_kit_menu_close(struct iterate_kit_menu *menu) {
  iterate_kit_menu_reset(menu);
}
