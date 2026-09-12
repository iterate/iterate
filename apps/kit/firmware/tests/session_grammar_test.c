#include "iterate/kit/session_grammar.h"
#include <assert.h>

static struct iterate_kit_session_actions step(struct iterate_kit_session *s,
                                               bool press, bool wants, bool active) {
  struct iterate_kit_session_actions a;
  const struct iterate_kit_session_poll p = {.press = press, .wants_call = wants, .call_active = active};
  iterate_kit_session_step(s, &p, &a);
  return a;
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
  return 0;
}
