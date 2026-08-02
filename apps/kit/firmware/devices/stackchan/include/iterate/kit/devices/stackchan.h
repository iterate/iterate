#ifndef ITERATE_KIT_DEVICES_STACKCHAN_H
#define ITERATE_KIT_DEVICES_STACKCHAN_H

#include "iterate/kit/capabilities/callback_budget.h"
#include "iterate/kit/capabilities/camera.h"
#include "iterate/kit/capabilities/conversation.h"
#include "iterate/kit/capabilities/device_event_stream.h"
#include "iterate/kit/capabilities/leds.h"
#include "iterate/kit/capabilities/metrics.h"
#include "iterate/kit/capabilities/screen.h"
#include "iterate/kit/capabilities/servos.h"
#include "iterate/kit/device.h"
#include "iterate/kit/device_events.h"
#include "iterate/kit/peer.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * These are profile budgets, not incidental implementation sizes. Human
   * control edges are sparse, but a reconnect and remote/physical burst can
   * overlap; eight entries retain that burst while four events per poll keep
   * actuator/control work from monopolizing the owner loop. Two independent
   * event observers and metrics fanout share two in-flight Cap'n Web
   * admissions, keeping one profile-wide bound rather than letting every
   * module consume its independent maximum. A slow diagnostic observer can
   * therefore wait without evicting the PCM owner or inflating wire bursts.
   * Each target still has to prove that its transport storage fits this
   * profile budget.
   */
  ITERATE_KIT_STACKCHAN_MODULE_COUNT = 7,
  ITERATE_KIT_STACKCHAN_EVENTS_PER_POLL = 4,
  ITERATE_KIT_STACKCHAN_EVENT_CAPACITY = 8,
  ITERATE_KIT_STACKCHAN_EVENT_NOTIFICATION_CAPACITY = 8,
  ITERATE_KIT_STACKCHAN_EVENT_SUBSCRIPTION_CAPACITY = 2,
  ITERATE_KIT_STACKCHAN_MAXIMUM_IN_FLIGHT_CALLBACKS = 2,
};

/**
 * StackChan profile dependencies. Drivers and all storage reachable through
 * `metrics` are borrowed for the device lifetime. The compact control queue
 * and event-notification storage are embedded in the profile because their
 * capacities are product policy and their full RAM cost must appear in
 * sizeof(iterate_kit_stackchan). The profile itself performs no board I/O or
 * allocation; the platform owns camera/display/servo/LED/audio tasking and
 * must serialize synchronous capability calls on the peer owner task. The
 * optional control adapter below is the sole exception and must obey its
 * bounded, nonblocking contract.
 */
struct iterate_kit_stackchan_options {
  struct iterate_kit_screen_driver screen;
  char *screen_url_scratch;
  size_t screen_url_scratch_size;
  struct iterate_kit_servo_driver servos;
  struct iterate_kit_led_driver leds;
  struct iterate_kit_camera_driver camera;
  size_t maximum_photo_bytes;
  struct iterate_kit_conversation_playback_interruption_driver
      playback_interruption;
  struct iterate_kit_metrics_options metrics;
};

/**
 * Optional owner-task adapter for a board's PCM lifecycle and diagnostics.
 *
 * The profile first enforces its conversation state rules, then invokes
 * `handler`; only ITERATE_KIT_OK commits profile state, while every result
 * reaches the event stream. `observer` is a diagnostic mirror invoked after
 * the stream records the result. Both callbacks run on the cooperative peer
 * owner, never a realtime audio task. They must finish promptly: signal a
 * bounded PCM mailbox/task as needed, but do not wait for a socket, slow
 * hardware, or memory allocation. Either function may be NULL. The struct is
 * copied, so only the pointed-to context must outlive the profile.
 */
struct iterate_kit_stackchan_control_driver {
  struct iterate_kit_device_event_handler handler;
  struct iterate_kit_device_event_observer observer;
};

struct iterate_kit_stackchan {
  /*
   * Generic modules are embedded so the library can support another ESP board
   * by composing a different profile without copying camera/screen/RPC logic.
   */
  struct iterate_kit_peer peer;
  struct iterate_kit_module modules[ITERATE_KIT_STACKCHAN_MODULE_COUNT];
  struct iterate_kit_device_event
      event_storage[ITERATE_KIT_STACKCHAN_EVENT_CAPACITY];
  struct iterate_kit_device_event_notification event_notifications
      [ITERATE_KIT_STACKCHAN_EVENT_NOTIFICATION_CAPACITY];
  struct iterate_kit_device_event_subscription event_subscriptions
      [ITERATE_KIT_STACKCHAN_EVENT_SUBSCRIPTION_CAPACITY];
  struct iterate_kit_callback_budget callback_budget;
  struct iterate_kit_device_event_queue events;
  struct iterate_kit_device_event_stream event_stream;
  struct iterate_kit_conversation conversation;
  struct iterate_kit_screen screen;
  struct iterate_kit_servos servos;
  struct iterate_kit_leds leds;
  struct iterate_kit_camera camera;
  struct iterate_kit_metrics metrics;
  struct iterate_kit_stackchan_control_driver control_driver;
  /* Conversation/socket intent is the sole device-side voice state. */
  bool conversation_active;
};

extern const struct iterate_kit_device_manifest
    iterate_kit_stackchan_manifest;

/**
 * Assembles all seven generic modules after hardware drivers/storage are ready.
 * No module is exposed on error; initialization itself performs no hardware
 * I/O and allocates nothing.
 */
enum capnweb_status iterate_kit_stackchan_init(
    struct iterate_kit_stackchan *device,
    const struct iterate_kit_stackchan_options *options);

/**
 * Binds or replaces the target adapter from the same cooperative owner that
 * polls the profile. This performs no I/O or allocation. Pass NULL to unbind;
 * already queued events use whichever adapter is bound when they are polled,
 * so targets should normally bind immediately after successful init.
 */
enum iterate_kit_status iterate_kit_stackchan_bind_control_driver(
    struct iterate_kit_stackchan *device,
    const struct iterate_kit_stackchan_control_driver *driver);
struct capnweb_capability iterate_kit_stackchan_capability(
    struct iterate_kit_stackchan *device);
/** Polls subscription/module state using monotonic milliseconds. */
struct iterate_kit_poll_result iterate_kit_stackchan_poll(
    struct iterate_kit_stackchan *device, uint64_t now_ms);
struct iterate_kit_poll_result iterate_kit_stackchan_close(
    struct iterate_kit_stackchan *device);
struct iterate_kit_device iterate_kit_stackchan_device(
    struct iterate_kit_stackchan *device);

/**
 * Publishes local/system conversation intent into the same bounded queue used
 * by remote conversation.start()/hangUp(). Success proves queue admission,
 * not PCM socket establishment; state changes only on a later owner poll.
 */
enum iterate_kit_status iterate_kit_stackchan_publish_conversation(
    struct iterate_kit_stackchan *device,
    bool active,
    enum iterate_kit_device_event_source source);
bool iterate_kit_stackchan_is_conversation_active(
    const struct iterate_kit_stackchan *device);

void iterate_kit_stackchan_event_metrics(
    const struct iterate_kit_stackchan *device,
    struct iterate_kit_device_event_queue_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
