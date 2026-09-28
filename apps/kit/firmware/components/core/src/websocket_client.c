#include "iterate/kit/websocket_client.h"

#include "iterate/kit/atomic.h"
#include "iterate/kit/voice_stream.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * The platform supplies bytes and nothing else: every decision about where an
 * HTTP answer ends or a frame starts is made here, so a short or empty read
 * on any platform means the same thing, and a host test can split the stream
 * anywhere.
 */

static const char websocket_guid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

enum {
  /** 16 random bytes, base64: RFC 6455's Sec-WebSocket-Key. */
  KEY_LENGTH = 24,
};

bool iterate_kit_websocket_endpoint_parse(
    const char *url, struct iterate_kit_websocket_endpoint *endpoint) {
  static const char secure_prefix[] = "wss://";
  static const char plain_prefix[] = "ws://";
  const char *authority;
  const char *host_end;
  const char *port_separator = NULL;
  const char *target;
  size_t host_length;
  size_t target_length;
  if (url == NULL || endpoint == NULL) {
    return false;
  }
  memset(endpoint, 0, sizeof(*endpoint));
  if (strncmp(url, secure_prefix, sizeof(secure_prefix) - 1U) == 0) {
    endpoint->secure = true;
    endpoint->port = 443U;
    authority = url + sizeof(secure_prefix) - 1U;
  } else if (strncmp(url, plain_prefix, sizeof(plain_prefix) - 1U) == 0) {
    endpoint->port = 80U;
    authority = url + sizeof(plain_prefix) - 1U;
  } else {
    return false;
  }
  host_end = authority + strcspn(authority, "/?#");
  if (host_end == authority ||
      memchr(authority, '@', (size_t)(host_end - authority)) != NULL ||
      strchr(host_end, '#') != NULL) {
    return false;
  }
  if (*authority == '[') {
    /* An IPv6 literal keeps its colons; the port follows the bracket. */
    const char *closing =
        memchr(authority, ']', (size_t)(host_end - authority));
    if (closing == NULL) {
      return false;
    }
    host_length = (size_t)(closing - authority - 1);
    ++authority;
    if (closing + 1 < host_end) {
      if (closing[1] != ':') {
        return false;
      }
      port_separator = closing + 1;
    }
  } else {
    port_separator =
        memchr(authority, ':', (size_t)(host_end - authority));
    host_length = port_separator != NULL
        ? (size_t)(port_separator - authority)
        : (size_t)(host_end - authority);
  }
  if (host_length == 0U || host_length >= sizeof(endpoint->host)) {
    return false;
  }
  memcpy(endpoint->host, authority, host_length);
  if (port_separator != NULL) {
    char *port_end = NULL;
    unsigned long port;
    if (!isdigit((unsigned char)port_separator[1])) {
      return false;
    }
    errno = 0;
    port = strtoul(port_separator + 1, &port_end, 10);
    if (errno != 0 || port_end != host_end || port == 0UL ||
        port > 65535UL) {
      return false;
    }
    endpoint->port = (uint16_t)port;
  }
  target = *host_end == '\0' ? "/" : host_end;
  target_length = strlen(target);
  if (target_length >= sizeof(endpoint->path)) {
    return false;
  }
  if (*target == '?') {
    /* A bare query still needs a path: "?a" asks for "/?a". */
    if (target_length + 1U >= sizeof(endpoint->path)) {
      return false;
    }
    endpoint->path[0] = '/';
    memcpy(endpoint->path + 1, target, target_length);
  } else {
    memcpy(endpoint->path, target, target_length);
  }
  return true;
}

/*
 * The bridges from the portable reader and writer to the stream. A FAILED
 * step is remembered so a broken stream is never reported as a broken frame.
 */
