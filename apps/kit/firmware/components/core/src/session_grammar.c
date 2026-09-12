#include "iterate/kit/session_grammar.h"

#include <string.h>

void iterate_kit_session_step(struct iterate_kit_session *session,
                              const struct iterate_kit_session_poll *poll,
                              struct iterate_kit_session_actions *out) {
  const bool in_session = poll->wants_call || poll->call_active;
  memset(out, 0, sizeof(*out));
  out->end_chime = session->was_in_session && !in_session;
  session->was_in_session = in_session;
  if (!in_session) {
    if (poll->press) out->start_call = out->wake_chime = true;
    return;
  }
  if (poll->end_press || poll->press) {
    out->end_call = true;
  }
}
