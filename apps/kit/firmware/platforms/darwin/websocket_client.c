#include "iterate/kit/platforms/posix_websocket_client.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/evp.h>
#include <openssl/rand.h>

static const char websocket_guid[] =
    "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/*
 * The upgrade is deliberately incremental. Reading one header byte per poll
 * is setup-only work, but it proves the first WebSocket frame can never be
 * over-read into an HTTP scratch buffer and discarded. Steady-state payloads
 * use the full caller workspace and remain bounded by one TLS read per poll.
 */

static bool ascii_equal_nocase(
    const char *left, const char *right, size_t length) {
  size_t index;
  for (index = 0U; index < length; ++index) {
    if (tolower((unsigned char)left[index]) !=
        tolower((unsigned char)right[index])) {
      return false;
    }
  }
  return true;
}

static bool header_token(
    const char *value, size_t length, const char *token) {
  const size_t token_length = strlen(token);
  size_t start = 0U;
  while (start < length) {
    size_t end;
    while (start < length &&
           (value[start] == ' ' || value[start] == '\t' ||
            value[start] == ',')) {
      ++start;
    }
    end = start;
    while (end < length && value[end] != ',') {
      ++end;
    }
    while (end > start &&
           (value[end - 1U] == ' ' || value[end - 1U] == '\t')) {
      --end;
    }
    if (end - start == token_length &&
        ascii_equal_nocase(value + start, token, token_length)) {
      return true;
    }
    start = end + 1U;
  }
  return false;
}

enum iterate_kit_status
iterate_kit_posix_websocket_compute_accept(
    const char *client_key,
    char *destination,
    size_t destination_capacity) {
  char input[24U + sizeof(websocket_guid) - 1U];
  uint8_t digest[EVP_MAX_MD_SIZE];
  size_t digest_size = 0U;
  size_t client_key_length;
  int encoded_size;
  if (client_key == NULL || destination == NULL ||
      destination_capacity < ITERATE_KIT_POSIX_WEBSOCKET_ACCEPT_CAPACITY) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  client_key_length = strlen(client_key);
  if (client_key_length != 24U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memcpy(input, client_key, client_key_length);
  memcpy(
      input + client_key_length,
      websocket_guid,
      sizeof(websocket_guid) - 1U);
  if (EVP_Q_digest(
          NULL,
          "SHA1",
          NULL,
          input,
          sizeof(input),
          digest,
          &digest_size) != 1) {
    return ITERATE_KIT_IO_ERROR;
  }
  encoded_size = EVP_EncodeBlock(
      (unsigned char *)destination, digest, (int)digest_size);
  if (encoded_size != 28) {
    memset(destination, 0, destination_capacity);
    return ITERATE_KIT_IO_ERROR;
  }
  destination[encoded_size] = '\0';
  return ITERATE_KIT_OK;
}

static bool parse_url(
    struct iterate_kit_posix_websocket_client *client,
    const char *url) {
  static const char secure_prefix[] = "wss://";
  static const char plain_prefix[] = "ws://";
  const char *authority;
  const char *path;
  const char *host_end;
  const char *port_separator = NULL;
  size_t host_length;
  size_t path_length;
  char *port_end;
  unsigned long parsed_port;
  if (strncmp(url, secure_prefix, sizeof(secure_prefix) - 1U) == 0) {
    client->secure = true;
    authority = url + sizeof(secure_prefix) - 1U;
  } else if (strncmp(url, plain_prefix, sizeof(plain_prefix) - 1U) == 0) {
    client->secure = false;
    authority = url + sizeof(plain_prefix) - 1U;
  } else {
    return false;
  }
  path = strchr(authority, '/');
  host_end = path != NULL ? path : authority + strlen(authority);
  if (authority == host_end || memchr(authority, '@', (size_t)(host_end - authority)) != NULL ||
      strchr(host_end, '#') != NULL) {
    return false;
  }
  if (*authority == '[') {
    const char *closing = memchr(
        authority, ']', (size_t)(host_end - authority));
    if (closing == NULL) {
      return false;
    }
    host_length = (size_t)(closing - authority - 1);
    authority += 1;
    if (closing + 1 < host_end) {
      if (closing[1] != ':') {
        return false;
      }
      port_separator = closing + 1;
    }
  } else {
    const char *cursor;
    host_length = (size_t)(host_end - authority);
    for (cursor = authority; cursor < host_end; ++cursor) {
      if (*cursor == ':') {
        if (port_separator != NULL) {
          return false;
        }
        port_separator = cursor;
      }
    }
    if (port_separator != NULL) {
      host_length = (size_t)(port_separator - authority);
    }
  }
  if (host_length == 0U || host_length >= sizeof(client->host)) {
    return false;
  }
  memcpy(client->host, authority, host_length);
  client->host[host_length] = '\0';
  client->port = client->secure ? 443U : 80U;
  if (port_separator != NULL) {
    errno = 0;
    parsed_port = strtoul(port_separator + 1, &port_end, 10);
    if (errno != 0 || port_end != host_end || parsed_port == 0UL ||
        parsed_port > 65535UL) {
      return false;
    }
    client->port = (uint16_t)parsed_port;
  }
  path = path != NULL ? path : "/";
  path_length = strlen(path);
  if (path_length == 0U || path_length >= sizeof(client->path)) {
    return false;
  }
  memcpy(client->path, path, path_length + 1U);
  return true;
}

static enum iterate_kit_websocket_tx_raw_write_result raw_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct iterate_kit_posix_websocket_client *client = context;
  const enum iterate_kit_posix_tls_io_result result =
      iterate_kit_posix_tls_stream_write(
          &client->stream, bytes, byte_count, bytes_written);
  if (result == ITERATE_KIT_POSIX_TLS_IO_PROGRESS) {
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
  }
  return result == ITERATE_KIT_POSIX_TLS_IO_WOULD_BLOCK
      ? ITERATE_KIT_WEBSOCKET_TX_RAW_WOULD_BLOCK
      : ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED;
}

