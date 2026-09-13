#ifndef ITERATE_KIT_CLI_DEVICE_CONTROLS_H
#define ITERATE_KIT_CLI_DEVICE_CONTROLS_H

/* One bounded owner for local keyboard and scripted capture intent. */

#include <stdbool.h>

#include "iterate/kit/device_events.h"
#include "iterate/kit/status.h"
#include "iterate/kit/voice_device_profile.h"

struct cli_runtime;

struct cli_device_controls {
  struct cli_runtime *runtime;
  struct iterate_kit_device_event_queue events;
  struct iterate_kit_device_event
      storage[ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY];
};

enum iterate_kit_status cli_device_controls_init(
    struct cli_device_controls *controls, struct cli_runtime *runtime);

enum iterate_kit_status cli_device_controls_request_talk(
    struct cli_device_controls *controls,
    bool active,
    enum iterate_kit_device_event_source source);

enum iterate_kit_status cli_device_controls_poll(
    struct cli_device_controls *controls);

#endif /* ITERATE_KIT_CLI_DEVICE_CONTROLS_H */
