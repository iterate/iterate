#ifndef ITERATE_KIT_ESP_IDF_PCM_TRANSPORT_LIFECYCLE_H
#define ITERATE_KIT_ESP_IDF_PCM_TRANSPORT_LIFECYCLE_H

#include "iterate/kit/platforms/esp_idf_pcm_transport.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Private raw-transport lifecycle seam.
 *
 * Board targets need the transport object, prepare(), metrics, notifications,
 * and hardware-release receipts, but they must not own when its network task
 * starts or when a socket generation is replaced. Publishing these functions
 * in the component's public include tree made it possible to recreate the old
 * three-target lifecycle drift behind a local wrapper. Only pcm_session.c,
 * pcm_transport.c, and their focused host tests receive this private header;
 * target code which bypasses the shared session owner now fails to compile.
 */
enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_start(
    struct iterate_kit_esp_idf_pcm_transport *transport);

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_poll(
    struct iterate_kit_esp_idf_pcm_transport *transport);

void iterate_kit_esp_idf_pcm_transport_request_restart(
    struct iterate_kit_esp_idf_pcm_transport *transport);

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_request_stop(
    struct iterate_kit_esp_idf_pcm_transport *transport);

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_finish_stop(
    struct iterate_kit_esp_idf_pcm_transport *transport);

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_stop(
    struct iterate_kit_esp_idf_pcm_transport *transport);

const char *iterate_kit_esp_idf_pcm_transport_state_name(
    enum iterate_kit_esp_idf_pcm_transport_state state);

#ifdef __cplusplus
}
#endif

#endif
