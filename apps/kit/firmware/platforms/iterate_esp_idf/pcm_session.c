#include "iterate/kit/platforms/esp_idf_pcm_session.h"
#include "pcm_transport_lifecycle.h"

#include <string.h>

#include "esp_log.h"

static const char *log_tag(
    const struct iterate_kit_esp_idf_pcm_session *session) {
  return session->options.log_tag == NULL
      ? "iterate-pcm-session"
      : session->options.log_tag;
}

static bool raw_transport_ready(
    const struct iterate_kit_esp_idf_pcm_session *session) {
  return session->started &&
      session->options.pcm_transport->state ==
          ITERATE_KIT_ESP_IDF_PCM_READY;
}

static enum iterate_kit_status publish_media_gate(
    struct iterate_kit_esp_idf_pcm_session *session,
    bool control_ready,
    bool conversation_active) {
  const bool transport_ready =
      raw_transport_ready(session) &&
      !session->restart_boundary_pending;
  const bool media_ready =
      control_ready && conversation_active && transport_ready;
  enum iterate_kit_status status;

  /*
   * The three-way conjunction is the architectural contract: an idle warm
   * socket is not an open microphone, an active conversation cannot retain PCM
   * while its socket generation is reconnecting, and a raw socket surviving a
   * lost Cap'n Web mount cannot retain stale authorization. Store it before
   * calling the required hardware-policy adapter so Stick and the full-duplex
   * targets observe the same decision even though their lower owners differ.
   */
  if (session->media_gate_published &&
      session->media_ready == media_ready) {
    return ITERATE_KIT_OK;
  }
  status = session->options.set_media_ready(
      session->options.hook_context, media_ready);
  if (status != ITERATE_KIT_OK) {
    /*
     * A target hook which did not accept the decision cannot make an open
     * media claim. Keep the shared gate closed and retry only from the normal
     * bounded owner cadence; targets are forbidden from repairing this edge
     * through a parallel lifecycle path.
     */
    session->media_ready = false;
    session->media_gate_published = false;
    return status;
  }
  session->media_ready = media_ready;
  session->media_gate_published = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_session_prepare(
    struct iterate_kit_esp_idf_pcm_session *session,
    const struct iterate_kit_esp_idf_pcm_session_options *options) {
  if (session == NULL || options == NULL ||
      options->control_transport == NULL ||
      options->pcm_transport == NULL ||
      options->conversation_active == NULL ||
      options->set_media_ready == NULL ||
      !options->pcm_transport->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(session, 0, sizeof(*session));
  session->options = *options;
  session->last_transport_state =
      options->pcm_transport->state;
  session->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_session_poll(
    struct iterate_kit_esp_idf_pcm_session *session) {
  struct iterate_kit_esp_idf_itx_transport_lifecycle control;
  enum iterate_kit_status transport_status = ITERATE_KIT_OK;
  enum iterate_kit_status media_status;
  enum iterate_kit_status result;
  bool control_ready;
  bool conversation_active;

  if (session == NULL || !session->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }

  conversation_active = session->options.conversation_active(
      session->options.hook_context);

  memset(&control, 0, sizeof(control));
  iterate_kit_esp_idf_itx_transport_lifecycle(
      session->options.control_transport, &control);
  control_ready =
      session->options.control_transport->state ==
          ITERATE_KIT_ESP_IDF_ITX_READY &&
      control.ready_socket_generation != 0U;

  if (!session->started && !session->start_attempted &&
      control_ready) {
    /*
     * This edge is intentionally independent of conversation_active. Opening
     * `/pcm` here gives userspace time to authenticate and mint its one-use
     * provider credential while the device merely displays READY. A local
     * static-task creation failure is attempted once; repeating it every 10 ms
     * would be an unbounded resource storm. Network failures after successful
     * start are owned by the transport's tested exponential retry gate.
     */
    session->start_attempted = true;
    transport_status = iterate_kit_esp_idf_pcm_transport_start(
        session->options.pcm_transport);
    if (transport_status == ITERATE_KIT_OK) {
      session->started = true;
      session->control_ready_generation =
          control.ready_socket_generation;
    } else {
      session->start_failure = transport_status;
      ESP_LOGE(
          log_tag(session),
          "pcm session start failed: status=%d platform=%ld",
          (int)transport_status,
          (long)session->options.pcm_transport->last_platform_error);
    }
  }

  if (session->started && control_ready &&
      session->control_ready_generation != 0U &&
      control.ready_socket_generation !=
          session->control_ready_generation) {
    /*
     * Provider callbacks are Cap'n Web-generation scoped. A freshly mounted
     * control session cannot safely inherit the old PCM callback coordinator,
     * even if its audio WebSocket still answers PING. Replace exactly one PCM
     * generation and close media admission immediately; do not stop the static
     * owner task or throw away the lifetime prewarm policy.
     */
    session->control_ready_generation =
        control.ready_socket_generation;
    session->restart_boundary_pending = true;
    iterate_kit_esp_idf_pcm_transport_request_restart(
        session->options.pcm_transport);
  }

  if (session->started) {
    transport_status = iterate_kit_esp_idf_pcm_transport_poll(
        session->options.pcm_transport);
    if (session->options.pcm_transport->state !=
        session->last_transport_state) {
      const bool generation_lost =
          session->last_transport_state ==
              ITERATE_KIT_ESP_IDF_PCM_READY &&
          session->options.pcm_transport->state !=
              ITERATE_KIT_ESP_IDF_PCM_READY;
      ESP_LOGI(
          log_tag(session),
          "pcm session state=%s status=%d platform=%ld",
          iterate_kit_esp_idf_pcm_transport_state_name(
              session->options.pcm_transport->state),
          (int)transport_status,
          (long)session->options.pcm_transport->last_platform_error);
      session->last_transport_state =
          session->options.pcm_transport->state;
      if (generation_lost &&
          session->options.generation_lost != NULL) {
        session->options.generation_lost(
            session->options.hook_context);
      }
    }
    if (session->options.pcm_transport->state !=
        ITERATE_KIT_ESP_IDF_PCM_READY) {
      /*
       * Once the owner has visibly left READY, ordinary transport state is a
       * sufficient admission fence. Clearing this latch lets the next fresh
       * READY generation reopen media without an extra target-local signal.
       */
      session->restart_boundary_pending = false;
    }
  }

  media_status = publish_media_gate(
      session, control_ready, conversation_active);
  result = session->start_failure != ITERATE_KIT_OK
      ? session->start_failure
      : transport_status != ITERATE_KIT_OK
      ? transport_status
      : media_status;
  if (result != session->last_result) {
    /*
     * A persistent network or hardware-intent fault may span thousands of
     * cooperative polls. Log its edge once and retain the exact status for
     * metrics/callers; per-poll serial output would itself steal audio time.
     * The recovery edge is equally useful because it closes the incident
     * interval without pretending the preceding error never happened.
     */
    if (result == ITERATE_KIT_OK) {
      ESP_LOGI(
          log_tag(session), "%s", "pcm session reconcile recovered");
    } else {
      ESP_LOGE(
          log_tag(session),
          "pcm session reconcile failed: status=%d",
          (int)result);
    }
    session->last_result = result;
  }
  return result;
}

bool iterate_kit_esp_idf_pcm_session_started(
    const struct iterate_kit_esp_idf_pcm_session *session) {
  return session != NULL && session->initialized && session->started;
}

bool iterate_kit_esp_idf_pcm_session_transport_ready(
    const struct iterate_kit_esp_idf_pcm_session *session) {
  return session != NULL && session->initialized &&
      raw_transport_ready(session) &&
      !session->restart_boundary_pending;
}

bool iterate_kit_esp_idf_pcm_session_media_ready(
    const struct iterate_kit_esp_idf_pcm_session *session) {
  return session != NULL && session->initialized &&
      session->media_ready;
}

bool iterate_kit_esp_idf_pcm_session_failed(
    const struct iterate_kit_esp_idf_pcm_session *session) {
  return session != NULL && session->initialized &&
      (session->start_failure != ITERATE_KIT_OK ||
       (session->started &&
        session->options.pcm_transport->state ==
            ITERATE_KIT_ESP_IDF_PCM_FAILED));
}
