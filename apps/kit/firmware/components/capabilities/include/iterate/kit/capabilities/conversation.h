#ifndef ITERATE_KIT_CAPABILITIES_CONVERSATION_H
#define ITERATE_KIT_CAPABILITIES_CONVERSATION_H

#include "iterate/kit/device_events.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Remote control for one device conversation lifecycle. Dispatch only
 * publishes into the same bounded owner-task queue as the physical button;
 * socket and audio work never occurs inside a Cap'n Web call.
 */
struct iterate_kit_conversation {
  struct iterate_kit_device_event_queue *events;
  bool initialized;
};

enum iterate_kit_status iterate_kit_conversation_init(
    struct iterate_kit_conversation *conversation,
    struct iterate_kit_device_event_queue *events);
struct iterate_kit_module iterate_kit_conversation_module(
    struct iterate_kit_conversation *conversation);

#ifdef __cplusplus
}
#endif

#endif
