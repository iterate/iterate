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
 * Remote call control for a device-owned event queue, in exactly the shape
 * of push_to_talk: RPC dispatch only publishes an event, and the device main
 * loop owns the intent transition. This is the same path a physical button
 * or touch tap uses, which keeps remote and local edges ordered — and it is
 * what lets an unattended lab drive a physical conversation proof without a
 * finger on the device.
 */
struct iterate_kit_conversation_control {
  struct iterate_kit_device_event_queue *events;
  bool initialized;
};

enum iterate_kit_status iterate_kit_conversation_control_init(
    struct iterate_kit_conversation_control *conversation,
    struct iterate_kit_device_event_queue *events);
struct iterate_kit_module iterate_kit_conversation_control_module(
    struct iterate_kit_conversation_control *conversation);

#ifdef __cplusplus
}
#endif

#endif
