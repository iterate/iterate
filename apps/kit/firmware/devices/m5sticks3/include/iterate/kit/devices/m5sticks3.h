#ifndef ITERATE_KIT_DEVICES_M5STICKS3_H
#define ITERATE_KIT_DEVICES_M5STICKS3_H

#include "iterate/kit/capabilities/metrics.h"
#include "iterate/kit/capabilities/push_to_talk.h"
#include "iterate/kit/capabilities/screen.h"
#include "iterate/kit/device_events.h"
#include "iterate/kit/device.h"
#include "iterate/kit/peer.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * Module count fixes peer dispatch RAM at compile time. Event work is capped
   * per poll so a burst of physical/remote edges cannot starve Cap'n Web or
   * audio progress; remaining accepted events stay in the bounded queue.
   */
  ITERATE_KIT_M5STICKS3_MODULE_COUNT = 4,
  ITERATE_KIT_M5STICKS3_EVENTS_PER_POLL = 4,
};

/**
 * Device-profile dependencies and caller-owned storage.
 *
 * The M5StickS3 layer composes generic capabilities; it does not own screen,
 * microphone, speaker, socket, or timer hardware. All driver contexts,
 * scratch/ring storage, metric subscriptions, and event storage remain borrowed
 * and must outlive the device. The platform must serialize public calls on the
 * device owner task unless the underlying audio API explicitly documents a
 * cross-task boundary.
 */
struct iterate_kit_m5sticks3_options {
  struct iterate_kit_screen_driver screen;
  char *screen_url_scratch;
  size_t screen_url_scratch_size;
  struct iterate_kit_metrics_options metrics;
  struct iterate_kit_audio_options audio;
  struct iterate_kit_device_event *event_storage;
  size_t event_capacity;
  struct iterate_kit_device_event_observer event_observer;
};

struct iterate_kit_m5sticks3 {
  /*
   * State is embedded rather than allocated so the target's complete RAM cost
   * is visible in sizeof/profile reports. Module order is stable public
   * composition, not a hardware initialization order.
   */
  struct iterate_kit_peer peer;
  struct iterate_kit_module modules[ITERATE_KIT_M5STICKS3_MODULE_COUNT];
  struct iterate_kit_screen screen;
  struct iterate_kit_metrics metrics;
  struct iterate_kit_audio_controller audio;
  struct iterate_kit_device_event_queue events;
  struct iterate_kit_push_to_talk push_to_talk;
};

extern const struct iterate_kit_device_manifest
    iterate_kit_m5sticks3_manifest;

/**
 * Assembles the profile after platform drivers/storage are ready. No capability
 * is usable after an error; callers should treat initialization failure as a
 * classified boot/configuration defect rather than retrying in a tight loop.
 */
enum capnweb_status iterate_kit_m5sticks3_init(
    struct iterate_kit_m5sticks3 *device,
    const struct iterate_kit_m5sticks3_options *options);
struct capnweb_capability iterate_kit_m5sticks3_capability(
    struct iterate_kit_m5sticks3 *device);
/**
 * Runs bounded event work followed by each capability module. `now_ms` is a
 * monotonic clock used for subscription scheduling, not wall time.
 */
struct iterate_kit_poll_result iterate_kit_m5sticks3_poll(
    struct iterate_kit_m5sticks3 *device, uint64_t now_ms);
struct iterate_kit_poll_result iterate_kit_m5sticks3_close(
    struct iterate_kit_m5sticks3 *device);
struct iterate_kit_device iterate_kit_m5sticks3_device(
    struct iterate_kit_m5sticks3 *device);
/**
 * Queues one local or remote edge; success proves local queue acceptance only.
 * It does not prove capture started or any PCM reached the peer.
 */
enum iterate_kit_status iterate_kit_m5sticks3_publish_push_to_talk(
    struct iterate_kit_m5sticks3 *device,
    bool active,
    enum iterate_kit_device_event_source source);
/*
 * These narrow adapters keep the platform from reaching into generic audio
 * state. Capture submission and playback notification preserve the audio
 * module's freshness/drop metrics; they do not themselves perform I/O.
 */
enum iterate_kit_status iterate_kit_m5sticks3_note_playback_started(
    struct iterate_kit_m5sticks3 *device);
enum iterate_kit_status iterate_kit_m5sticks3_submit_capture(
    struct iterate_kit_m5sticks3 *device,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz);
const struct iterate_kit_audio_metrics *
iterate_kit_m5sticks3_audio_metrics(
    const struct iterate_kit_m5sticks3 *device);
bool iterate_kit_m5sticks3_is_capturing(
    const struct iterate_kit_m5sticks3 *device);
void iterate_kit_m5sticks3_event_metrics(
    const struct iterate_kit_m5sticks3 *device,
    struct iterate_kit_device_event_queue_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
