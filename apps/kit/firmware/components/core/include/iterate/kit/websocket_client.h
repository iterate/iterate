#ifndef ITERATE_KIT_WEBSOCKET_CLIENT_H
#define ITERATE_KIT_WEBSOCKET_CLIENT_H

#include "iterate/kit/status.h"
#include "iterate/kit/websocket_frame_reader.h"
#include "iterate/kit/websocket_rx.h"
#include "iterate/kit/websocket_tx.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * THE ONE WEBSOCKET CLIENT. Every platform runs this RFC 6455 client over its
 * own byte stream: ESP-TLS bytes on a board (platforms/iterate_esp_idf), and
 * OpenSSL bytes on the Mac (platforms/darwin). The platform owns DNS, TCP, TLS,
 * randomness and SHA-1; this client owns the HTTP upgrade, framing, control
 * obligations and the idle-hop keepalive, with every buffer fixed and supplied
 * by the caller.
 */

enum {
  ITERATE_KIT_WEBSOCKET_HOST_CAPACITY = 129,
  ITERATE_KIT_WEBSOCKET_PATH_CAPACITY = 160,
  /** The 28 base64 characters of an RFC 6455 accept value, and a NUL. */
  ITERATE_KIT_WEBSOCKET_ACCEPT_CAPACITY = 29,
};

/** Where a ws:// or wss:// URL points; the platform's byte stream dials it. */
struct iterate_kit_websocket_endpoint {
  char host[ITERATE_KIT_WEBSOCKET_HOST_CAPACITY];
  /** The request target: the path and any query, "/" when the URL has none. */
  char path[ITERATE_KIT_WEBSOCKET_PATH_CAPACITY];
  uint16_t port;
  /** wss://, so the stream must be verified TLS. ws:// is for local servers. */
  bool secure;
};

/**
 * Parses ws[s]://host[:port][/path][?query]. Userinfo (secrets belong in
 * explicit headers) and fragments (never part of a request target) are
 * refused, as is anything longer than the fixed endpoint.
 */
bool iterate_kit_websocket_endpoint_parse(
    const char *url, struct iterate_kit_websocket_endpoint *endpoint);

/** What one step of a platform byte stream did. */
enum iterate_kit_byte_stream_result {
  /** connect: the stream is ready. read and write: 1..n bytes moved. */
  ITERATE_KIT_BYTE_STREAM_PROGRESS = 0,
  /** Nothing can move yet: ask again on a later pass. */
  ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK,
  /** The connection is gone. The platform keeps the cause. */
  ITERATE_KIT_BYTE_STREAM_FAILED,
};

/**
 * One platform TCP or TLS connection, and the platform's randomness and SHA-1
 * (the upgrade's key and its RFC 6455 proof, and every frame's mask).
 *
 * The client calls these from its owner only. read and write never block.
 * connect performs one bounded establishment step and may block within the
 * platform's own setup bound: ESP-TLS verifies the server's certificate inside
 * one call. close ends the connection whatever state it reached, and is
 * called again harmlessly.
 */
struct iterate_kit_byte_stream_ops {
  enum iterate_kit_byte_stream_result (*connect)(void *context);
  enum iterate_kit_byte_stream_result (*read)(
      void *context, uint8_t *bytes, size_t capacity, size_t *bytes_read);
  enum iterate_kit_byte_stream_result (*write)(
      void *context,
      const uint8_t *bytes,
      size_t byte_count,
      size_t *bytes_written);
  void (*close)(void *context);
  enum iterate_kit_status (*random)(
      void *context, uint8_t *bytes, size_t byte_count);
  enum iterate_kit_status (*sha1)(
      void *context, const uint8_t *input, size_t size, uint8_t digest[20]);
};

/**
 * Caller-owned storage and dependencies, borrowed for the client's lifetime.
 *
 * The workspaces do double duty: the upgrade request is built in
 * transmit_storage and its answer read into receive_storage, both idle until
 * the first frame. headers, when set, is extra upgrade header lines, each
 * ending "\r\n"; it is read again at every open, so its owner may rewrite it
 * between generations.
 */
struct iterate_kit_websocket_client_options {
  const char *url;
  const char *headers;
  uint8_t *receive_storage;
  size_t receive_storage_capacity;
  uint8_t *transmit_storage;
  size_t transmit_storage_capacity;
  /**
   * A PING goes out when the peer has said nothing for this long, and at most
   * once per period; 0 never pings. Only inbound silence counts: local TCP
   * accepting microphone bytes cannot tell a dead peer from a live one.
   */
  uint32_t keepalive_ms;
  const struct iterate_kit_byte_stream_ops *stream;
  void *stream_context;
};

enum iterate_kit_websocket_open_result {
  ITERATE_KIT_WEBSOCKET_OPEN_READY = 0,
  ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK,
  ITERATE_KIT_WEBSOCKET_OPEN_FAILED,
};

/**
 * One receive attempt. IDLE covers both "no bytes" and a frame still arriving.
 * DROPPED is a frame the client discarded whole (an empty or unknown one).
 * DISCONNECTED means the stream failed; PROTOCOL_FAILURE that the peer broke
 * RFC 6455. After either, the generation is over and the owner must close it.
 */
