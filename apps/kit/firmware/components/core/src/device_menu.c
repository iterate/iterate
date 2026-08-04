/* The two-button menu described in device_menu.h, and nothing else. */

#include "iterate/kit/device_menu.h"

#include <stddef.h>

/*
 * Every item, in screen order. The list a given context offers is this one
 * minus what that context withholds — declared in one place so that "the order
 * on screen" and "the order the cursor moves through" cannot come apart.
 */
static const enum iterate_kit_menu_item MENU_ORDER[] = {
    ITERATE_KIT_MENU_CLOSE,
    ITERATE_KIT_MENU_START_CALL,
    ITERATE_KIT_MENU_HANG_UP,
    ITERATE_KIT_MENU_NEW,
    ITERATE_KIT_MENU_NEXT_SPRITE,
    ITERATE_KIT_MENU_REBOOT,
};

_Static_assert(
    sizeof(MENU_ORDER) / sizeof(MENU_ORDER[0]) ==
        (size_t)ITERATE_KIT_MENU_ITEM_COUNT,
    "every item must appear exactly once in the on-screen order");

/**
 * Whether this context offers this item.
 *
 * The call pair are the only conditional ones, and they are exact opposites:
 * offering "hang up" with no call, or "start call" during one, would be an item
 * that does nothing — and withholding either in its own context would leave no
 * way to do the thing.
 */
static bool offered(
    enum iterate_kit_menu_item item,
    struct iterate_kit_menu_context context) {
  if (item == ITERATE_KIT_MENU_HANG_UP) {
    return context.call_active;
  }
  if (item == ITERATE_KIT_MENU_START_CALL) {
    return !context.call_active;
  }
  if (item == ITERATE_KIT_MENU_NEW) {
    return context.new_conversation_available;
  }
  if (item == ITERATE_KIT_MENU_NEXT_SPRITE) {
    return context.next_sprite_available;
  }
  if (item == ITERATE_KIT_MENU_REBOOT) {
    return context.reboot_available;
  }
  return true;
}

uint8_t iterate_kit_menu_item_count(struct iterate_kit_menu_context context) {
  uint8_t count = 0U;
  size_t index;
  for (index = 0U; index < (size_t)ITERATE_KIT_MENU_ITEM_COUNT; ++index) {
    if (offered(MENU_ORDER[index], context)) {
      count++;
    }
  }
  return count;
}

enum iterate_kit_menu_item iterate_kit_menu_item_at(
    struct iterate_kit_menu_context context, uint8_t index) {
  uint8_t seen = 0U;
  size_t at;
  for (at = 0U; at < (size_t)ITERATE_KIT_MENU_ITEM_COUNT; ++at) {
    if (!offered(MENU_ORDER[at], context)) {
      continue;
    }
    if (seen == index) {
      return MENU_ORDER[at];
    }
    seen++;
  }
  return ITERATE_KIT_MENU_ITEM_COUNT;
}

const char *iterate_kit_menu_item_name(enum iterate_kit_menu_item item) {
  switch (item) {
    case ITERATE_KIT_MENU_CLOSE:
      return "close menu";
    case ITERATE_KIT_MENU_START_CALL:
      return "start call";
    case ITERATE_KIT_MENU_HANG_UP:
      return "hang up";
    case ITERATE_KIT_MENU_NEW:
      return "new conversation";
    case ITERATE_KIT_MENU_NEXT_SPRITE:
      return "next face";
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

void iterate_kit_menu_cycle(
    struct iterate_kit_menu *menu, struct iterate_kit_menu_context context) {
  const uint8_t count = iterate_kit_menu_item_count(context);
  if (menu == NULL || count == 0U) {
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
  menu->selected = (uint8_t)((menu->selected + 1U) % count);
}

enum iterate_kit_menu_action iterate_kit_menu_activate(
    struct iterate_kit_menu *menu, struct iterate_kit_menu_context context) {
  enum iterate_kit_menu_item item;
  if (menu == NULL || !menu->open) {
    return ITERATE_KIT_MENU_ACTION_NONE;
  }
  item = iterate_kit_menu_item_at(context, menu->selected);
  iterate_kit_menu_reset(menu);
  switch (item) {
    case ITERATE_KIT_MENU_CLOSE:
      return ITERATE_KIT_MENU_ACTION_CLOSE;
    case ITERATE_KIT_MENU_START_CALL:
      return ITERATE_KIT_MENU_ACTION_START_CALL;
    case ITERATE_KIT_MENU_HANG_UP:
      return ITERATE_KIT_MENU_ACTION_HANG_UP;
    case ITERATE_KIT_MENU_NEW:
      return ITERATE_KIT_MENU_ACTION_NEW;
    case ITERATE_KIT_MENU_NEXT_SPRITE:
      return ITERATE_KIT_MENU_ACTION_NEXT_SPRITE;
    case ITERATE_KIT_MENU_REBOOT:
      return ITERATE_KIT_MENU_ACTION_REBOOT;
    case ITERATE_KIT_MENU_ITEM_COUNT:
    default:
      /*
       * The cursor pointed at nothing, which cycle() cannot produce. Answered
       * anyway: a menu whose state has been corrupted must not reboot a device
       * or end a call nobody chose.
       */
      return ITERATE_KIT_MENU_ACTION_NONE;
  }
}

void iterate_kit_menu_recontext(
    struct iterate_kit_menu *menu,
    struct iterate_kit_menu_context was,
    struct iterate_kit_menu_context now) {
  enum iterate_kit_menu_item item;
  uint8_t index;

  if (menu == NULL) {
    return;
  }
  item = iterate_kit_menu_item_at(was, menu->selected);
  /* The cursor followed the ITEM, so find where that item is now. */
  for (index = 0U; index < (uint8_t)ITERATE_KIT_MENU_ITEM_COUNT; ++index) {
    const enum iterate_kit_menu_item candidate =
        iterate_kit_menu_item_at(now, index);
    if (candidate == ITERATE_KIT_MENU_ITEM_COUNT) {
      break;
    }
    if (candidate == item) {
      menu->selected = index;
      return;
    }
  }
  /* It is not offered any more — back to close, which changes nothing. */
  menu->selected = 0U;
}

void iterate_kit_menu_reopen_on(
    struct iterate_kit_menu *menu,
    struct iterate_kit_menu_context context,
    enum iterate_kit_menu_item item) {
  uint8_t index;

  if (menu == NULL) {
    return;
  }
  menu->open = true;
  menu->selected = 0U;
  for (index = 0U; index < (uint8_t)ITERATE_KIT_MENU_ITEM_COUNT; ++index) {
    const enum iterate_kit_menu_item candidate =
        iterate_kit_menu_item_at(context, index);
    if (candidate == ITERATE_KIT_MENU_ITEM_COUNT) {
      return;
    }
    if (candidate == item) {
      menu->selected = index;
      return;
    }
  }
}

void iterate_kit_menu_close(struct iterate_kit_menu *menu) {
  iterate_kit_menu_reset(menu);
}
