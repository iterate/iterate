#include "stackchan_modes.h"

#include <stddef.h>

/*
 * The wire contract: each row is a stream whose far end is already
 * configured for exactly that provider, server VAD, open microphone. The
 * OpenAI row must stay equal to `facts.stream_path` in stackchan_device.c —
 * it is the path the board dials before NVS has ever stored a choice.
 */
static const char *const mode_streams[STACKCHAN_MODE_COUNT] = {
  [STACKCHAN_MODE_GROK] = "/agents/voice/stackchan-grok",
  [STACKCHAN_MODE_OPENAI] = "/agents/voice/stackchan",
};

const char *stackchan_mode_stream_path(uint8_t mode) {
  if (mode >= STACKCHAN_MODE_COUNT) return NULL;
  return mode_streams[mode];
}

bool stackchan_menu_step(
    struct stackchan_menu *menu,
    const struct stackchan_menu_poll *poll,
    uint8_t *pick) {
  *pick = STACKCHAN_MENU_NO_PICK;
  /*
   * The wheel-cancel rule: a call in play closes the menu and eats the tap.
   * Re-pointing the stream underneath a call being placed would strand it,
   * and holding the choice until the call ends would change the provider
   * minutes later as a complete surprise. Neither; the tap just did not
   * happen.
   */
  if (poll->call_in_play) {
    menu->open = false;
    return false;
  }
  if (menu->open &&
      poll->now_ms - menu->opened_at_ms >= STACKCHAN_MENU_TIMEOUT_MS) {
    menu->open = false;
  }
  if (!poll->tap) return menu->open;
  if (!menu->open) {
    menu->open = true;
    menu->opened_at_ms = poll->now_ms;
    return true;
  }
  *pick = poll->tap_left_half ? STACKCHAN_MODE_GROK : STACKCHAN_MODE_OPENAI;
  menu->open = false;
  return false;
}
