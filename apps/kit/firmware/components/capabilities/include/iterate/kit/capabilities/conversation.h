#ifndef ITERATE_KIT_CAPABILITIES_CONVERSATION_H
#define ITERATE_KIT_CAPABILITIES_CONVERSATION_H

#include "iterate/kit/peer.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * `conversation.start()` and `conversation.end()`: the remote press. Each call
 * sets one latch, and the voice loop takes both on its next pass as the
 * `start_call` / `end_call` edges the session grammar gives a physical press
 * (iterate/kit/session_grammar.h), so a remote and a physical control are one
 * path. Dispatch and the loop both run on the app task, so the latches need no
 * atomics. The latches keep no order: an end and a start that land in the same
 * pass are a restart, whichever came first, so a caller that means "end" awaits
 * its start() before it ends. A `true` answer means the edge was latched, not
 * that a call exists: call state is the loop's, and `health()` reports it.
 */
struct iterate_kit_conversation_control {
  bool start_call;
  bool end_call;
};

struct iterate_kit_module iterate_kit_conversation_control_module(
    struct iterate_kit_conversation_control *conversation);

#ifdef __cplusplus
}
#endif

#endif
