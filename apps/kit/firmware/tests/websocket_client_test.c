/*
 * THE ONE WEBSOCKET CLIENT, OVER A SCRIPTED BYTE STREAM.
 *
 * Every platform's bytes reach the same client (components/core), so the
 * splits a TLS stack or a lossy radio can produce are played here: a header
 * cut after any byte, a payload stalled mid-frame, the upgrade's answer and
 * the first frame in one read, a peer that refuses the key.
 */
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice_stream.h"
#include "iterate/kit/websocket_client.h"

#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/*
 * SHA-1 (RFC 3174) for the fake stream's `sha1`, because a platform supplies
 * the real one. Checked against the RFC's own vector before any handshake
 * trusts it.
 */
static uint32_t rotate_left(uint32_t value, unsigned int bits) {
  return (value << bits) | (value >> (32U - bits));
}

static void sha1(const uint8_t *input, size_t size, uint8_t digest[20]) {
  uint32_t state[5] = {
    0x67452301U, 0xEFCDAB89U, 0x98BADCFEU, 0x10325476U, 0xC3D2E1F0U,
  };
  uint8_t block[64];
  const uint64_t bits = (uint64_t)size * 8U;
  size_t offset = 0U;
  bool padded = false;
  bool length_written = false;
  while (!length_written) {
    size_t used = 0U;
    uint32_t words[80];
    uint32_t a;
    uint32_t b;
    uint32_t c;
    uint32_t d;
    uint32_t e;
    unsigned int index;
    memset(block, 0, sizeof(block));
    if (offset < size) {
      used = size - offset < sizeof(block) ? size - offset : sizeof(block);
      memcpy(block, input + offset, used);
      offset += used;
    }
    if (used < sizeof(block) && !padded) {
      block[used++] = 0x80U;
      padded = true;
    }
    if (padded && used <= 56U) {
      for (index = 0U; index < 8U; ++index) {
        block[63U - index] = (uint8_t)(bits >> (8U * index));
      }
      length_written = true;
    }
    for (index = 0U; index < 16U; ++index) {
      words[index] = (uint32_t)block[index * 4U] << 24 |
          (uint32_t)block[index * 4U + 1U] << 16 |
          (uint32_t)block[index * 4U + 2U] << 8 | block[index * 4U + 3U];
    }
    for (index = 16U; index < 80U; ++index) {
      words[index] = rotate_left(
          words[index - 3U] ^ words[index - 8U] ^ words[index - 14U] ^
              words[index - 16U],
          1U);
    }
    a = state[0];
    b = state[1];
    c = state[2];
    d = state[3];
    e = state[4];
    for (index = 0U; index < 80U; ++index) {
      uint32_t f;
      uint32_t k;
      uint32_t next;
      if (index < 20U) {
        f = (b & c) | (~b & d);
        k = 0x5A827999U;
      } else if (index < 40U) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1U;
      } else if (index < 60U) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDCU;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6U;
      }
      next = rotate_left(a, 5U) + f + e + k + words[index];
      e = d;
      d = c;
      c = rotate_left(b, 30U);
      b = a;
      a = next;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
  }
  for (offset = 0U; offset < 20U; ++offset) {
    digest[offset] = (uint8_t)(state[offset / 4U] >> (24U - 8U * (offset % 4U)));
  }
}

/* --- the scripted stream ------------------------------------------------ */

enum {
  WIRE_SEGMENTS = 32,
  SEGMENT_BYTES = 512,
  SENT_BYTES = 4096,
};

/** One scripted read outcome: bytes, or a stall, or a failure. */
struct segment {
  uint8_t bytes[SEGMENT_BYTES];
  size_t size;
  size_t offset;
  enum iterate_kit_byte_stream_result result;
};

struct stream {
  struct segment wire[WIRE_SEGMENTS];
  size_t segment_count;
  size_t segment_index;
  uint8_t sent[SENT_BYTES];
  size_t sent_size;
  /** 0 takes everything offered; otherwise the most one write accepts. */
  size_t write_limit;
  unsigned int writes_to_defer;
  unsigned int connects_to_defer;
  bool connect_fails;
  bool reads_fail;
  unsigned int connects;
  unsigned int closes;
  uint8_t next_random;
  /** Random bytes to hand out first: the key's nonce, when a test sets it. */
  const uint8_t *nonce;
  size_t nonce_size;
};

