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
 */

/**
 * Whether a talk request would currently DO anything, asked at reply time.
 *
 * HOLDING THE MICROPHONE OPEN IS MEANINGLESS WITHOUT A CALL, and on a
 * push-to-talk board that is not an error the device can detect later — it is
 * simply a request that gets latched and never read, because the turn machine
 * gates every use of the latch behind `wants_call`. So the truth is available
 * at the instant of the call and nowhere afterwards.
 *
 * Optional. A composition that does not supply it gets the old answer, which
 * is "accepted" and nothing more.
 */
struct iterate_kit_push_to_talk_driver {
  void *context;
  bool (*would_be_honoured)(void *context);
};

struct iterate_kit_push_to_talk {
  struct iterate_kit_device_event_queue *events;
  struct iterate_kit_push_to_talk_driver driver;
  bool initialized;
};

/**
 * `driver` may be NULL, and then `latched` is reported as unknown rather than
 * guessed — see the reply shape at the implementation.
 */
enum iterate_kit_status iterate_kit_push_to_talk_init(
    struct iterate_kit_push_to_talk *push_to_talk,
    struct iterate_kit_device_event_queue *events,
    const struct iterate_kit_push_to_talk_driver *driver);
struct iterate_kit_module iterate_kit_push_to_talk_module(
    struct iterate_kit_push_to_talk *push_to_talk);

#ifdef __cplusplus
}
#endif

#endif
