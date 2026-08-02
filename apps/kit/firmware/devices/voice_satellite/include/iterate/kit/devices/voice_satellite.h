#ifndef ITERATE_KIT_DEVICES_VOICE_SATELLITE_H
#define ITERATE_KIT_DEVICES_VOICE_SATELLITE_H

#include "iterate/kit/capabilities/callback_budget.h"
#include "iterate/kit/capabilities/conversation.h"
#include "iterate/kit/capabilities/device_event_stream.h"
#include "iterate/kit/capabilities/leds.h"
#include "iterate/kit/capabilities/metrics.h"
#include "iterate/kit/device.h"
#include "iterate/kit/device_events.h"
#include "iterate/kit/peer.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * A screenless voice satellite needs only lifecycle/events, diagnostics,
   * LEDs, and metrics on its control socket. PCM has a separate realtime
   * socket and therefore cannot consume any of these queue or callback slots.
   * The small fixed budgets are intentionally the same shape as StackChan's:
   * they retain a reconnect/remote-control burst while preserving a finite,
   * inspectable RAM cost and bounded work in every cooperative poll.
   */
  ITERATE_KIT_VOICE_SATELLITE_MODULE_COUNT = 4,
  ITERATE_KIT_VOICE_SATELLITE_EVENTS_PER_POLL = 4,
  ITERATE_KIT_VOICE_SATELLITE_EVENT_CAPACITY = 8,
  ITERATE_KIT_VOICE_SATELLITE_EVENT_NOTIFICATION_CAPACITY = 8,
  ITERATE_KIT_VOICE_SATELLITE_EVENT_SUBSCRIPTION_CAPACITY = 2,
  ITERATE_KIT_VOICE_SATELLITE_MAXIMUM_IN_FLIGHT_CALLBACKS = 2,
};

/**
 * Reusable semantic profile for boards whose audio hardware supplies local
 * AEC and whose provider owns VAD. `manifest` remains injected so HAVPE and a
 * future satellite can share the exact control implementation without lying
 * about board identity. All drivers/storage reachable from these options are
 * borrowed for the profile lifetime; initialization performs no allocation or
 * hardware I/O.
 */
struct iterate_kit_voice_satellite_options {
  const struct iterate_kit_device_manifest *manifest;
  struct iterate_kit_led_driver leds;
  size_t led_count;
  struct iterate_kit_conversation_playback_interruption_driver
      playback_interruption;
  struct iterate_kit_metrics_options metrics;
};

/**
 * Optional bridge from ordered semantic events to the platform's PCM owner.
 * Both callbacks execute on the cooperative Cap'n Web owner and must only
 * signal bounded nonblocking work; sockets, I2S calls, and allocation belong
 * elsewhere. Copying this descriptor makes its callback context the only
 * borrowed lifetime.
 */
struct iterate_kit_voice_satellite_control_driver {
  struct iterate_kit_device_event_handler handler;
  struct iterate_kit_device_event_observer observer;
};

struct iterate_kit_voice_satellite {
  struct iterate_kit_peer peer;
  struct iterate_kit_module
      modules[ITERATE_KIT_VOICE_SATELLITE_MODULE_COUNT];
  struct iterate_kit_device_event
      event_storage[ITERATE_KIT_VOICE_SATELLITE_EVENT_CAPACITY];
  struct iterate_kit_device_event_notification event_notifications
      [ITERATE_KIT_VOICE_SATELLITE_EVENT_NOTIFICATION_CAPACITY];
  struct iterate_kit_device_event_subscription event_subscriptions
      [ITERATE_KIT_VOICE_SATELLITE_EVENT_SUBSCRIPTION_CAPACITY];
  struct iterate_kit_callback_budget callback_budget;
  struct iterate_kit_device_event_queue events;
  struct iterate_kit_device_event_stream event_stream;
  struct iterate_kit_conversation conversation;
  struct iterate_kit_leds leds;
  struct iterate_kit_metrics metrics;
  const struct iterate_kit_device_manifest *manifest;
  struct iterate_kit_voice_satellite_control_driver control_driver;
  bool conversation_active;
};

enum capnweb_status iterate_kit_voice_satellite_init(
    struct iterate_kit_voice_satellite *device,
    const struct iterate_kit_voice_satellite_options *options);
enum iterate_kit_status iterate_kit_voice_satellite_bind_control_driver(
    struct iterate_kit_voice_satellite *device,
    const struct iterate_kit_voice_satellite_control_driver *driver);
struct capnweb_capability iterate_kit_voice_satellite_capability(
    struct iterate_kit_voice_satellite *device);
struct iterate_kit_poll_result iterate_kit_voice_satellite_poll(
    struct iterate_kit_voice_satellite *device, uint64_t now_ms);
struct iterate_kit_poll_result iterate_kit_voice_satellite_close(
    struct iterate_kit_voice_satellite *device);
struct iterate_kit_device iterate_kit_voice_satellite_device(
    struct iterate_kit_voice_satellite *device);

/**
 * Publishes local/system conversation intent through the same finite queue as
 * the remote conversation capability. Success means admission only; the
 * platform handler and public state transition happen on a later owner poll.
 */
enum iterate_kit_status iterate_kit_voice_satellite_publish_conversation(
    struct iterate_kit_voice_satellite *device,
    bool active,
    enum iterate_kit_device_event_source source);
bool iterate_kit_voice_satellite_is_conversation_active(
    const struct iterate_kit_voice_satellite *device);
void iterate_kit_voice_satellite_event_metrics(
    const struct iterate_kit_voice_satellite *device,
    struct iterate_kit_device_event_queue_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