static enum iterate_kit_byte_stream_result fake_connect(void *context) {
  struct stream *stream = context;
  ++stream->connects;
  if (stream->connects_to_defer > 0U) {
    --stream->connects_to_defer;
    return ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK;
  }
  return stream->connect_fails ? ITERATE_KIT_BYTE_STREAM_FAILED
                               : ITERATE_KIT_BYTE_STREAM_PROGRESS;
}

static enum iterate_kit_byte_stream_result fake_read(
    void *context, uint8_t *bytes, size_t capacity, size_t *bytes_read) {
  struct stream *stream = context;
  struct segment *segment;
  size_t count;
  *bytes_read = 0U;
  assert(capacity > 0U);
  if (stream->reads_fail) {
    return ITERATE_KIT_BYTE_STREAM_FAILED;
  }
  if (stream->segment_index == stream->segment_count) {
    return ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK;
  }
  segment = &stream->wire[stream->segment_index];
  if (segment->result != ITERATE_KIT_BYTE_STREAM_PROGRESS) {
    ++stream->segment_index;
    return segment->result;
  }
  count = segment->size - segment->offset < capacity
      ? segment->size - segment->offset
      : capacity;
  memcpy(bytes, segment->bytes + segment->offset, count);
  segment->offset += count;
  if (segment->offset == segment->size) {
    ++stream->segment_index;
  }
  *bytes_read = count;
  return ITERATE_KIT_BYTE_STREAM_PROGRESS;
}

static enum iterate_kit_byte_stream_result fake_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct stream *stream = context;
  size_t count = byte_count;
  *bytes_written = 0U;
  if (stream->writes_to_defer > 0U) {
    --stream->writes_to_defer;
    return ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK;
  }
  if (stream->write_limit != 0U && count > stream->write_limit) {
    count = stream->write_limit;
  }
  assert(count <= sizeof(stream->sent) - stream->sent_size);
  memcpy(stream->sent + stream->sent_size, bytes, count);
  stream->sent_size += count;
  *bytes_written = count;
  return ITERATE_KIT_BYTE_STREAM_PROGRESS;
}

static void fake_close(void *context) {
  struct stream *stream = context;
  ++stream->closes;
}