static enum iterate_kit_status random_bytes(
    void *context, uint8_t *bytes, size_t byte_count) {
  (void)context;
  return bytes != NULL && byte_count > 0U &&
          RAND_bytes(bytes, (int)byte_count) == 1
      ? ITERATE_KIT_OK
      : ITERATE_KIT_IO_ERROR;
}

static enum iterate_kit_websocket_raw_read_result raw_read(
    void *context,
    uint8_t *bytes,
    size_t byte_capacity,
    size_t *bytes_read) {
  struct iterate_kit_posix_websocket_client *client = context;
  const enum iterate_kit_posix_tls_io_result result =
      iterate_kit_posix_tls_stream_read(
          &client->stream, bytes, byte_capacity, bytes_read);
  if (result == ITERATE_KIT_POSIX_TLS_IO_PROGRESS) {
    return ITERATE_KIT_WEBSOCKET_RAW_READ;
  }
  return result == ITERATE_KIT_POSIX_TLS_IO_WOULD_BLOCK
      ? ITERATE_KIT_WEBSOCKET_RAW_READ_WOULD_BLOCK
      : ITERATE_KIT_WEBSOCKET_RAW_READ_DISCONNECTED;
}

enum iterate_kit_status iterate_kit_posix_websocket_client_prepare(
    struct iterate_kit_posix_websocket_client *client,
    const struct iterate_kit_posix_websocket_client_options *options) {
  struct iterate_kit_posix_tls_stream_options tls_options;
  struct iterate_kit_websocket_frame_reader_options reader_options;
  struct iterate_kit_websocket_tx_options tx_options;
  enum iterate_kit_status status;
  if (client == NULL || options == NULL || options->url == NULL ||
      options->receive_storage == NULL ||
      options->receive_storage_capacity == 0U ||
      options->transmit_storage == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(client, 0, sizeof(*client));
  client->options = *options;
  if (!parse_url(client, options->url)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  tls_options = (struct iterate_kit_posix_tls_stream_options){
    .host = client->host,
    .port = client->port,
    .use_tls = client->secure,
    .DANGEROUS_disable_certificate_verification =
        client->secure &&
        options->DANGEROUS_disable_certificate_verification,
  };
  status = iterate_kit_posix_tls_stream_prepare(
      &client->stream, &tls_options);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  reader_options =
      (struct iterate_kit_websocket_frame_reader_options){
        .payload_storage = options->receive_storage,
        .payload_storage_capacity = options->receive_storage_capacity,
        .raw_read = raw_read,
        .raw_read_context = client,
      };
  tx_options = (struct iterate_kit_websocket_tx_options){
    .frame_storage = options->transmit_storage,
    .frame_storage_capacity = options->transmit_storage_capacity,
    .raw_write = raw_write,
    .raw_write_context = client,
    .random = random_bytes,
    .random_context = client,
  };
  if (iterate_kit_websocket_frame_reader_init(
          &client->frame_reader, &reader_options) != ITERATE_KIT_OK ||
      iterate_kit_websocket_rx_init(&client->rx) != ITERATE_KIT_OK ||
      iterate_kit_websocket_tx_init(
          &client->tx, &tx_options) != ITERATE_KIT_OK) {
    iterate_kit_posix_tls_stream_cleanup(&client->stream);
    memset(client, 0, sizeof(*client));
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  client->initialized = true;
  return ITERATE_KIT_OK;
}

static bool build_request(
    struct iterate_kit_posix_websocket_client *client) {
  uint8_t nonce[16];
  char key[25];
  int request_size;
  if (RAND_bytes(nonce, (int)sizeof(nonce)) != 1 ||
      EVP_EncodeBlock(
          (unsigned char *)key, nonce, (int)sizeof(nonce)) != 24 ||
      iterate_kit_posix_websocket_compute_accept(
          key,
          client->expected_accept,
          sizeof(client->expected_accept)) != ITERATE_KIT_OK) {
    return false;
  }
  key[24] = '\0';
  request_size = ((client->secure && client->port == 443U) ||
                  (!client->secure && client->port == 80U))
      ? snprintf(
            client->request,
            sizeof(client->request),
            "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\nUser-Agent: iterate-kit/0\r\n\r\n",
            client->path,
            client->host,
            key)
      : snprintf(
            client->request,
            sizeof(client->request),
            "GET %s HTTP/1.1\r\nHost: %s:%u\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\nUser-Agent: iterate-kit/0\r\n\r\n",
            client->path,
            client->host,
            (unsigned int)client->port,
            key);
  if (request_size <= 0 || (size_t)request_size >= sizeof(client->request)) {
    return false;
  }
  client->request_size = (size_t)request_size;
  client->request_offset = 0U;
  client->response_size = 0U;
  client->request_built = true;
  return true;
}

static bool validate_response(
    struct iterate_kit_posix_websocket_client *client) {
  const char *cursor = client->response;
  const char *end = client->response + client->response_size;
  bool upgrade = false;
  bool connection = false;
  bool accept = false;
  const char expected_status[] = "HTTP/1.1 101";
  const char *line_end = strstr(cursor, "\r\n");
  if (line_end == NULL ||
      (size_t)(line_end - cursor) < sizeof(expected_status) - 1U ||
      memcmp(cursor, expected_status, sizeof(expected_status) - 1U) != 0 ||
      ((size_t)(line_end - cursor) > sizeof(expected_status) - 1U &&
       cursor[sizeof(expected_status) - 1U] != ' ')) {
    return false;
  }
  cursor = line_end + 2;
  while (cursor < end && cursor[0] != '\r') {
    const char *colon;
    size_t name_length;
    const char *value;
    size_t value_length;
    line_end = strstr(cursor, "\r\n");
    if (line_end == NULL || line_end > end) {
      return false;
    }
    colon = memchr(cursor, ':', (size_t)(line_end - cursor));
    if (colon == NULL) {
      return false;
    }
    name_length = (size_t)(colon - cursor);
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
    if (name_length == 7U &&
        ascii_equal_nocase(cursor, "Upgrade", 7U)) {
      upgrade = header_token(value, value_length, "websocket");
    } else if (name_length == 10U &&
               ascii_equal_nocase(cursor, "Connection", 10U)) {
      connection = header_token(value, value_length, "Upgrade");
    } else if (name_length == 20U &&
               ascii_equal_nocase(
                   cursor, "Sec-WebSocket-Accept", 20U)) {
      accept = value_length == strlen(client->expected_accept) &&
          memcmp(value, client->expected_accept, value_length) == 0;
    }
    cursor = line_end + 2;
  }
  return upgrade && connection && accept;
}

enum iterate_kit_posix_websocket_open_result
iterate_kit_posix_websocket_client_open(
    struct iterate_kit_posix_websocket_client *client) {
  size_t progress = 0U;
  enum iterate_kit_posix_tls_io_result io_result;
  enum iterate_kit_posix_tls_connect_result connect_result;
  if (client == NULL || !client->initialized) {
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED;
  }
  if (client->upgraded) {
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_READY;
  }
  connect_result = iterate_kit_posix_tls_stream_connect(&client->stream);
  if (connect_result == ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK) {
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_WOULD_BLOCK;
  }
  if (connect_result != ITERATE_KIT_POSIX_TLS_CONNECT_READY) {
    client->last_error = client->stream.last_errno != 0
        ? client->stream.last_errno
        : EIO;
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED;
  }
  if (!client->request_built && !build_request(client)) {
    client->last_error = EIO;
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED;
  }
  if (client->request_offset < client->request_size) {
    io_result = iterate_kit_posix_tls_stream_write(
        &client->stream,
        (const uint8_t *)client->request + client->request_offset,
        client->request_size - client->request_offset,
        &progress);
    if (io_result == ITERATE_KIT_POSIX_TLS_IO_WOULD_BLOCK) {
      return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_WOULD_BLOCK;
    }
    if (io_result != ITERATE_KIT_POSIX_TLS_IO_PROGRESS) {
      client->last_error = client->stream.last_errno != 0
          ? client->stream.last_errno
          : EIO;
      return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED;
    }
    client->request_offset += progress;
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_WOULD_BLOCK;
  }
  if (client->response_size >= sizeof(client->response) - 1U) {
    client->last_error = EMSGSIZE;
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED;
  }
  io_result = iterate_kit_posix_tls_stream_read(
      &client->stream,
      (uint8_t *)client->response + client->response_size,
      1U,
      &progress);
  if (io_result == ITERATE_KIT_POSIX_TLS_IO_WOULD_BLOCK) {
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_WOULD_BLOCK;
  }
  if (io_result != ITERATE_KIT_POSIX_TLS_IO_PROGRESS || progress != 1U) {
    client->last_error = client->stream.last_errno != 0
        ? client->stream.last_errno
        : ECONNRESET;
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED;
  }
  client->response_size += 1U;
  client->response[client->response_size] = '\0';
  if (client->response_size < 4U ||
      memcmp(
          client->response + client->response_size - 4U,
          "\r\n\r\n",
          4U) != 0) {
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_WOULD_BLOCK;
  }
  if (!validate_response(client)) {
    client->last_error = EPROTO;
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED;
  }
  client->upgraded = true;
  client->last_error = 0;
  client->peer_close_pending = false;
  iterate_kit_websocket_frame_reader_reset(&client->frame_reader);
  iterate_kit_websocket_rx_reset(&client->rx);
  iterate_kit_websocket_tx_reset(&client->tx);
  return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_READY;
}

enum iterate_kit_posix_websocket_receive_result
iterate_kit_posix_websocket_client_receive(
    struct iterate_kit_posix_websocket_client *client,
    struct iterate_kit_posix_websocket_chunk *chunk) {
  struct iterate_kit_websocket_rx_read read;
  struct iterate_kit_websocket_rx_chunk classified;
  enum iterate_kit_websocket_rx_result result;
  enum iterate_kit_status status;
  if (chunk != NULL) {
    memset(chunk, 0, sizeof(*chunk));
  }
  if (client == NULL || !client->upgraded || chunk == NULL) {
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  status = iterate_kit_websocket_frame_reader_poll(
      &client->frame_reader, &read);
  if (status == ITERATE_KIT_UNAVAILABLE) {
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_IDLE;
  }
  if (status != ITERATE_KIT_OK) {
    client->last_error = client->stream.last_errno != 0
        ? client->stream.last_errno
        : ECONNRESET;
    client->upgraded = false;
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_DISCONNECTED;
  }
  result = iterate_kit_websocket_rx_feed(
      &client->rx, &read, &classified);
  if (result == ITERATE_KIT_WEBSOCKET_RX_IDLE ||
      result == ITERATE_KIT_WEBSOCKET_RX_PARTIAL) {
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_IDLE;
  }
  if (result == ITERATE_KIT_WEBSOCKET_RX_DROPPED) {
    client->last_error = EPROTO;
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_DROPPED;
  }
  if (result == ITERATE_KIT_WEBSOCKET_RX_PROTOCOL_FAILURE) {
    client->last_error = EPROTO;
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  chunk->bytes = classified.bytes;
  chunk->byte_count = classified.byte_count;
  chunk->payload_size = classified.payload_size;
  chunk->payload_offset = classified.payload_offset;
  chunk->opcode = (uint8_t)classified.opcode;
  chunk->final = classified.final;
  if (result == ITERATE_KIT_WEBSOCKET_RX_DATA) {
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_DATA;
  }
  if (classified.opcode == ITERATE_KIT_WEBSOCKET_PING) {
    status = iterate_kit_websocket_tx_queue_control(
        &client->tx,
        ITERATE_KIT_WEBSOCKET_PONG,
        classified.bytes,
        classified.byte_count);
    if (status != ITERATE_KIT_OK) {
      client->last_error = ENOBUFS;
      return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
    }
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_CONTROL;
  }
  if (classified.opcode == ITERATE_KIT_WEBSOCKET_PONG) {
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_CONTROL;
  }
  status = iterate_kit_websocket_tx_queue_control(
      &client->tx,
      ITERATE_KIT_WEBSOCKET_CLOSE,
      classified.bytes,
      classified.byte_count);
  client->peer_close_pending = true;
  if (status != ITERATE_KIT_OK) {
    client->last_error = ENOBUFS;
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PEER_CLOSE;
}

enum iterate_kit_websocket_tx_result
iterate_kit_posix_websocket_client_send(
    struct iterate_kit_posix_websocket_client *client,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  enum iterate_kit_websocket_tx_result result;
  if (client == NULL || !client->upgraded || client->peer_close_pending) {
    return ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED;
  }
  result = iterate_kit_websocket_tx_send(
      &client->tx, opcode, payload, payload_size);
  if (result == ITERATE_KIT_WEBSOCKET_TX_FAILED ||
      result == ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED) {
    client->last_error = client->stream.last_errno != 0
        ? client->stream.last_errno
        : EIO;
  }
  return result;
}

enum iterate_kit_websocket_tx_result
iterate_kit_posix_websocket_client_service_control(
    struct iterate_kit_posix_websocket_client *client) {
  enum iterate_kit_websocket_tx_result result;
  if (client == NULL || !client->upgraded) {
    return ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED;
  }
  result = iterate_kit_websocket_tx_poll_control(&client->tx);
  if (result == ITERATE_KIT_WEBSOCKET_TX_FAILED ||
      result == ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED) {
    client->last_error = client->stream.last_errno != 0
        ? client->stream.last_errno
        : EIO;
  }
  return result;
}

void iterate_kit_posix_websocket_client_close(
    struct iterate_kit_posix_websocket_client *client) {
  if (client == NULL || !client->initialized) {
    return;
  }
  if (client->upgraded) {
    /*
     * A hard generation boundary cannot wait for socket writability, but one
     * best-effort masked CLOSE preserves the normal RFC path whenever the
     * stream accepts it immediately. Peer-close handling has already queued
     * the echoed payload; a local stop queues an empty close here.
     */
    if (!client->peer_close_pending) {
      (void)iterate_kit_websocket_tx_queue_control(
          &client->tx, ITERATE_KIT_WEBSOCKET_CLOSE, NULL, 0U);
    }
    (void)iterate_kit_websocket_tx_poll_control(&client->tx);
  }
  client->upgraded = false;
  client->peer_close_pending = false;
  client->request_built = false;
  client->request_size = 0U;
  client->request_offset = 0U;
  client->response_size = 0U;
  iterate_kit_websocket_frame_reader_reset(&client->frame_reader);
  iterate_kit_websocket_rx_reset(&client->rx);
  iterate_kit_websocket_tx_reset(&client->tx);
  iterate_kit_posix_tls_stream_close(&client->stream);
}

void iterate_kit_posix_websocket_client_cleanup(
    struct iterate_kit_posix_websocket_client *client) {
  if (client == NULL || !client->initialized) {
    return;
  }
  iterate_kit_posix_websocket_client_close(client);
  iterate_kit_posix_tls_stream_cleanup(&client->stream);
  memset(client, 0, sizeof(*client));
}
