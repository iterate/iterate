/*
 * THE BOARD'S BYTE STREAM: ESP-TLS UNDER THE ONE WEBSOCKET CLIENT.
 *
 * The network task reads with no timeout every pass, so "nothing yet" is its
 * most common answer and must never look like a failure: mbedTLS's WANT_READ
 * and WANT_WRITE, its TIMEOUT, a plain socket's EAGAIN and a record buffer that
 * took nothing are all an empty pass. A real failure keeps its cause from
 * ESP-TLS's error handle, which the connection's destruction takes with it.
 * Scripted against tests/fakes/esp_tls; a board proves the rest on the bench.
 */
#include "esp_crt_bundle.h"
#include "fake_esp_tls.h"
#include "iterate/kit/platforms/esp_tls_stream.h"

#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <string.h>
#include <sys/socket.h>

static const struct iterate_kit_byte_stream_ops *const ops =
    &iterate_kit_esp_tls_stream_ops;

struct fixture {
  struct iterate_kit_websocket_endpoint endpoint;
  struct iterate_kit_esp_tls_stream stream;
};

static void prepare(struct fixture *fixture, const char *url) {
  memset(fixture, 0, sizeof(*fixture));
  fake_esp_tls_reset();
  assert(iterate_kit_websocket_endpoint_parse(url, &fixture->endpoint));
  iterate_kit_esp_tls_stream_prepare(&fixture->stream, &fixture->endpoint, 10000);
}

static void script_read(ssize_t result, int socket_errno, esp_err_t recorded, const char *bytes) {
  fake_esp_tls.reads[fake_esp_tls.read_count++] =
      (struct fake_esp_tls_step){result, socket_errno, recorded, bytes};
}

static void script_write(ssize_t result, int socket_errno, esp_err_t recorded) {
  fake_esp_tls.writes[fake_esp_tls.write_count++] =
      (struct fake_esp_tls_step){result, socket_errno, recorded, NULL};
}

/*
 * A wss:// connect verifies against the bundle within the one bound, keeps
 * TCP keepalive slower than the WebSocket's, and leaves a socket that never
 * blocks and never waits on Nagle.
 */
static void a_connect_dials_the_endpoint_and_frees_the_socket_from_waiting(void) {
  struct fixture fixture;
  int flags;
  int nodelay = 0;
  socklen_t length = sizeof(nodelay);
  prepare(&fixture, "wss://os.example:8443/api");
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_PROGRESS);
  assert(strcmp(fake_esp_tls.host, "os.example") == 0 && fake_esp_tls.port == 8443);
  assert(fake_esp_tls.configuration.timeout_ms == 10000);
  assert(fake_esp_tls.configuration.crt_bundle_attach == esp_crt_bundle_attach);
  assert(!fake_esp_tls.configuration.is_plain_tcp);
  assert(fake_esp_tls.keep_alive_set && fake_esp_tls.keep_alive.keep_alive_enable);
  assert(fake_esp_tls.keep_alive.keep_alive_idle == 10);
  assert(fake_esp_tls.keep_alive.keep_alive_interval == 5);
  assert(fake_esp_tls.keep_alive.keep_alive_count == 3);
  flags = fcntl(fake_esp_tls.descriptor, F_GETFL, 0);
  assert(flags >= 0 && (flags & O_NONBLOCK) != 0);
  assert(getsockopt(fake_esp_tls.descriptor, IPPROTO_TCP, TCP_NODELAY, &nodelay, &length) == 0);
  assert(nodelay != 0);
  ops->close(&fixture.stream);
  ops->close(&fixture.stream);
  assert(fake_esp_tls.destroyed == 1U && fake_esp_tls.live == 0U);

  /* ws:// is plain TCP, for a development server, with no bundle. */
  prepare(&fixture, "ws://localhost:8080/api");
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_PROGRESS);
  assert(fake_esp_tls.configuration.is_plain_tcp);
  assert(fake_esp_tls.configuration.crt_bundle_attach == NULL);
  ops->close(&fixture.stream);
}