static enum iterate_kit_status fake_random(
    void *context, uint8_t *bytes, size_t byte_count) {
  struct stream *stream = context;
  size_t index;
  for (index = 0U; index < byte_count; ++index) {
    if (stream->nonce_size > 0U) {
      bytes[index] = *stream->nonce++;
      --stream->nonce_size;
    } else {
      bytes[index] = stream->next_random++;
    }
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status fake_sha1(
    void *context, const uint8_t *input, size_t size, uint8_t digest[20]) {
  (void)context;
  sha1(input, size, digest);
  return ITERATE_KIT_OK;
}

static const struct iterate_kit_byte_stream_ops fake_stream_ops = {
  .connect = fake_connect,
  .read = fake_read,
  .write = fake_write,
  .close = fake_close,
  .random = fake_random,
  .sha1 = fake_sha1,
};

static void wire_bytes(struct stream *stream, const void *bytes, size_t size) {
  struct segment *segment;
  assert(stream->segment_count < WIRE_SEGMENTS && size <= SEGMENT_BYTES);
  segment = &stream->wire[stream->segment_count++];
  memset(segment, 0, sizeof(*segment));
  memcpy(segment->bytes, bytes, size);
  segment->size = size;
  segment->result = ITERATE_KIT_BYTE_STREAM_PROGRESS;
}

static void wire_text(struct stream *stream, const char *text) {
  wire_bytes(stream, text, strlen(text));
}

static void wire_stall(struct stream *stream) {
  assert(stream->segment_count < WIRE_SEGMENTS);
  memset(&stream->wire[stream->segment_count], 0, sizeof(struct segment));
  stream->wire[stream->segment_count++].result =
      ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK;
}

/* --- fixtures ------------------------------------------------------------ */

struct fixture {
  struct stream stream;
  struct iterate_kit_websocket_client client;
  uint8_t receive_storage[1024];
  uint8_t transmit_storage[ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(512)];
};

static void prepare(
    struct fixture *fixture, const char *url, const char *headers) {
  const struct iterate_kit_websocket_client_options options = {
    .url = url,
    .headers = headers,
    .receive_storage = fixture->receive_storage,
    .receive_storage_capacity = sizeof(fixture->receive_storage),
    .transmit_storage = fixture->transmit_storage,
    .transmit_storage_capacity = sizeof(fixture->transmit_storage),
    .keepalive_ms = ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS,
    .stream = &fake_stream_ops,
    .stream_context = &fixture->stream,
  };
  memset(fixture, 0, sizeof(*fixture));
  fixture->stream.next_random = 1U;
  assert(iterate_kit_websocket_client_prepare(&fixture->client, &options) ==
      ITERATE_KIT_OK);
}

/** The Sec-WebSocket-Key the client sent, as the server reads it. */
static void sent_key(const struct fixture *fixture, char key[25]) {
  static const char field[] = "Sec-WebSocket-Key: ";
  const char *found;
  char request[SENT_BYTES + 1];
  memcpy(request, fixture->stream.sent, fixture->stream.sent_size);
  request[fixture->stream.sent_size] = '\0';
  found = strstr(request, field);
  assert(found != NULL);
  memcpy(key, found + sizeof(field) - 1U, 24U);
  key[24] = '\0';
}

/** RFC 6455 section 4.2.2's answer to the key the client just sent. */
static void answer_upgrade(struct fixture *fixture, const char *first_frame,
    size_t first_frame_size) {
  static const char guid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  char key[25];
  char input[24 + sizeof(guid)];
  uint8_t digest[20];
  char accept[29];
  char answer[SEGMENT_BYTES];
  int length;
  sent_key(fixture, key);
  (void)snprintf(input, sizeof(input), "%s%s", key, guid);
  sha1((const uint8_t *)input, strlen(input), digest);
  assert(iterate_kit_base64_encode(digest, sizeof(digest), accept, 28U) == 28U);
  accept[28] = '\0';
  length = snprintf(
      answer,
      sizeof(answer),
      "HTTP/1.1 101 Switching Protocols\r\n"
      "Upgrade: websocket\r\n"
      "Connection: keep-alive, Upgrade\r\n"
      "Sec-WebSocket-Accept: %s\r\n"
      "\r\n",
      accept);
  assert(length > 0 && (size_t)length + first_frame_size <= sizeof(answer));
  memcpy(answer + length, first_frame, first_frame_size);
  wire_bytes(&fixture->stream, answer, (size_t)length + first_frame_size);
}

/** Opens a generation, answering with `first_frame` in the same read. */
static void open_ready(struct fixture *fixture, const char *first_frame,
    size_t first_frame_size, int64_t now_us) {
  assert(iterate_kit_websocket_client_open(&fixture->client, now_us) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  answer_upgrade(fixture, first_frame, first_frame_size);
  assert(iterate_kit_websocket_client_open(&fixture->client, now_us) ==
      ITERATE_KIT_WEBSOCKET_OPEN_READY);
  fixture->stream.sent_size = 0U;
}

static struct iterate_kit_websocket_client_metrics metrics_of(
    const struct fixture *fixture) {
  struct iterate_kit_websocket_client_metrics metrics;
  iterate_kit_websocket_client_metrics(&fixture->client, &metrics);
  return metrics;
}

/* --- the tests ----------------------------------------------------------- */

static void sha1_matches_rfc_3174(void) {
  static const uint8_t expected[20] = {
    0xA9, 0x99, 0x3E, 0x36, 0x47, 0x06, 0x81, 0x6A, 0xBA, 0x3E,
    0x25, 0x71, 0x78, 0x50, 0xC2, 0x6C, 0x9C, 0xD0, 0xD8, 0x9D,
  };
  uint8_t digest[20];
  sha1((const uint8_t *)"abc", 3U, digest);
  assert(memcmp(digest, expected, sizeof(digest)) == 0);
}

static void endpoints_parse_as_the_request_names_them(void) {
  struct iterate_kit_websocket_endpoint endpoint;
  assert(iterate_kit_websocket_endpoint_parse("wss://os.iterate.com/api", &endpoint));
  assert(endpoint.secure && endpoint.port == 443U);
  assert(strcmp(endpoint.host, "os.iterate.com") == 0);
  assert(strcmp(endpoint.path, "/api") == 0);

  assert(iterate_kit_websocket_endpoint_parse("ws://localhost:8080", &endpoint));
  assert(!endpoint.secure && endpoint.port == 8080U);
  assert(strcmp(endpoint.host, "localhost") == 0);
  assert(strcmp(endpoint.path, "/") == 0);

  assert(iterate_kit_websocket_endpoint_parse("ws://[::1]:9/a?b=c", &endpoint));
  assert(strcmp(endpoint.host, "::1") == 0 && endpoint.port == 9U);
  assert(strcmp(endpoint.path, "/a?b=c") == 0);

  assert(iterate_kit_websocket_endpoint_parse("wss://h?q", &endpoint));
  assert(strcmp(endpoint.path, "/?q") == 0);

  assert(!iterate_kit_websocket_endpoint_parse("https://os.iterate.com/api", &endpoint));
  assert(!iterate_kit_websocket_endpoint_parse("wss://user:secret@host/api", &endpoint));
  assert(!iterate_kit_websocket_endpoint_parse("wss://host/api#fragment", &endpoint));
  assert(!iterate_kit_websocket_endpoint_parse("wss:///api", &endpoint));
  assert(!iterate_kit_websocket_endpoint_parse("wss://host:0/", &endpoint));
  assert(!iterate_kit_websocket_endpoint_parse("wss://host:65536/", &endpoint));
  assert(!iterate_kit_websocket_endpoint_parse("wss://host:/", &endpoint));
  assert(!iterate_kit_websocket_endpoint_parse("wss://host:44x/", &endpoint));
}

/*
 * RFC 6455's own example, end to end: the key the client sends for the
 * sample nonce, and the one Accept value it will take for it. A fixed,
 * stale or wrongly concatenated proof is refused.
 */
static void the_upgrade_carries_the_rfc_key_and_takes_only_its_proof(void) {
  static const char nonce[] = "the sample nonce";
  static const char expected_request[] =
      "GET /api HTTP/1.1\r\n"
      "Host: os.example:8443\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
      "Sec-WebSocket-Version: 13\r\n"
      "User-Agent: iterate-kit/0\r\n"
      "Authorization: Bearer itk_key\r\n"
      "\r\n";
  struct fixture fixture;
  prepare(&fixture, "wss://os.example:8443/api", "Authorization: Bearer itk_key\r\n");
  fixture.stream.nonce = (const uint8_t *)nonce;
  fixture.stream.nonce_size = 16U;
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  assert(fixture.stream.sent_size == sizeof(expected_request) - 1U);
  assert(memcmp(fixture.stream.sent, expected_request, fixture.stream.sent_size) == 0);

  wire_text(&fixture.stream,
      "HTTP/1.1 101 Switching Protocols\r\n"
      "upgrade: WebSocket\r\n"
      "CONNECTION: Upgrade\r\n"
      "Sec-WebSocket-Accept:  s3pPLMBiTxaQ9kYGzzhZRbK+xOo=  \r\n"
      "\r\n");
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_READY);
  assert(metrics_of(&fixture).last_upgrade_status == 101);

  iterate_kit_websocket_client_close(&fixture.client);
  fixture.stream.sent_size = 0U;
  fixture.stream.nonce = (const uint8_t *)nonce;
  fixture.stream.nonce_size = 16U;
  assert(iterate_kit_websocket_client_open(&fixture.client, 2) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  wire_text(&fixture.stream,
      "HTTP/1.1 101 Switching Protocols\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n"
      "\r\n");
  assert(iterate_kit_websocket_client_open(&fixture.client, 2) ==
      ITERATE_KIT_WEBSOCKET_OPEN_FAILED);
  assert(fixture.client.last_error == EPROTO);
}

/* A 401 is the OS refusing the key: the status survives for the backoff. */
static void a_refused_upgrade_keeps_its_status(void) {
  struct fixture fixture;
  prepare(&fixture, "wss://os.example/api", NULL);
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  wire_text(&fixture.stream, "HTTP/1.1 401 Unauthorized\r\n");
  wire_stall(&fixture.stream);
  wire_text(&fixture.stream, "Content-Length: 0\r\n\r\n");
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_FAILED);
  assert(metrics_of(&fixture).last_upgrade_status == 401);
  assert(fixture.client.last_error == ECONNREFUSED);

  iterate_kit_websocket_client_close(&fixture.client);
  assert(fixture.stream.closes == 1U);
  assert(iterate_kit_websocket_client_open(&fixture.client, 2) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  assert(metrics_of(&fixture).last_upgrade_status == 0);
  wire_text(&fixture.stream, "SSH-2.0-OpenSSH\r\n\r\n");
  assert(iterate_kit_websocket_client_open(&fixture.client, 2) ==
      ITERATE_KIT_WEBSOCKET_OPEN_FAILED);
  assert(metrics_of(&fixture).last_upgrade_status == -1);
  assert(fixture.client.last_error == EPROTO);
}

/* The stream's own failure is the stream's to explain. */
static void a_failed_stream_leaves_the_cause_to_the_platform(void) {
  struct fixture fixture;
  prepare(&fixture, "wss://os.example/api", NULL);
  fixture.stream.connects_to_defer = 2U;
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  fixture.stream.connect_fails = true;
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_FAILED);
  assert(fixture.client.last_error == 0);
  assert(metrics_of(&fixture).last_upgrade_status == 0);
  assert(fixture.stream.sent_size == 0U);
}

/* A socket that takes a few bytes at a time still gets one whole request. */
static void a_short_or_stalled_write_resumes_the_request(void) {
  struct fixture fixture;
  prepare(&fixture, "ws://localhost/api", NULL);
  fixture.stream.write_limit = 7U;
  fixture.stream.writes_to_defer = 1U;
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  assert(fixture.stream.sent_size == 0U);
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  assert(fixture.stream.sent_size == fixture.client.request_size);
  assert(memcmp(fixture.stream.sent,
             "GET /api HTTP/1.1\r\nHost: localhost\r\n", 36U) == 0);
}

/*
 * THE FIRST FRAME RIDES IN THE SAME READ AS THE ANSWER. The answer is read a
 * byte at a time, so the frame stays in the stream for the frame reader.
 */
static void the_first_frame_behind_the_answer_is_not_lost(void) {
  static const uint8_t frame[] = {0x81U, 0x02U, 'o', 'k'};
  struct fixture fixture;
  struct iterate_kit_websocket_chunk chunk;
  prepare(&fixture, "wss://os.example/api", NULL);
  open_ready(&fixture, (const char *)frame, sizeof(frame), 1);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_DATA);
  assert(chunk.opcode == ITERATE_KIT_WEBSOCKET_TEXT && chunk.final);
  assert(chunk.byte_count == 2U && memcmp(chunk.bytes, "ok", 2U) == 0);
  assert(metrics_of(&fixture).frames_received == 1U);
}

/*
 * A HEADER CUT AFTER ANY BYTE. A zero-timeout read may split even the
 * two-byte base header; the client keeps the prefix, so a continuation byte is
 * never read as a fresh opcode.
 */
static void a_header_split_byte_by_byte_keeps_its_frame(void) {
  static const uint8_t frame[] = {0x82U, 0x7EU, 0x00U, 0x80U};
  uint8_t payload[128];
  struct fixture fixture;
  struct iterate_kit_websocket_chunk chunk;
  size_t index;
  prepare(&fixture, "wss://os.example/api", NULL);
  open_ready(&fixture, NULL, 0U, 1);
  for (index = 0U; index < sizeof(payload); ++index) {
    payload[index] = (uint8_t)index;
  }
  for (index = 0U; index < sizeof(frame); ++index) {
    wire_bytes(&fixture.stream, frame + index, 1U);
    wire_stall(&fixture.stream);
  }
  wire_bytes(&fixture.stream, payload, sizeof(payload));
  for (index = 0U; index < 2U * sizeof(frame); ++index) {
    assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
        ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE);
  }
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_DATA);
  assert(chunk.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  assert(chunk.payload_size == sizeof(payload) && chunk.payload_offset == 0U);
  assert(chunk.byte_count == sizeof(payload));
  assert(memcmp(chunk.bytes, payload, sizeof(payload)) == 0);
}

