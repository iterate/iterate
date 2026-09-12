#ifndef ITERATE_KIT_SESSION_GRAMMAR_H
#define ITERATE_KIT_SESSION_GRAMMAR_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Every board has the same call control: a press starts an idle call; the
 * next press ends an established call. The loop owns continuous capture. */
struct iterate_kit_session {
  bool was_in_session;
};

struct iterate_kit_session_poll {
  bool press;
  bool end_press;
  bool wants_call;
  bool call_active;
};

struct iterate_kit_session_actions {
  bool start_call;
  bool end_call;
  bool wake_chime;
  bool end_chime;
};

void iterate_kit_session_step(struct iterate_kit_session *session,
                              const struct iterate_kit_session_poll *poll,
                              struct iterate_kit_session_actions *out);

#ifdef __cplusplus
}
#endif
#endif
