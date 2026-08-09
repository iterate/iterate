#ifndef ITERATE_KIT_CAPABILITIES_PUSH_TO_TALK_H
#define ITERATE_KIT_CAPABILITIES_PUSH_TO_TALK_H

#include "iterate/kit/device_events.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Remote control surface for a device-owned event queue. RPC dispatch only
 * publishes an event; the device main loop owns all audio and hardware work.
 * This is the same path used by physical button edges, which keeps remote and
 * local state transitions ordered and observable. Queue saturation is returned
 * to the caller rather than blocking Cap'n Web or silently losing an edge.
 *
 * A PRESS IS THE WHOLE REQUEST — it opens the call as well as the microphone,
 * exactly as `ptt-start` does on the stream. There was a `would_be_honoured`
 * driver here that answered a second field, `latched`, because a press with no
 * call up was accepted and then never read: the turn machine gated every use of
 * the talk latch behind `wants_call`, so the caller had to know to call
 * `conversation.start()` first and nothing said so. Ordering knowledge is not
 * something a reply field can fix, and the gate is gone rather than reported —
 * see the collapse in components/voice. With no gate there is nothing for a
 * second field to say, so there is no second field.
 */
struct iterate_kit_push_to_talk {
  struct iterate_kit_device_event_queue *events;
  bool initialized;
};

enum iterate_kit_status iterate_kit_push_to_talk_init(
    struct iterate_kit_push_to_talk *push_to_talk,
    struct iterate_kit_device_event_queue *events);
struct iterate_kit_module iterate_kit_push_to_talk_module(
    struct iterate_kit_push_to_talk *push_to_talk);

#ifdef __cplusplus
}
#endif

#endif