/*
 * A PAYLOAD STALLED MID-FRAME. Zero bytes is a wait, not the end of the
 * frame: the rest continues the same frame at its offset.
 */
static void a_payload_stall_resumes_at_its_offset(void) {
  static const uint8_t head[] = {0x81U, 0x05U, 'h', 'e', 'l'};
  struct fixture fixture;
  struct iterate_kit_websocket_chunk chunk;
  prepare(&fixture, "wss://os.example/api", NULL);
  open_ready(&fixture, NULL, 0U, 1);
  wire_bytes(&fixture.stream, head, sizeof(head));
  wire_stall(&fixture.stream);
  wire_stall(&fixture.stream);
  wire_text(&fixture.stream, "lo");
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_DATA);
  assert(chunk.payload_offset == 0U && chunk.byte_count == 3U);
  assert(memcmp(chunk.bytes, "hel", 3U) == 0);
  assert(metrics_of(&fixture).frames_received == 0U);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 3, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 3, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 4, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_DATA);
  assert(chunk.payload_offset == 3U && chunk.byte_count == 2U);
  assert(chunk.payload_size == 5U && memcmp(chunk.bytes, "lo", 2U) == 0);
  assert(metrics_of(&fixture).frames_received == 1U);
}

/* A PING is answered with its own payload, masked, by service_control. */
static void a_ping_is_answered_on_the_next_service(void) {
  static const uint8_t ping[] = {0x89U, 0x02U, 'h', 'i'};
  struct fixture fixture;
  struct iterate_kit_websocket_chunk chunk;
  uint8_t unmasked[2];
  prepare(&fixture, "wss://os.example/api", NULL);
  open_ready(&fixture, (const char *)ping, sizeof(ping), 1);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_CONTROL);
  assert(fixture.stream.sent_size == 0U);
  assert(iterate_kit_websocket_client_service_control(&fixture.client, 2) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  assert(fixture.stream.sent_size == 8U);
  assert(fixture.stream.sent[0] == 0x8AU && fixture.stream.sent[1] == 0x82U);
  unmasked[0] = fixture.stream.sent[6] ^ fixture.stream.sent[2];
  unmasked[1] = fixture.stream.sent[7] ^ fixture.stream.sent[3];
  assert(memcmp(unmasked, "hi", 2U) == 0);
  assert(metrics_of(&fixture).pongs_received == 0U);
}

