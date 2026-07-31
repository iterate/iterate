#ifndef ITERATE_KIT_TESTS_FAKE_ESP_IDF_CONTROL_WEBSOCKET_H
#define ITERATE_KIT_TESTS_FAKE_ESP_IDF_CONTROL_WEBSOCKET_H

#include "iterate/kit/platforms/esp_idf_websocket_connection.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Deterministic host seam for the taskless ESP WebSocket connection.
 *
 * The production control transport still owns its real FreeRTOS-thread stand
 * in, retry gates, SPSC rings, Cap'n Web session, and all generation policy.
 * This fake replaces only DNS/TLS/socket bytes. Inbound chunks are queued by
 * the test producer and consumed exclusively by the production network owner,
 * matching the architecture that removed the managed callback task.
 */

enum iterate_kit_status
iterate_kit_fake_control_websocket_queue_frame(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    uint8_t opcode,
    const void *data,
    size_t data_length,
    size_t payload_length,
    size_t payload_offset,
    bool final);

enum iterate_kit_status
iterate_kit_fake_control_websocket_queue_text(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    const char *data,
    size_t data_length,
    size_t payload_length,
    size_t payload_offset,
    bool final);

/**
 * Makes the next receive attempt lose the byte stream with the exact code.
 *
 * A disconnect is queued rather than invoked as a callback: the direct
 * connection has exactly one owner, so a callback-shaped fake would preserve
 * the concurrency bug this refactor is intended to remove.
 */
enum iterate_kit_status
iterate_kit_fake_control_websocket_queue_disconnect(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int error);

/**
 * Makes the next lower write accept a strict prefix.
 *
 * The portable writer must resume the same frame without reconnecting or
 * duplicating its Cap'n Web message. This is ordinary progress, not failure.
 */
void iterate_kit_fake_control_websocket_short_next_write(void);

/** Exact number of scripted inbound items not yet read by the owner task. */
uint32_t iterate_kit_fake_control_websocket_pending_items(void);

#endif
