#ifndef ITERATE_KIT_CLI_DEVICE_CONTROLS_H
#define ITERATE_KIT_CLI_DEVICE_CONTROLS_H

/* One bounded owner for physical, remote, and scripted talk intent. */

#include <stdbool.h>

#include "iterate/kit/capabilities/push_to_talk.h"
#include "iterate/kit/device_events.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"
#include "iterate/kit/voice_device_profile.h"

struct cli_runtime;

struct cli_device_controls {
  struct cli_runtime *runtime;
  struct iterate_kit_device_event_queue events;
  struct iterate_kit_device_event
      storage[ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY];
  struct iterate_kit_push_to_talk push_to_talk;
};

enum iterate_kit_status cli_device_controls_init(
    struct cli_device_controls *controls, struct cli_runtime *runtime);

/** The shared RPC module; replies mean the edge entered the local queue. */
struct iterate_kit_module cli_device_controls_module(
    struct cli_device_controls *controls);

enum iterate_kit_status cli_device_controls_request_talk(
    struct cli_device_controls *controls,
    bool active,
    enum iterate_kit_device_event_source source);

enum iterate_kit_status cli_device_controls_poll(
    struct cli_device_controls *controls);

#endif /* ITERATE_KIT_CLI_DEVICE_CONTROLS_H */