/*
 * THE PEER'S CLOSE ENDS DATA AT ONCE: its code is kept, sending stops, and
 * only the echo still goes out.
 */
static void a_peer_close_is_echoed_and_stops_data(void) {
  static const uint8_t close_frame[] = {0x88U, 0x02U, 0x03U, 0xE8U};
  struct fixture fixture;
  struct iterate_kit_websocket_chunk chunk;
  prepare(&fixture, "wss://os.example/api", NULL);
  open_ready(&fixture, NULL, 0U, 1);
  wire_bytes(&fixture.stream, close_frame, sizeof(close_frame));
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_PEER_CLOSE);
  assert(metrics_of(&fixture).last_peer_close_status_code == 1000);
  assert(iterate_kit_websocket_client_send(
             &fixture.client, ITERATE_KIT_WEBSOCKET_TEXT, "x", 1U) ==
      ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED);
  assert(iterate_kit_websocket_client_service_control(&fixture.client, 2) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  assert(fixture.stream.sent[0] == 0x88U && fixture.stream.sent[1] == 0x82U);
  iterate_kit_websocket_client_close(&fixture.client);
  assert(fixture.stream.sent_size == 8U);
}

/*
 * THE KEEPALIVE ASKS ONLY AFTER INBOUND SILENCE. Continuous microphone writes
 * do not defer it (local TCP accepting bytes proves nothing about the peer),
 * it asks once per period, and a frame from the peer resets the wait.
 */