/* A refused connect keeps ESP-TLS's reason and leaves nothing to reuse. */
static void a_failed_connect_keeps_its_cause_and_frees_the_connection(void) {
  struct fixture fixture;
  prepare(&fixture, "wss://nowhere.example/api");
  fake_esp_tls.connect_result = -1;
  fake_esp_tls.connect_error = ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME;
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(fixture.stream.last_error == ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME);
  assert(fixture.stream.tls == NULL && fake_esp_tls.live == 0U);

  /* Without an ESP-TLS error, the socket's errno is the cause. */
  fake_esp_tls.connect_error = ESP_OK;
  fake_esp_tls.connect_socket_errno = ECONNREFUSED;
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(fixture.stream.last_error == ECONNREFUSED);

  /* The next generation dials afresh. */
  fake_esp_tls.connect_result = 1;
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_PROGRESS);
  assert(fake_esp_tls.connections == 3U && fake_esp_tls.live == 1U);
  ops->close(&fixture.stream);
  assert(fake_esp_tls.live == 0U);
}

/*
 * ZERO-TIMEOUT READS. The pass that finds nothing is the ordinary one, so no
 * flavour of it may count as a failure, however often it repeats: mbedTLS's
 * WANT_READ, WANT_WRITE and TIMEOUT over TLS, EAGAIN over plain TCP.
 */
static void a_read_that_finds_nothing_is_an_empty_pass(void) {
  struct fixture fixture;
  uint8_t bytes[8];
  size_t count = 99U;
  unsigned int pass;
  prepare(&fixture, "wss://os.example/api");
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_PROGRESS);
  script_read(ESP_TLS_ERR_SSL_WANT_READ, 0, ESP_OK, NULL);
  script_read(ESP_TLS_ERR_SSL_WANT_WRITE, 0, ESP_OK, NULL);
  script_read(ESP_TLS_ERR_SSL_TIMEOUT, EAGAIN, ESP_OK, NULL);
  script_read(3, 0, ESP_OK, "abc");
  for (pass = 0U; pass < 3U; ++pass) {
    assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
        ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
    assert(count == 0U);
  }
  assert(fixture.stream.last_error == 0);
  assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
      ITERATE_KIT_BYTE_STREAM_PROGRESS);
  assert(count == 3U && memcmp(bytes, "abc", 3U) == 0);
  assert(fake_esp_tls.read_capacity == sizeof(bytes));
  ops->close(&fixture.stream);

  prepare(&fixture, "ws://localhost:8080/api");
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_PROGRESS);
  script_read(-1, EAGAIN, ESP_OK, NULL);
  script_read(-1, EWOULDBLOCK, ESP_OK, NULL);
  assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
      ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
      ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  assert(fixture.stream.last_error == 0);
  ops->close(&fixture.stream);
}

/*
 * THE END OF THE STREAM IS A FAILURE WITH A CAUSE: a peer's FIN or TLS
 * close_notify reads as zero, and an mbedTLS error keeps ESP-TLS's code.
 */
static void a_closed_or_broken_read_fails_with_its_cause(void) {
  struct fixture fixture;
  uint8_t bytes[8];
  size_t count;
  prepare(&fixture, "wss://os.example/api");
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_PROGRESS);
  script_read(0, 0, ESP_OK, NULL);
  assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
      ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(fixture.stream.last_error == ECONNRESET);

  script_read(-0x7280, 0, ESP_ERR_MBEDTLS_SSL_READ_FAILED, NULL);
  assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
      ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(fixture.stream.last_error == ESP_ERR_MBEDTLS_SSL_READ_FAILED);

  script_read(-1, ENOTCONN, ESP_OK, NULL);
  assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
      ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(fixture.stream.last_error == ENOTCONN);

  /* Over TLS a stale EAGAIN beside a real error is still the error. */
  script_read(-0x7280, EAGAIN, ESP_ERR_MBEDTLS_SSL_READ_FAILED, NULL);
  assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
      ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(fixture.stream.last_error == ESP_ERR_MBEDTLS_SSL_READ_FAILED);
  ops->close(&fixture.stream);
  assert(ops->read(&fixture.stream, bytes, sizeof(bytes), &count) ==
      ITERATE_KIT_BYTE_STREAM_FAILED);
}

