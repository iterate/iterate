#include "iterate/kit/session_grammar.h"
#include "iterate/kit/touch_tap.h"
#include <assert.h>

static struct iterate_kit_session_actions step(struct iterate_kit_session *s,
                                               bool press, bool wants, bool active) {
  struct iterate_kit_session_actions a;
  const struct iterate_kit_session_poll p = {.press = press, .wants_call = wants, .call_active = active};
  iterate_kit_session_step(s, &p, &a);
  return a;
}

static void a_touch_bounce_cannot_end_its_new_session(void) {
  struct iterate_kit_touch_tap tap;
  struct iterate_kit_session session = {0};
  struct iterate_kit_session_actions actions;
  iterate_kit_touch_tap_init(&tap, false);

  actions = step(
      &session, iterate_kit_touch_tap_update(&tap, true, 0U), false, false);
  assert(actions.start_call && !actions.end_call);
  actions = step(
      &session, iterate_kit_touch_tap_update(&tap, false, 20U), true, true);
  assert(!actions.end_call);
  actions = step(
      &session, iterate_kit_touch_tap_update(&tap, true, 30U), true, true);
  assert(!actions.end_call);
}

int main(void) {
  struct iterate_kit_session s = {0};
  struct iterate_kit_session_actions a = step(&s, true, false, false);
  assert(a.start_call && a.wake_chime && !a.end_call);
  /* A held/released first press has no second edge and cannot end the call. */
  a = step(&s, false, true, true); assert(!a.end_call);
  a = step(&s, false, true, true); assert(!a.end_call);
  /* The next down edge ends immediately. */
  a = step(&s, true, true, true); assert(a.end_call);
  a = step(&s, false, false, false); assert(a.end_chime);
  a_touch_bounce_cannot_end_its_new_session();
  return 0;
}