static void inbound_silence_pings_once_and_fresh_inbound_defers_it(void) {
  static const int64_t period = (int64_t)ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS * 1000;
  static const uint8_t pong[] = {0x8AU, 0x00U};
  struct fixture fixture;
  struct iterate_kit_websocket_chunk chunk;
  prepare(&fixture, "wss://os.example/api", NULL);
  open_ready(&fixture, NULL, 0U, 1);

  assert(iterate_kit_websocket_client_send(
             &fixture.client, ITERATE_KIT_WEBSOCKET_TEXT, "mic", 3U) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  assert(iterate_kit_websocket_client_service_control(&fixture.client, period + 1) ==
      ITERATE_KIT_WEBSOCKET_TX_IDLE);
  fixture.stream.sent_size = 0U;
  assert(iterate_kit_websocket_client_service_control(&fixture.client, period + 2) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  assert(fixture.stream.sent_size == 6U && fixture.stream.sent[0] == 0x89U);
  assert(iterate_kit_websocket_client_service_control(&fixture.client, period + 3) ==
      ITERATE_KIT_WEBSOCKET_TX_IDLE);

  wire_bytes(&fixture.stream, pong, sizeof(pong));
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2 * period - 1, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_CONTROL);
  assert(metrics_of(&fixture).pongs_received == 1U);
  fixture.stream.sent_size = 0U;
  assert(iterate_kit_websocket_client_service_control(&fixture.client, 2 * period) ==
      ITERATE_KIT_WEBSOCKET_TX_IDLE);
  assert(iterate_kit_websocket_client_service_control(&fixture.client, 3 * period + 1) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  assert(fixture.stream.sent[0] == 0x89U);
}

/* Server frames are never masked; one that is has broken RFC 6455. */
static void a_masked_server_frame_is_a_protocol_failure(void) {
  static const uint8_t masked[] = {0x81U, 0x81U, 1U, 2U, 3U, 4U, 'x'};
  struct fixture fixture;
  struct iterate_kit_websocket_chunk chunk;
  prepare(&fixture, "wss://os.example/api", NULL);
  open_ready(&fixture, (const char *)masked, sizeof(masked), 1);
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE);
  assert(fixture.client.last_error == EPROTO);
  assert(iterate_kit_websocket_client_send(
             &fixture.client, ITERATE_KIT_WEBSOCKET_TEXT, "x", 1U) ==
      ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED);
}

/*
 * A read the stream fails is a disconnect, not a bad frame, and the next
 * generation starts clean: its close sends no CLOSE into a dead stream.
 */
static void a_failed_read_disconnects_and_the_next_generation_opens(void) {
  struct fixture fixture;
  struct iterate_kit_websocket_chunk chunk;
  prepare(&fixture, "wss://os.example/api", NULL);
  open_ready(&fixture, NULL, 0U, 1);
  fixture.stream.reads_fail = true;
  assert(iterate_kit_websocket_client_receive(&fixture.client, 2, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RECEIVE_DISCONNECTED);
  assert(fixture.client.last_error == 0);
  iterate_kit_websocket_client_close(&fixture.client);
  assert(fixture.stream.sent_size == 0U);
  assert(fixture.stream.closes == 1U);

  fixture.stream.reads_fail = false;
  open_ready(&fixture, NULL, 0U, 3);
  assert(fixture.stream.connects == 2U);
  iterate_kit_websocket_client_close(&fixture.client);
  /* A healthy generation's close still says goodbye, in one attempt. */
  assert(fixture.stream.sent_size == 6U && fixture.stream.sent[0] == 0x88U);
}

/* An answer larger than its workspace is refused, never truncated. */
static void an_answer_larger_than_its_workspace_is_refused(void) {
  struct fixture fixture;
  char line[SEGMENT_BYTES];
  size_t sent = 0U;
  prepare(&fixture, "wss://os.example/api", NULL);
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_WOULD_BLOCK);
  wire_text(&fixture.stream, "HTTP/1.1 101 Switching Protocols\r\n");
  memset(line, 'x', sizeof(line) - 1U);
  line[sizeof(line) - 1U] = '\0';
  while (sent <= sizeof(fixture.receive_storage)) {
    wire_text(&fixture.stream, line);
    sent += strlen(line);
  }
  assert(iterate_kit_websocket_client_open(&fixture.client, 1) ==
      ITERATE_KIT_WEBSOCKET_OPEN_FAILED);
  assert(fixture.client.last_error == EMSGSIZE);
}

int main(void) {
  sha1_matches_rfc_3174();
  endpoints_parse_as_the_request_names_them();
  the_upgrade_carries_the_rfc_key_and_takes_only_its_proof();
  a_refused_upgrade_keeps_its_status();
  a_failed_stream_leaves_the_cause_to_the_platform();
  a_short_or_stalled_write_resumes_the_request();
  the_first_frame_behind_the_answer_is_not_lost();
  a_header_split_byte_by_byte_keeps_its_frame();
  a_payload_stall_resumes_at_its_offset();
  a_ping_is_answered_on_the_next_service();
  a_peer_close_is_echoed_and_stops_data();
  inbound_silence_pings_once_and_fresh_inbound_defers_it();
  a_masked_server_frame_is_a_protocol_failure();
  a_failed_read_disconnects_and_the_next_generation_opens();
  an_answer_larger_than_its_workspace_is_refused();
  return 0;
}