enum iterate_kit_websocket_receive_result {
  ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE = 0,
  ITERATE_KIT_WEBSOCKET_RECEIVE_DATA,
  ITERATE_KIT_WEBSOCKET_RECEIVE_CONTROL,
  ITERATE_KIT_WEBSOCKET_RECEIVE_DROPPED,
  ITERATE_KIT_WEBSOCKET_RECEIVE_PEER_CLOSE,
  ITERATE_KIT_WEBSOCKET_RECEIVE_DISCONNECTED,
  ITERATE_KIT_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE,
};

/**
 * A chunk of one frame, borrowed from receive_storage (or, for a control
 * frame, the client's own accumulator) until the next receive, open or close.
 */
struct iterate_kit_websocket_chunk {
  const uint8_t *bytes;
  size_t byte_count;
  size_t payload_size;
  size_t payload_offset;
  uint8_t opcode;
  bool final;
};

/** Hop facts another task may sample: none is application delivery credit. */
struct iterate_kit_websocket_client_metrics {
  /** Complete frames from the peer, control frames included. */
  uint32_t frames_received;
  /** PONGs answering this client's PINGs: the idle hop's liveness. */
  uint32_t pongs_received;
  /**
   * The HTTP status of the latest upgrade answer: 101 once upgraded, 0 when no
   * answer arrived (the stream failed first), -1 when it did not parse.
   */
  int32_t last_upgrade_status;
  /** The latest peer CLOSE's RFC 6455 status code, 0 when it carried none. */
  int32_t last_peer_close_status_code;
};

/**
 * One owner drives the client: prepare once, then open, receive, send,
 * service_control and close per generation. It has no clock: the owner passes
 * monotonic microseconds. Only metrics may be called from another task.
 */
struct iterate_kit_websocket_client {
  struct iterate_kit_websocket_client_options options;
  /** Parsed from options.url by prepare; the platform dials this. */
  struct iterate_kit_websocket_endpoint endpoint;
  struct iterate_kit_websocket_frame_reader frame_reader;
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_tx tx;
  char expected_accept[ITERATE_KIT_WEBSOCKET_ACCEPT_CAPACITY];
  size_t request_size;
  size_t request_offset;
  size_t response_size;
  int64_t last_inbound_us;
  int64_t last_probe_us;
  uint32_t frames_received;
  uint32_t pongs_received;
  int32_t last_upgrade_status;
  int32_t last_peer_close_status_code;
  /**
   * Why the generation ended, as an errno the client chose: ECONNREFUSED for
   * an upgrade answered with another status, EPROTO for an answer or frame
   * that broke RFC 6455, EMSGSIZE for an answer or request larger than its
   * workspace, ENOBUFS for a control reply with no slot. 0 when the stream
   * itself failed: its platform keeps that cause.
   */
  int last_error;
  bool stream_connected;
  bool stream_failed;
  bool upgraded;
  bool peer_close_pending;
  bool initialized;
};

/** Binds storage and the stream and parses the URL. No I/O. */
enum iterate_kit_status iterate_kit_websocket_client_prepare(
    struct iterate_kit_websocket_client *client,
    const struct iterate_kit_websocket_client_options *options);

/**
 * Advances this generation's open as far as the stream allows: the stream's
 * connect, the upgrade request, then the answer, read a byte at a time so the
 * first frame is never swallowed into the HTTP workspace. READY starts the
 * keepalive clock at now_us. After FAILED the owner closes the client.
 */
enum iterate_kit_websocket_open_result iterate_kit_websocket_client_open(
    struct iterate_kit_websocket_client *client, int64_t now_us);

/**
 * At most one stream read. Frame boundaries survive any split: a short or
 * empty read never restarts a header or a payload. A PING queues its PONG and
 * a CLOSE its echo; service_control writes both.
 */
enum iterate_kit_websocket_receive_result
iterate_kit_websocket_client_receive(
    struct iterate_kit_websocket_client *client,
    int64_t now_us,
    struct iterate_kit_websocket_chunk *chunk);

/** Starts or resumes one data frame; offer the same frame until SENT. */
enum iterate_kit_websocket_tx_result iterate_kit_websocket_client_send(
    struct iterate_kit_websocket_client *client,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size);

/**
 * Queues the keepalive PING when it is due, then gives pending control frames
 * one nonblocking write. Call it every pass, backpressure or not.
 */
enum iterate_kit_websocket_tx_result
iterate_kit_websocket_client_service_control(
    struct iterate_kit_websocket_client *client, int64_t now_us);

/**
 * Ends the generation without waiting: one best-effort CLOSE when the stream
 * still works, then the stream closes and every partial frame is dropped.
 * Idempotent after prepare.
 */
void iterate_kit_websocket_client_close(
    struct iterate_kit_websocket_client *client);

void iterate_kit_websocket_client_metrics(
    const struct iterate_kit_websocket_client *client,
    struct iterate_kit_websocket_client_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
