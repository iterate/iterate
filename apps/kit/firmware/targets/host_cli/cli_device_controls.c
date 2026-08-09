/* cli_device_controls.c: the host's single owner for desired talk state. */

#include "cli_device_controls.h"

#include <string.h>

#include "cli_runtime.h"

static enum iterate_kit_status cli_device_controls_handle(
    void *context, const struct iterate_kit_device_event *event)
{
  struct cli_device_controls *controls = context;
  if (controls == NULL || controls->runtime == NULL || event == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
      controls->runtime->wants_talk = true;
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      controls->runtime->wants_talk = false;
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return ITERATE_KIT_INVALID_ARGUMENT;
}

enum iterate_kit_status cli_device_controls_init(
    struct cli_device_controls *controls, struct cli_runtime *runtime)
{
  struct iterate_kit_device_event_queue_options options;
  enum iterate_kit_status status;
  if (controls == NULL || runtime == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(controls, 0, sizeof(*controls));
  controls->runtime = runtime;
  options = (struct iterate_kit_device_event_queue_options){
    .storage = controls->storage,
    .capacity = ITERATE_KIT_VOICE_DEVICE_EVENT_CAPACITY,
    .handler = {
      .context = controls,
      .handle = cli_device_controls_handle,
    },
  };
  status = iterate_kit_device_event_queue_init(&controls->events, &options);
  if (status != ITERATE_KIT_OK) return status;
  /*
   * NULL: the CLI has no call gate to consult, so it reports `accepted` and
   * omits `latched` rather than guessing at it.
   */
  return iterate_kit_push_to_talk_init(
      &controls->push_to_talk, &controls->events, NULL);
}

struct iterate_kit_module cli_device_controls_module(
    struct cli_device_controls *controls)
{
  if (controls == NULL) {
    return (struct iterate_kit_module){0};
  }
  return iterate_kit_push_to_talk_module(&controls->push_to_talk);
}

enum iterate_kit_status cli_device_controls_request_talk(
    struct cli_device_controls *controls,
    bool active,
    enum iterate_kit_device_event_source source)
{
  if (controls == NULL) return ITERATE_KIT_INVALID_ARGUMENT;
  return iterate_kit_device_event_publish(
      &controls->events,
      active
          ? ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED
          : ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED,
      source);
}

enum iterate_kit_status cli_device_controls_poll(
    struct cli_device_controls *controls)
{
  if (controls == NULL) return ITERATE_KIT_INVALID_ARGUMENT;
  return iterate_kit_device_event_poll(
      &controls->events, ITERATE_KIT_VOICE_DEVICE_EVENT_POLL_BUDGET);
}
