#ifndef ITERATE_KIT_WEBSOCKET_TEXT_H
#define ITERATE_KIT_WEBSOCKET_TEXT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/websocket_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum capnweb_status (*iterate_kit_websocket_receive_text_fn)(
    void *context, const char *message, size_t length);

/**
 * Bounded RFC 6455 text-message reassembly. The caller supplies all storage.
 * Frame chunks must carry the source frame's total payload length and offset,
 * as ESP-IDF's esp_websocket_client event API does.
 *
 * Control frames are validated and ignored here because connection liveness is
 * handled by the WebSocket transport layer. Any malformed sequence poisons the
 * ingress until reset/reconnect: guessing a new boundary after a partial
 * message could feed attacker-controlled suffixes to Cap'n Web.
 */
struct iterate_kit_websocket_text_ingress {
  char *buffer;
  size_t capacity;
  size_t message_length;
  size_t frame_length;
  size_t frame_received;
  uint8_t frame_opcode;
  bool frame_fin;
  bool message_open;
  bool frame_open;
  iterate_kit_websocket_receive_text_fn receive_text;
  void *context;
  enum capnweb_status terminal_status;
};

enum capnweb_status iterate_kit_websocket_text_ingress_init(
    struct iterate_kit_websocket_text_ingress *ingress,
    char *buffer,
    size_t capacity,
    iterate_kit_websocket_receive_text_fn receive_text,
    void *context);

enum capnweb_status iterate_kit_websocket_text_ingress_feed(
    struct iterate_kit_websocket_text_ingress *ingress,
    uint8_t opcode,
    bool fin,
    size_t payload_length,
    size_t payload_offset,
    const char *data,
    size_t length);

/**
 * Non-blocking Cap'n Web text egress. Fragments are assembled directly into a
 * caller-owned SPSC slot and published as one complete message for a network
 * task to send. The capability task is the sole producer and the network task
 * the sole consumer. One slot remains reserved from BEGIN through END; ring
 * exhaustion becomes terminal transport failure rather than blocking or
 * silently dropping an RPC message.
 */
struct iterate_kit_websocket_text_outbox {
  struct iterate_kit_spsc_ring *ring;
  uint8_t *message;
  size_t capacity;
  size_t length;
  bool message_open;
  enum capnweb_status terminal_status;
};

enum capnweb_status iterate_kit_websocket_text_outbox_init(
    struct iterate_kit_websocket_text_outbox *outbox,
    struct iterate_kit_spsc_ring *ring);

enum capnweb_status iterate_kit_websocket_text_outbox_send(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length);

enum capnweb_status iterate_kit_websocket_text_outbox_reset(
    struct iterate_kit_websocket_text_outbox *outbox);

/**
 * Non-blocking WebSocket text ingress. Frame chunks are reassembled directly
 * into a caller-owned SPSC slot and published only after a complete message.
 * The network task is the sole producer and capability task the sole consumer.
 * Reserving before the first chunk prevents a half-message from becoming
 * visible and makes maximum memory exactly ring capacity.
 */
struct iterate_kit_websocket_text_inbox {
  struct iterate_kit_spsc_ring *ring;
  struct iterate_kit_websocket_text_ingress ingress;
  bool write_acquired;
  enum capnweb_status terminal_status;
};

enum capnweb_status iterate_kit_websocket_text_inbox_init(
    struct iterate_kit_websocket_text_inbox *inbox,
    struct iterate_kit_spsc_ring *ring);

enum capnweb_status iterate_kit_websocket_text_inbox_feed(
    struct iterate_kit_websocket_text_inbox *inbox,
    uint8_t opcode,
    bool fin,
    size_t payload_length,
    size_t payload_offset,
    const char *data,
    size_t length);

enum capnweb_status iterate_kit_websocket_text_inbox_reset(
    struct iterate_kit_websocket_text_inbox *inbox);

#ifdef __cplusplus
}
#endif

#endif