static enum iterate_kit_websocket_raw_read_result stream_read(
    void *context, uint8_t *bytes, size_t capacity, size_t *bytes_read) {
  struct iterate_kit_websocket_client *client = context;
  const enum iterate_kit_byte_stream_result result =
      client->options.stream->read(
          client->options.stream_context, bytes, capacity, bytes_read);
  if (result == ITERATE_KIT_BYTE_STREAM_PROGRESS) {
    return ITERATE_KIT_WEBSOCKET_RAW_READ;
  }
  *bytes_read = 0U;
  if (result == ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK) {
    return ITERATE_KIT_WEBSOCKET_RAW_READ_WOULD_BLOCK;
  }
  client->stream_failed = true;
  return ITERATE_KIT_WEBSOCKET_RAW_READ_DISCONNECTED;
}

static enum iterate_kit_websocket_tx_raw_write_result stream_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct iterate_kit_websocket_client *client = context;
  const enum iterate_kit_byte_stream_result result =
      client->options.stream->write(
          client->options.stream_context, bytes, byte_count, bytes_written);
  if (result == ITERATE_KIT_BYTE_STREAM_PROGRESS &&
      *bytes_written > 0U && *bytes_written <= byte_count) {
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
  }
  *bytes_written = 0U;
  if (result == ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK) {
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WOULD_BLOCK;
  }
  client->stream_failed = true;
  return ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED;
}

static enum iterate_kit_status stream_random(
    void *context, uint8_t *bytes, size_t byte_count) {
  struct iterate_kit_websocket_client *client = context;
  return client->options.stream->random(
      client->options.stream_context, bytes, byte_count);
}

