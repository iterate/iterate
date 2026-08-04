#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_PCM_SESSION_H
#define ITERATE_KIT_PLATFORMS_ESP_IDF_PCM_SESSION_H

#if defined(__GNUC__)
#pragma GCC system_header
#endif

#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/platforms/esp_idf_pcm_transport.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Device-lifetime ownership policy for the independent `/pcm` connection.
 *
 * The raw PCM transport owns DNS/TCP/TLS/WebSocket generations and their
 * bounded retry gate. It deliberately knows nothing about Cap'n Web mount or
 * conversation state. This owner joins those timelines in exactly one place:
 * it starts once after the authenticated control mount is ready, replaces the
 * PCM generation after a control remount, and admits media only while both a
 * conversation and a ready PCM generation exist.
 *
 * Keeping this policy above the transport is important. Putting conversation
 * state into the network task would couple a cheap local button edge to socket
 * teardown, defeating credential prewarming. Copying the join into each board
 * target already caused Stick to prewarm while StackChan and HAVPE waited more
 * than three seconds at call start. Targets provide only a hardware-facing
 * desired-state sink and, where required, a notification for abandoning
 * manual-turn UI state; they do not own socket lifetime or media admission.
 */
struct iterate_kit_esp_idf_pcm_session_options {
  struct iterate_kit_esp_idf_itx_transport *control_transport;
  struct iterate_kit_esp_idf_pcm_transport *pcm_transport;
  /*
   * These hooks are the complete target seam. The target reports only its
   * already-reconciled conversation fact and accepts one shared media-gate
   * decision; it cannot choose a different conjunction or socket lifetime.
   * `set_media_ready` records desired state only and must not block or perform
   * socket I/O. Hardware owners apply that state from their normal bounded
   * poll/task boundary.
   */
  void *hook_context;
  bool (*conversation_active)(void *context);
  enum iterate_kit_status (*set_media_ready)(
      void *context, bool ready);
  /*
   * A lost PCM generation invalidates Stick's target-specific "turn awaiting
   * reply" bookkeeping. The callback may only clear local scalar state: it is
   * invoked by the cooperative owner and must not perform socket or audio I/O.
   */
  void (*generation_lost)(void *context);
  /* Borrowed static string used only for bounded transition logs. */
  const char *log_tag;
};

struct iterate_kit_esp_idf_pcm_session {
  struct iterate_kit_esp_idf_pcm_session_options options;
  enum iterate_kit_esp_idf_pcm_transport_state last_transport_state;
  enum iterate_kit_status last_result;
  /*
   * Task creation is the only failure before the raw owner exists. Retain it
   * separately because the transport has no task which could later publish a
   * recovery edge; clearing it on the next target poll would be false health.
   */
  enum iterate_kit_status start_failure;
  uint32_t control_ready_generation;
  bool start_attempted;
  bool started;
  bool media_ready;
  bool media_gate_published;
  bool restart_boundary_pending;
  bool initialized;
};

enum iterate_kit_status iterate_kit_esp_idf_pcm_session_prepare(
    struct iterate_kit_esp_idf_pcm_session *session,
    const struct iterate_kit_esp_idf_pcm_session_options *options);

/**
 * Reconciles one bounded owner-loop step.
 *
 * This call never performs PCM socket I/O itself. start() creates the static
 * network task once, transport_poll() performs only the application-side
 * generation fence, and subsequent network failures remain inside the raw
 * transport's bounded retry owner. The target's conversation callback is an
 * input fact; only this owner joins it with control and PCM generations. A
 * conversation edge therefore changes media admission but can never start or
 * stop a socket.
 */
enum iterate_kit_status iterate_kit_esp_idf_pcm_session_poll(
    struct iterate_kit_esp_idf_pcm_session *session);

bool iterate_kit_esp_idf_pcm_session_started(
    const struct iterate_kit_esp_idf_pcm_session *session);
bool iterate_kit_esp_idf_pcm_session_transport_ready(
    const struct iterate_kit_esp_idf_pcm_session *session);
bool iterate_kit_esp_idf_pcm_session_media_ready(
    const struct iterate_kit_esp_idf_pcm_session *session);
bool iterate_kit_esp_idf_pcm_session_failed(
    const struct iterate_kit_esp_idf_pcm_session *session);

#ifdef __cplusplus
}
#endif

#endif
