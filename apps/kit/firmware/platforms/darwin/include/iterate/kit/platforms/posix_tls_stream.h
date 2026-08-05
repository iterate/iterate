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
  ITERATE_KIT_POSIX_TLS_ADDRESS_CAPACITY = 8,
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

typedef void (*iterate_kit_posix_tls_resolved_address_fn)(
    void *context,
    int error,
    bool add,
    const struct sockaddr *address);

/**
 * Injectable nonblocking hostname resolver used by the macOS adapter tests.
 *
 * start() and poll() return zero for progress, EAGAIN while idle, or a stable
 * platform error. poll() performs at most one bounded resolver step. The
 * stream owns the returned handle until cancel(), including on every timeout,
 * close, and failed connection generation.
 */
struct iterate_kit_posix_tls_resolver_ops {
  int (*start)(
      void *operations_context,
      const char *host,
      iterate_kit_posix_tls_resolved_address_fn resolved,
      void *resolved_context,
      void **handle);
  int (*poll)(void *operations_context, void *handle);
  void (*cancel)(void *operations_context, void *handle);
};

struct iterate_kit_posix_tls_default_resolver {
  void *native_ref;
  iterate_kit_posix_tls_resolved_address_fn resolved;
  void *resolved_context;
};

struct iterate_kit_posix_tls_stream_options {
  const char *host;
  uint16_t port;
  /** Wraps the TCP connection in verified TLS when true. */
  bool use_tls;
  /**
   * DANGEROUS: disables both CA and hostname verification for local-only
   * servers. Production callers must leave this false; the loud field name is
   * intended to make an insecure configuration conspicuous at every callsite.
   */
  bool DANGEROUS_disable_certificate_verification;
  /** Optional deterministic resolver seam; NULL selects DNS-SD on macOS. */
  const struct iterate_kit_posix_tls_resolver_ops *resolver_ops;
  void *resolver_context;
};

struct iterate_kit_posix_tls_address {
  struct sockaddr_storage storage;
  socklen_t length;
  int family;
  int socktype;
  int protocol;
};

/**
 * One-owner nonblocking TCP byte stream with optional TLS 1.2+.
 *
 * OpenSSL owns opaque per-connection allocations, but this adapter owns no
 * growing application buffer or reconnect queue. connect(), read(), and
 * write() perform one bounded state transition and distinguish scheduler
 * deferral from loss. DNS, socket connect, and optional TLS all advance only
 * through connect(), so the caller's one open-attempt deadline bounds every
 * establishment stage. Plain TCP exists solely to reach local ws://
 * development servers; deployed wss:// endpoints always select TLS in the
 * WebSocket adapter.
 */
struct iterate_kit_posix_tls_stream {
  char host[ITERATE_KIT_POSIX_TLS_HOST_CAPACITY];
  void *resolver;
  const struct iterate_kit_posix_tls_resolver_ops *resolver_ops;
  void *resolver_context;
  struct iterate_kit_posix_tls_default_resolver default_resolver;
  SSL_CTX *context;
  SSL *ssl;
  struct iterate_kit_posix_tls_address
      addresses[ITERATE_KIT_POSIX_TLS_ADDRESS_CAPACITY];
  size_t address_count;
  size_t address_index;
  uint16_t port;
  int descriptor;
  int last_errno;
  unsigned long last_openssl_error;
  bool tcp_connecting;
  bool tls_handshaking;
  bool ready;
  bool resolver_snapshot_complete;
  bool resolver_failed;
  bool use_tls;
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
