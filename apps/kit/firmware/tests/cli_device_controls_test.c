#include "cli_device_controls.h"
#include "cli_runtime.h"

#include <assert.h>
#include <string.h>

/*
 * The host is an actual consumer of the shared push-to-talk module: an RPC
 * edge and a physical edge both reach the same bounded queue and the same
 * single mutation point for desired capture state.
 */
static void remote_and_physical_edges_share_the_host_owner(void)
{
  static struct cli_runtime runtime;
  struct capnweb_reply reply = {0};
  memset(&runtime, 0, sizeof(runtime));
  assert(cli_device_controls_init(&runtime.device_controls, &runtime) ==
         ITERATE_KIT_OK);

  const struct iterate_kit_module remote =
      cli_device_controls_module(&runtime.device_controls);
  assert(remote.method_count == 2U);
  assert(remote.methods[0].dispatch(remote.context, NULL, &reply) ==
         CAPNWEB_OK);
  assert(cli_device_controls_poll(&runtime.device_controls) == ITERATE_KIT_OK);
  assert(runtime.wants_talk);

  assert(cli_device_controls_request_talk(
             &runtime.device_controls,
             false,
             ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) == ITERATE_KIT_OK);
  assert(cli_device_controls_poll(&runtime.device_controls) == ITERATE_KIT_OK);
  assert(!runtime.wants_talk);

  struct iterate_kit_device_event_queue_metrics metrics = {0};
  iterate_kit_device_event_queue_metrics(
      &runtime.device_controls.events, &metrics);
  assert(metrics.events_published == 2U);
  assert(metrics.events_processed == 2U);
  assert(metrics.publisher_backpressure == 0U);
  assert(metrics.handler_failures == 0U);
}

int main(void)
{
  remote_and_physical_edges_share_the_host_owner();
  return 0;
}
