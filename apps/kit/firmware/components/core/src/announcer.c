#include "iterate/kit/announcer.h"

#include <stddef.h>

static const struct {
  const char *text;
  const char *script;
} phrases[ITERATE_KIT_ANNOUNCEMENT_COUNT] = {
    [ITERATE_KIT_ANNOUNCEMENT_NONE] = {"", ""},
    [ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_WIFI] = {
        "Connecting to Wi-Fi.", "k ax n eh1 k t ih ng t uw w ay1 f ay2 ."},
    [ITERATE_KIT_ANNOUNCEMENT_WIFI_PASSWORD_REJECTED] = {
        "Wi-Fi password didn't work.", "w ay1 f ay2 p ae1 s w er d d ih1 d ax n t w er1 k ."},
    [ITERATE_KIT_ANNOUNCEMENT_WIFI_NOT_FOUND] = {
        "Can't find the Wi-Fi network.", "k ae1 n t f ay1 n d dh ax w ay1 f ay2 n eh1 t w er2 k ."},
    [ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_ITERATE] = {
        "Connecting to iterate.", "k ax n eh1 k t ih ng t uw ih1 t ax r ey2 t ."},
    [ITERATE_KIT_ANNOUNCEMENT_ITERATE_UNREACHABLE] = {
        "Can't reach iterate. Still trying.",
        "k ae1 n t r iy1 ch ih1 t ax r ey2 t . s t ih1 l t r ay1 ih ng ."},
    [ITERATE_KIT_ANNOUNCEMENT_KEY_REFUSED] = {
        "Iterate refused my key. Please set me up again.",
        "ih1 t ax r ey2 t r ih f y uw1 z d m ay k iy1 . p l iy1 z s eh1 t m iy ah1 p ax g eh1 n ."},
    [ITERATE_KIT_ANNOUNCEMENT_READY] = {"Ready.", "r eh1 d iy ."},
    [ITERATE_KIT_ANNOUNCEMENT_HELLO] = {"Hello!", "hh ax l ow1 ."},
};

static uint32_t bit(enum iterate_kit_announcement announcement) {
  return UINT32_C(1) << (unsigned)announcement;
}

void iterate_kit_announcer_init(
    struct iterate_kit_announcer *announcer, bool narrate, uint64_t now_ms) {
  *announcer = (struct iterate_kit_announcer){
      .narrating = narrate,
      .narration_ends_at_ms = now_ms + ITERATE_KIT_ANNOUNCER_NARRATION_MS,
      .state = ITERATE_KIT_ANNOUNCEMENT_NONE,
      .state_since_ms = now_ms,
      .wifi_joined_at_ms = now_ms,
  };
}

/* The connection state as a phrase. The key outranks everything: nothing else mends it. */
static enum iterate_kit_announcement connection_state(
    const struct iterate_kit_announcer *announcer,
    const struct iterate_kit_announcer_input *input) {
  if (input->key_refused) return ITERATE_KIT_ANNOUNCEMENT_KEY_REFUSED;
  if (input->connected) return ITERATE_KIT_ANNOUNCEMENT_READY;
  switch (input->wifi) {
    case ITERATE_KIT_WIFI_WRONG_PASSWORD:
      return ITERATE_KIT_ANNOUNCEMENT_WIFI_PASSWORD_REJECTED;
    case ITERATE_KIT_WIFI_NOT_FOUND:
      return ITERATE_KIT_ANNOUNCEMENT_WIFI_NOT_FOUND;
    case ITERATE_KIT_WIFI_JOINING:
      return ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_WIFI;
    case ITERATE_KIT_WIFI_JOINED:
      break;
  }
  return input->now_ms - announcer->wifi_joined_at_ms >= ITERATE_KIT_ANNOUNCER_UNREACHABLE_AFTER_MS
             ? ITERATE_KIT_ANNOUNCEMENT_ITERATE_UNREACHABLE
             : ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_ITERATE;
}

void iterate_kit_announcer_step(
    struct iterate_kit_announcer *announcer,
    const struct iterate_kit_announcer_input *input) {
  const bool joined = input->wifi == ITERATE_KIT_WIFI_JOINED;
  if (joined && !announcer->wifi_was_joined) announcer->wifi_joined_at_ms = input->now_ms;
  announcer->wifi_was_joined = joined;

  const enum iterate_kit_announcement state = connection_state(announcer, input);
  if (state != announcer->state) {
    announcer->state = state;
    announcer->state_since_ms = input->now_ms;
  }

  if (announcer->narrating && input->now_ms >= announcer->narration_ends_at_ms) {
    announcer->narrating = false;
  }
  /* "Ready." ends the story, so it does not wait to settle. */
  const bool settled = input->now_ms - announcer->state_since_ms >= ITERATE_KIT_ANNOUNCER_SETTLE_MS ||
                       state == ITERATE_KIT_ANNOUNCEMENT_READY;
  if (announcer->narrating && settled && (announcer->narrated & bit(state)) == 0U) {
    announcer->narrated |= bit(state);
    announcer->pending = state;
    if (state == ITERATE_KIT_ANNOUNCEMENT_READY) announcer->narrating = false;
  }

  /* Someone asked for the board: answer now, whatever the narration did. */
  if (input->woken) {
    announcer->pending = input->connected ? ITERATE_KIT_ANNOUNCEMENT_HELLO : state;
  } else if (input->pressed && !input->connected) {
    announcer->pending = state;
  }
}

enum iterate_kit_announcement iterate_kit_announcer_take(
    struct iterate_kit_announcer *announcer) {
  const enum iterate_kit_announcement pending = announcer->pending;
  announcer->pending = ITERATE_KIT_ANNOUNCEMENT_NONE;
  return pending;
}

const char *iterate_kit_announcement_script(enum iterate_kit_announcement announcement) {
  return (size_t)announcement < ITERATE_KIT_ANNOUNCEMENT_COUNT ? phrases[announcement].script : "";
}

const char *iterate_kit_announcement_text(enum iterate_kit_announcement announcement) {
  return (size_t)announcement < ITERATE_KIT_ANNOUNCEMENT_COUNT ? phrases[announcement].text : "";
}