/* A full socket defers a write; a partial one reports exactly what went. */
static void a_write_takes_what_the_socket_takes(void) {
  static const uint8_t frame[64] = {0};
  struct fixture fixture;
  size_t count = 99U;
  prepare(&fixture, "wss://os.example/api");
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_PROGRESS);
  script_write(ESP_TLS_ERR_SSL_WANT_WRITE, 0, ESP_OK);
  script_write(ESP_TLS_ERR_SSL_WANT_READ, 0, ESP_OK);
  script_write(0, 0, ESP_OK);
  script_write(20, 0, ESP_OK);
  script_write(-0x7780, 0, ESP_ERR_MBEDTLS_SSL_WRITE_FAILED);
  assert(ops->write(&fixture.stream, frame, sizeof(frame), &count) ==
      ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  assert(count == 0U);
  assert(ops->write(&fixture.stream, frame, sizeof(frame), &count) ==
      ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  assert(ops->write(&fixture.stream, frame, sizeof(frame), &count) ==
      ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  assert(fixture.stream.last_error == 0);
  assert(ops->write(&fixture.stream, frame, sizeof(frame), &count) ==
      ITERATE_KIT_BYTE_STREAM_PROGRESS);
  assert(count == 20U && fake_esp_tls.write_size == sizeof(frame));
  assert(ops->write(&fixture.stream, frame, sizeof(frame), &count) ==
      ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(count == 0U);
  assert(fixture.stream.last_error == ESP_ERR_MBEDTLS_SSL_WRITE_FAILED);
  ops->close(&fixture.stream);

  /* A plain socket's full send buffer is EAGAIN; a reset is a failure. */
  prepare(&fixture, "ws://localhost:8080/api");
  assert(ops->connect(&fixture.stream) == ITERATE_KIT_BYTE_STREAM_PROGRESS);
  script_write(-1, EAGAIN, ESP_OK);
  script_write(-1, ECONNRESET, ESP_OK);
  assert(ops->write(&fixture.stream, frame, sizeof(frame), &count) ==
      ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  assert(ops->write(&fixture.stream, frame, sizeof(frame), &count) ==
      ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(fixture.stream.last_error == ECONNRESET);
  ops->close(&fixture.stream);
}

static void randomness_and_sha1_are_the_platform_s(void) {
  struct fixture fixture;
  uint8_t digest[20] = {0};
  uint8_t bytes[16] = {0};
  prepare(&fixture, "wss://os.example/api");
  assert(ops->sha1(&fixture.stream, (const uint8_t *)"x", 1U, digest) ==
      ITERATE_KIT_OK);
  assert(digest[0] == 0xA5U && digest[19] == 0xA5U);
  fake_esp_tls.sha1_result = -1;
  assert(ops->sha1(&fixture.stream, (const uint8_t *)"x", 1U, digest) ==
      ITERATE_KIT_IO_ERROR);
  assert(ops->random(&fixture.stream, bytes, sizeof(bytes)) == ITERATE_KIT_OK);
}

int main(void) {
  a_connect_dials_the_endpoint_and_frees_the_socket_from_waiting();
  a_failed_connect_keeps_its_cause_and_frees_the_connection();
  a_read_that_finds_nothing_is_an_empty_pass();
  a_closed_or_broken_read_fails_with_its_cause();
  a_write_takes_what_the_socket_takes();
  randomness_and_sha1_are_the_platform_s();
  return 0;
}