enum iterate_kit_status iterate_kit_websocket_client_prepare(
    struct iterate_kit_websocket_client *client,
    const struct iterate_kit_websocket_client_options *options) {
  struct iterate_kit_websocket_frame_reader_options reader_options;
  struct iterate_kit_websocket_tx_options tx_options;
  const struct iterate_kit_byte_stream_ops *stream;
  if (client == NULL || options == NULL || options->url == NULL ||
      options->receive_storage == NULL ||
      options->receive_storage_capacity == 0U ||
      options->transmit_storage == NULL || options->stream == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  stream = options->stream;
  if (stream->connect == NULL || stream->read == NULL ||
      stream->write == NULL || stream->close == NULL ||
      stream->random == NULL || stream->sha1 == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(client, 0, sizeof(*client));
  client->options = *options;
  if (!iterate_kit_websocket_endpoint_parse(options->url, &client->endpoint)) {
    memset(client, 0, sizeof(*client));
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  reader_options = (struct iterate_kit_websocket_frame_reader_options){
    .payload_storage = options->receive_storage,
    .payload_storage_capacity = options->receive_storage_capacity,
    .raw_read = stream_read,
    .raw_read_context = client,
  };
  tx_options = (struct iterate_kit_websocket_tx_options){
    .frame_storage = options->transmit_storage,
    .frame_storage_capacity = options->transmit_storage_capacity,
    .raw_write = stream_write,
    .raw_write_context = client,
    .random = stream_random,
    .random_context = client,
  };
  if (iterate_kit_websocket_frame_reader_init(
          &client->frame_reader, &reader_options) != ITERATE_KIT_OK ||
      iterate_kit_websocket_rx_init(&client->rx) != ITERATE_KIT_OK ||
      iterate_kit_websocket_tx_init(&client->tx, &tx_options) !=
          ITERATE_KIT_OK) {
    memset(client, 0, sizeof(*client));
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  client->initialized = true;
  return ITERATE_KIT_OK;
}

/** RFC 6455 section 4.2.2: base64(SHA-1(key + GUID)). */
static bool compute_accept(
    struct iterate_kit_websocket_client *client,
    const char key[KEY_LENGTH],
    char accept[ITERATE_KIT_WEBSOCKET_ACCEPT_CAPACITY]) {
  uint8_t input[KEY_LENGTH + sizeof(websocket_guid) - 1U];
  uint8_t digest[20];
  memcpy(input, key, KEY_LENGTH);
  memcpy(input + KEY_LENGTH, websocket_guid, sizeof(websocket_guid) - 1U);
  if (client->options.stream->sha1(
          client->options.stream_context, input, sizeof(input), digest) !=
          ITERATE_KIT_OK ||
      iterate_kit_base64_encode(
          digest,
          sizeof(digest),
          accept,
          ITERATE_KIT_WEBSOCKET_ACCEPT_CAPACITY - 1U) !=
          ITERATE_KIT_WEBSOCKET_ACCEPT_CAPACITY - 1U) {
    return false;
  }
  accept[ITERATE_KIT_WEBSOCKET_ACCEPT_CAPACITY - 1U] = '\0';
  return true;
}

static bool build_request(struct iterate_kit_websocket_client *client) {
  uint8_t nonce[16];
  char key[KEY_LENGTH + 1U];
  char host[ITERATE_KIT_WEBSOCKET_HOST_CAPACITY + sizeof("[]:65535")];
  const struct iterate_kit_websocket_endpoint *endpoint = &client->endpoint;
  const bool default_port = endpoint->port == (endpoint->secure ? 443U : 80U);
  const bool literal_ipv6 = strchr(endpoint->host, ':') != NULL;
  int length;
  if (client->options.stream->random(
          client->options.stream_context, nonce, sizeof(nonce)) !=
          ITERATE_KIT_OK ||
      iterate_kit_base64_encode(nonce, sizeof(nonce), key, KEY_LENGTH) !=
          KEY_LENGTH) {
    client->last_error = EIO;
    return false;
  }
  key[KEY_LENGTH] = '\0';
  if (!compute_accept(client, key, client->expected_accept)) {
    client->last_error = EIO;
    return false;
  }
  if (default_port) {
    (void)snprintf(
        host, sizeof(host), literal_ipv6 ? "[%s]" : "%s", endpoint->host);
  } else {
    (void)snprintf(
        host,
        sizeof(host),
        literal_ipv6 ? "[%s]:%u" : "%s:%u",
        endpoint->host,
        (unsigned int)endpoint->port);
  }
  length = snprintf(
      (char *)client->options.transmit_storage,
      client->options.transmit_storage_capacity,
      "GET %s HTTP/1.1\r\n"
      "Host: %s\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: %s\r\n"
      "Sec-WebSocket-Version: 13\r\n"
      "User-Agent: iterate-kit/0\r\n"
      "%s\r\n",
      endpoint->path,
      host,
      key,
      client->options.headers != NULL ? client->options.headers : "");
  if (length <= 0 ||
      (size_t)length >= client->options.transmit_storage_capacity) {
    client->last_error = EMSGSIZE;
    return false;
  }
  client->request_size = (size_t)length;
  client->request_offset = 0U;
  client->response_size = 0U;
  return true;
}

static bool equal_ignoring_case(
    const char *left, size_t left_length, const char *right) {
  size_t index;
  if (left_length != strlen(right)) {
    return false;
  }
  for (index = 0U; index < left_length; ++index) {
    if (tolower((unsigned char)left[index]) !=
        tolower((unsigned char)right[index])) {
      return false;
    }
  }
  return true;
}

/** Whether a comma-separated header value lists `token`, ignoring case. */
static bool lists_token(const char *value, size_t length, const char *token) {
  size_t start = 0U;
  while (start < length) {
    size_t end;
    size_t trimmed;
    while (start < length &&
           (value[start] == ' ' || value[start] == '\t' ||
            value[start] == ',')) {
      ++start;
    }
    end = start;
    while (end < length && value[end] != ',') {
      ++end;
    }
    trimmed = end;
    while (trimmed > start &&
           (value[trimmed - 1U] == ' ' || value[trimmed - 1U] == '\t')) {
      --trimmed;
    }
    if (equal_ignoring_case(value + start, trimmed - start, token)) {
      return true;
    }
    start = end + 1U;
  }
  return false;
}

/** "HTTP/1.1 101 Switching Protocols" gives 101; -1 when the line is not one. */
static int32_t status_code(const char *line, size_t length) {
  static const char version[] = "HTTP/1.1 ";
  const size_t prefix = sizeof(version) - 1U;
  if (length < prefix + 3U || memcmp(line, version, prefix) != 0 ||
      !isdigit((unsigned char)line[prefix]) ||
      !isdigit((unsigned char)line[prefix + 1U]) ||
      !isdigit((unsigned char)line[prefix + 2U]) ||
      (length > prefix + 3U && line[prefix + 3U] != ' ')) {
    return -1;
  }
  return (int32_t)((line[prefix] - '0') * 100 +
                   (line[prefix + 1U] - '0') * 10 + (line[prefix + 2U] - '0'));
}

/**
 * The answer, headers only, from receive_storage. RFC 6455 section 4.1: a 101
 * that upgrades to websocket and proves it read this client's key.
 */
static bool upgrade_accepted(struct iterate_kit_websocket_client *client) {
  const char *cursor = (const char *)client->options.receive_storage;
  const char *const end = cursor + client->response_size;
  const char *line_end = memchr(cursor, '\r', (size_t)(end - cursor));
  bool upgrade = false;
  bool connection = false;
  bool accept = false;
  int32_t status;
  if (line_end == NULL) {
    status = -1;
  } else {
    status = status_code(cursor, (size_t)(line_end - cursor));
  }
  __atomic_store_n(&client->last_upgrade_status, status, __ATOMIC_RELAXED);
  if (status != 101) {
    client->last_error = status < 0 ? EPROTO : ECONNREFUSED;
    return false;
  }
  cursor = line_end + 2;
  /* Every line ends "\r\n", and the answer ends with an empty one. */
  while (cursor < end && *cursor != '\r') {
    const char *colon;
    const char *value;
    size_t value_length;
    line_end = memchr(cursor, '\r', (size_t)(end - cursor));
    if (line_end == NULL || line_end + 1 >= end || line_end[1] != '\n') {
      break;
    }
    colon = memchr(cursor, ':', (size_t)(line_end - cursor));
    if (colon != NULL) {
      const size_t name_length = (size_t)(colon - cursor);
      value = colon + 1;
      while (value < line_end && (*value == ' ' || *value == '\t')) {
        ++value;
      }
      value_length = (size_t)(line_end - value);
      while (value_length > 0U &&
             (value[value_length - 1U] == ' ' ||
              value[value_length - 1U] == '\t')) {
        --value_length;
      }
      if (equal_ignoring_case(cursor, name_length, "Upgrade")) {
        upgrade = lists_token(value, value_length, "websocket");
      } else if (equal_ignoring_case(cursor, name_length, "Connection")) {
        connection = lists_token(value, value_length, "Upgrade");
      } else if (equal_ignoring_case(
                     cursor, name_length, "Sec-WebSocket-Accept")) {
        accept = value_length == ITERATE_KIT_WEBSOCKET_ACCEPT_CAPACITY - 1U &&
            memcmp(value, client->expected_accept, value_length) == 0;
      }
    }
    cursor = line_end + 2;
  }
  if (!upgrade || !connection || !accept) {
    client->last_error = EPROTO;
    return false;
  }
  return true;
}

static enum iterate_kit_websocket_open_result open_failed_on_stream(
    struct iterate_kit_websocket_client *client) {
  client->stream_failed = true;
  client->last_error = 0;
  return ITERATE_KIT_WEBSOCKET_OPEN_FAILED;
}

enum iterate_kit_websocket_open_result iterate_kit_websocket_client_open(
    struct iterate_kit_websocket_client *client, int64_t now_us) {
  const struct iterate_kit_byte_stream_ops *stream;
  void *context;
  if (client == NULL || !client->initialized || client->stream_failed) {
    return ITERATE_KIT_WEBSOCKET_OPEN_FAILED;
  }
  if (client->upgraded) {
    return ITERATE_KIT_WEBSOCKET_OPEN_READY;
  }
  stream = client->options.stream;
  context = client->options.stream_context;
  if (!client->stream_connected) {
    enum iterate_kit_byte_stream_result result;
    __atomic_store_n(&client->last_upgrade_status, 0, __ATOMIC_RELAXED);
    result = stream->connect(context);
    if (result == ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK) {
      return ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK;
    }
    if (result != ITERATE_KIT_BYTE_STREAM_PROGRESS) {
      return open_failed_on_stream(client);
    }
    client->stream_connected = true;
    if (!build_request(client)) {
      return ITERATE_KIT_WEBSOCKET_OPEN_FAILED;
    }
  }
  while (client->request_offset < client->request_size) {
    const size_t remaining = client->request_size - client->request_offset;
    size_t written = 0U;
    const enum iterate_kit_byte_stream_result result = stream->write(
        context,
        client->options.transmit_storage + client->request_offset,
        remaining,
        &written);
    if (result == ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK) {
      return ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK;
    }
    if (result != ITERATE_KIT_BYTE_STREAM_PROGRESS || written == 0U ||
        written > remaining) {
      return open_failed_on_stream(client);
    }
    client->request_offset += written;
  }
  /*
   * ONE BYTE AT A TIME, so the read stops exactly at the blank line and the
   * server's first frame stays in the stream for the frame reader. A larger
   * read would pull those bytes into this HTTP workspace and lose them.
   */
  for (;;) {
    size_t count = 0U;
    enum iterate_kit_byte_stream_result result;
    uint8_t *const answer = client->options.receive_storage;
    if (client->response_size >= client->options.receive_storage_capacity) {
      client->last_error = EMSGSIZE;
      return ITERATE_KIT_WEBSOCKET_OPEN_FAILED;
    }
    result = stream->read(context, answer + client->response_size, 1U, &count);
    if (result == ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK) {
      return ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK;
    }
    if (result != ITERATE_KIT_BYTE_STREAM_PROGRESS || count != 1U) {
      return open_failed_on_stream(client);
    }
    ++client->response_size;
    if (client->response_size >= 4U &&
        memcmp(answer + client->response_size - 4U, "\r\n\r\n", 4U) == 0) {
      break;
    }
  }
  if (!upgrade_accepted(client)) {
    return ITERATE_KIT_WEBSOCKET_OPEN_FAILED;
  }
  client->upgraded = true;
  client->peer_close_pending = false;
  client->last_error = 0;
  iterate_kit_websocket_frame_reader_reset(&client->frame_reader);
  iterate_kit_websocket_rx_reset(&client->rx);
  iterate_kit_websocket_tx_reset(&client->tx);
  /* Nothing has been quiet yet: the first probe waits a whole period. */
  client->last_inbound_us = now_us;
  client->last_probe_us = now_us;
  return ITERATE_KIT_WEBSOCKET_OPEN_READY;
}

/** The generation is over; only close may follow. */
static enum iterate_kit_websocket_receive_result end_generation(
    struct iterate_kit_websocket_client *client,
    enum iterate_kit_websocket_receive_result result,
    int error) {
  client->upgraded = false;
  client->last_error = error;
  return result;
}

enum iterate_kit_websocket_receive_result
iterate_kit_websocket_client_receive(
    struct iterate_kit_websocket_client *client,
    int64_t now_us,
    struct iterate_kit_websocket_chunk *chunk) {
  struct iterate_kit_websocket_rx_read read;
  struct iterate_kit_websocket_rx_chunk classified;
  enum iterate_kit_websocket_rx_result result;
  enum iterate_kit_status status;
  if (chunk != NULL) {
    memset(chunk, 0, sizeof(*chunk));
  }
  if (client == NULL || !client->upgraded || chunk == NULL) {
    return ITERATE_KIT_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  status = iterate_kit_websocket_frame_reader_poll(&client->frame_reader, &read);
  if (status == ITERATE_KIT_UNAVAILABLE) {
    return ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE;
  }
  if (status != ITERATE_KIT_OK) {
    return client->stream_failed
        ? end_generation(client, ITERATE_KIT_WEBSOCKET_RECEIVE_DISCONNECTED, 0)
        : end_generation(
              client, ITERATE_KIT_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE, EPROTO);
  }
  result = iterate_kit_websocket_rx_feed(&client->rx, &read, &classified);
  if (result == ITERATE_KIT_WEBSOCKET_RX_IDLE ||
      result == ITERATE_KIT_WEBSOCKET_RX_PARTIAL) {
    if (read.byte_count > 0U) {
      client->last_inbound_us = now_us;
    }
    return ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE;
  }
  if (result == ITERATE_KIT_WEBSOCKET_RX_PROTOCOL_FAILURE) {
    return end_generation(
        client, ITERATE_KIT_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE, EPROTO);
  }
  /* Bytes from the peer prove this direction of the hop, whatever they are. */
  client->last_inbound_us = now_us;
  if (result == ITERATE_KIT_WEBSOCKET_RX_DROPPED) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &client->frames_received);
    client->last_error = EPROTO;
    return ITERATE_KIT_WEBSOCKET_RECEIVE_DROPPED;
  }
  chunk->bytes = classified.bytes;
  chunk->byte_count = classified.byte_count;
  chunk->payload_size = classified.payload_size;
  chunk->payload_offset = classified.payload_offset;
  chunk->opcode = (uint8_t)classified.opcode;
  chunk->final = classified.final;
  if (result == ITERATE_KIT_WEBSOCKET_RX_DATA) {
    if (classified.payload_offset + classified.byte_count ==
        classified.payload_size) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(
          &client->frames_received);
    }
    return ITERATE_KIT_WEBSOCKET_RECEIVE_DATA;
  }
  iterate_kit_atomic_saturating_increment_relaxed_u32(&client->frames_received);
  if (classified.opcode == ITERATE_KIT_WEBSOCKET_PONG) {
    /* HOP LIVENESS, AND NOTHING ELSE (websocket_tx.h): never delivery credit. */
    iterate_kit_atomic_saturating_increment_relaxed_u32(&client->pongs_received);
    return ITERATE_KIT_WEBSOCKET_RECEIVE_CONTROL;
  }
  /*
   * A PING's PONG and a CLOSE's echo are queued, never written from here: a
   * data frame may already be half on the wire. BACKPRESSURE means a CLOSE
   * already owns the writer, which a PONG cannot improve on.
   */
  status = iterate_kit_websocket_tx_queue_control(
      &client->tx,
      classified.opcode == ITERATE_KIT_WEBSOCKET_PING
          ? ITERATE_KIT_WEBSOCKET_PONG
          : ITERATE_KIT_WEBSOCKET_CLOSE,
      classified.bytes,
      classified.byte_count);
  if (status != ITERATE_KIT_OK && status != ITERATE_KIT_BACKPRESSURE) {
    return end_generation(
        client, ITERATE_KIT_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE, ENOBUFS);
  }
  if (classified.opcode == ITERATE_KIT_WEBSOCKET_PING) {
    return ITERATE_KIT_WEBSOCKET_RECEIVE_CONTROL;
  }
  __atomic_store_n(
      &client->last_peer_close_status_code,
      iterate_kit_websocket_close_status_code(
          classified.bytes, classified.byte_count),
      __ATOMIC_RELAXED);
  /* No data after the peer's CLOSE: only its echo may still go out. */
  client->peer_close_pending = true;
  return ITERATE_KIT_WEBSOCKET_RECEIVE_PEER_CLOSE;
}

static enum iterate_kit_websocket_tx_result remember_tx_failure(
    struct iterate_kit_websocket_client *client,
    enum iterate_kit_websocket_tx_result result) {
  if (result == ITERATE_KIT_WEBSOCKET_TX_FAILED ||
      result == ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED) {
    client->upgraded = false;
    client->last_error = client->stream_failed ? 0 : EIO;
  }
  return result;
}

enum iterate_kit_websocket_tx_result iterate_kit_websocket_client_send(
    struct iterate_kit_websocket_client *client,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  if (client == NULL || !client->upgraded || client->peer_close_pending) {
    return ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED;
  }
  return remember_tx_failure(
      client,
      iterate_kit_websocket_tx_send(&client->tx, opcode, payload, payload_size));
}

enum iterate_kit_websocket_tx_result
iterate_kit_websocket_client_service_control(
    struct iterate_kit_websocket_client *client, int64_t now_us) {
  const int64_t keepalive_us =
      client != NULL ? (int64_t)client->options.keepalive_ms * 1000 : 0;
  if (client == NULL || !client->upgraded) {
    return ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED;
  }
  /*
   * ASK, WHEN THE PEER HAS SAID NOTHING FOR A WHILE. A half-open TCP
   * connection — socket open, nothing arriving — is otherwise invisible, and
   * the PONG this earns is the one liveness signal still moving on an idle
   * board. A probe that cannot be queued is skipped: a full control slot is
   * itself evidence the socket is not idle.
   */
  if (keepalive_us > 0 && now_us - client->last_inbound_us > keepalive_us &&
      now_us - client->last_probe_us > keepalive_us &&
      iterate_kit_websocket_tx_queue_control(
          &client->tx, ITERATE_KIT_WEBSOCKET_PING, NULL, 0U) ==
          ITERATE_KIT_OK) {
    client->last_probe_us = now_us;
  }
  return remember_tx_failure(
      client, iterate_kit_websocket_tx_poll_control(&client->tx));
}

void iterate_kit_websocket_client_close(
    struct iterate_kit_websocket_client *client) {
  if (client == NULL || !client->initialized) {
    return;
  }
  if (client->upgraded && !client->stream_failed) {
    /*
     * A generation boundary cannot wait for writability, but one immediate
     * attempt keeps RFC 6455's orderly close whenever the socket takes it.
     * A peer CLOSE has already queued its echo.
     */
    if (!client->peer_close_pending) {
      (void)iterate_kit_websocket_tx_queue_control(
          &client->tx, ITERATE_KIT_WEBSOCKET_CLOSE, NULL, 0U);
    }
    (void)iterate_kit_websocket_tx_poll_control(&client->tx);
  }
  client->options.stream->close(client->options.stream_context);
  iterate_kit_websocket_frame_reader_reset(&client->frame_reader);
  iterate_kit_websocket_rx_reset(&client->rx);
  iterate_kit_websocket_tx_reset(&client->tx);
  client->request_size = 0U;
  client->request_offset = 0U;
  client->response_size = 0U;
  client->stream_connected = false;
  client->stream_failed = false;
  client->upgraded = false;
  client->peer_close_pending = false;
}

void iterate_kit_websocket_client_metrics(
    const struct iterate_kit_websocket_client *client,
    struct iterate_kit_websocket_client_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (client == NULL || !client->initialized) {
    return;
  }
  metrics->frames_received =
      iterate_kit_atomic_load_relaxed_u32(&client->frames_received);
  metrics->pongs_received =
      iterate_kit_atomic_load_relaxed_u32(&client->pongs_received);
  metrics->last_upgrade_status =
      __atomic_load_n(&client->last_upgrade_status, __ATOMIC_RELAXED);
  metrics->last_peer_close_status_code =
      __atomic_load_n(&client->last_peer_close_status_code, __ATOMIC_RELAXED);
}
