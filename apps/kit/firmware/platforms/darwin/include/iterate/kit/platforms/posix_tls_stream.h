#ifndef ITERATE_KIT_PLATFORMS_POSIX_TLS_STREAM_H
#define ITERATE_KIT_PLATFORMS_POSIX_TLS_STREAM_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>

#include <openssl/ssl.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ITERATE_KIT_POSIX_TLS_HOST_CAPACITY = 129,
};

enum iterate_kit_posix_tls_connect_result {
  ITERATE_KIT_POSIX_TLS_CONNECT_READY = 0,
  ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK,
  ITERATE_KIT_POSIX_TLS_CONNECT_FAILED,
};

enum iterate_kit_posix_tls_io_result {
  ITERATE_KIT_POSIX_TLS_IO_PROGRESS = 0,
  ITERATE_KIT_POSIX_TLS_IO_WOULD_BLOCK,
  ITERATE_KIT_POSIX_TLS_IO_FAILED,
};

struct iterate_kit_posix_tls_stream_options {
  const char *host;
  uint16_t port;
  /**
   * DANGEROUS: disables both CA and hostname verification for local-only
   * servers. Production callers must leave this false; the loud field name is
   * intended to make an insecure configuration conspicuous at every callsite.
   */
  bool DANGEROUS_disable_certificate_verification;
};

/**
 * One-owner nonblocking TLS 1.2+ byte stream.
 *
 * OpenSSL owns opaque per-connection allocations, but this adapter owns no
 * growing application buffer or reconnect queue. connect(), read(), and
 * write() perform one bounded state transition and distinguish scheduler
 * deferral from loss. prepare() resolves the fixed endpoint once; connect()
 * therefore contains only explicitly poll-driven socket and TLS progress.
 */
struct iterate_kit_posix_tls_stream {
  char host[ITERATE_KIT_POSIX_TLS_HOST_CAPACITY];
  SSL_CTX *context;
  SSL *ssl;
  struct sockaddr_storage address;
  socklen_t address_length;
  int address_family;
  int address_socktype;
  int address_protocol;
  uint16_t port;
  int descriptor;
  int last_errno;
  unsigned long last_openssl_error;
  bool tcp_connecting;
  bool tls_handshaking;
  bool ready;
  bool dangerous_disable_certificate_verification;
  bool initialized;
};

enum iterate_kit_status iterate_kit_posix_tls_stream_prepare(
    struct iterate_kit_posix_tls_stream *stream,
    const struct iterate_kit_posix_tls_stream_options *options);

enum iterate_kit_posix_tls_connect_result
iterate_kit_posix_tls_stream_connect(
    struct iterate_kit_posix_tls_stream *stream);

enum iterate_kit_posix_tls_io_result iterate_kit_posix_tls_stream_read(
    struct iterate_kit_posix_tls_stream *stream,
    uint8_t *bytes,
    size_t byte_capacity,
    size_t *bytes_read);

enum iterate_kit_posix_tls_io_result iterate_kit_posix_tls_stream_write(
    struct iterate_kit_posix_tls_stream *stream,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written);

/** Closes one connection generation while retaining the reusable SSL_CTX. */
void iterate_kit_posix_tls_stream_close(
    struct iterate_kit_posix_tls_stream *stream);

/** Releases the long-lived OpenSSL context after the final close. */
void iterate_kit_posix_tls_stream_cleanup(
    struct iterate_kit_posix_tls_stream *stream);

#ifdef __cplusplus
}
#endif

#endif
