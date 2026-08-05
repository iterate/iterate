#include "iterate/kit/platforms/posix_tls_stream.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <dns_sd.h>
#include <openssl/err.h>

/*
 * The socket and OpenSSL state form one generation and have one polling owner.
 * A WANT_READ/WANT_WRITE result is normal deferral regardless of the API that
 * produced it: TLS may need the opposite wire direction for a handshake or
 * record transition. Terminal paths retain both errno domains before freeing
 * opaque state so reconnect cannot erase the incident's cause.
 */

static void remember_failure(
    struct iterate_kit_posix_tls_stream *stream) {
  stream->last_errno = errno != 0 ? errno : EIO;
  stream->last_openssl_error = stream->use_tls ? ERR_peek_last_error() : 0UL;
}

static void cancel_resolver(struct iterate_kit_posix_tls_stream *stream) {
  if (stream->resolver != NULL) {
    stream->resolver_ops->cancel(
        stream->resolver_context, stream->resolver);
    stream->resolver = NULL;
  }
}

static void resolved_address(
    void *context,
    int error,
    bool add,
    const struct sockaddr *address) {
  struct iterate_kit_posix_tls_stream *stream = context;
  struct sockaddr_storage candidate;
  socklen_t length;
  size_t index;
  if (stream == NULL) {
    return;
  }
  if (error != 0) {
    stream->last_errno = error;
    stream->resolver_failed = true;
    return;
  }
  if (address == NULL || !add) {
    return;
  }
  if (address->sa_family == AF_INET) {
    length = (socklen_t)sizeof(struct sockaddr_in);
  } else if (address->sa_family == AF_INET6) {
    length = (socklen_t)sizeof(struct sockaddr_in6);
  } else {
    return;
  }
  memset(&candidate, 0, sizeof(candidate));
  memcpy(&candidate, address, length);
  if (address->sa_family == AF_INET) {
    ((struct sockaddr_in *)&candidate)->sin_port = htons(stream->port);
  } else {
    ((struct sockaddr_in6 *)&candidate)->sin6_port = htons(stream->port);
  }
  for (index = 0U; index < stream->address_count; ++index) {
    if (stream->addresses[index].length == length &&
        memcmp(&stream->addresses[index].storage, &candidate, length) == 0) {
      return;
    }
  }
  if (stream->address_count == ITERATE_KIT_POSIX_TLS_ADDRESS_CAPACITY) {
    /* The fixed snapshot is full. Existing candidates remain usable. */
    stream->resolver_snapshot_complete = true;
    return;
  }
  struct iterate_kit_posix_tls_address *destination =
      &stream->addresses[stream->address_count++];
  memcpy(&destination->storage, &candidate, length);
  destination->length = length;
  destination->family = address->sa_family;
  destination->socktype = SOCK_STREAM;
  destination->protocol = IPPROTO_TCP;
}

static void DNSSD_API dns_sd_resolved_address(
    DNSServiceRef resolver,
    DNSServiceFlags flags,
    uint32_t interface_index,
    DNSServiceErrorType error,
    const char *hostname,
    const struct sockaddr *address,
    uint32_t ttl,
    void *context) {
  struct iterate_kit_posix_tls_default_resolver *state = context;
  (void)resolver;
  (void)interface_index;
  (void)hostname;
  (void)ttl;
  (void)flags;
  if (state == NULL || state->resolved == NULL) {
    return;
  }
  state->resolved(
      state->resolved_context,
      (int)error,
      (flags & kDNSServiceFlagsAdd) != 0U,
      address);
}

static int dns_sd_start(
    void *operations_context,
    const char *host,
    iterate_kit_posix_tls_resolved_address_fn callback,
    void *callback_context,
    void **handle) {
  struct iterate_kit_posix_tls_default_resolver *state = operations_context;
  DNSServiceRef resolver = NULL;
  const DNSServiceErrorType result = DNSServiceGetAddrInfo(
      &resolver,
      0,
      kDNSServiceInterfaceIndexAny,
      kDNSServiceProtocol_IPv4 | kDNSServiceProtocol_IPv6,
      host,
      dns_sd_resolved_address,
      state);
  if (result != kDNSServiceErr_NoError) {
    return (int)result;
  }
  state->native_ref = resolver;
  state->resolved = callback;
  state->resolved_context = callback_context;
  *handle = state;
  return 0;
}

static int dns_sd_poll(void *operations_context, void *handle) {
  struct iterate_kit_posix_tls_default_resolver *state = handle;
  struct pollfd candidate;
  int poll_result;
  DNSServiceErrorType result;
  (void)operations_context;
  candidate = (struct pollfd){
    .fd = DNSServiceRefSockFD((DNSServiceRef)state->native_ref),
    .events = POLLIN,
  };
  if (candidate.fd < 0) {
    return EIO;
  }
  poll_result = poll(&candidate, 1U, 0);
  if (poll_result == 0) {
    return EAGAIN;
  }
  if (poll_result < 0) {
    return errno != 0 ? errno : EIO;
  }
  if ((candidate.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
    return EIO;
  }
  result = DNSServiceProcessResult((DNSServiceRef)state->native_ref);
  return result == kDNSServiceErr_NoError ? 0 : (int)result;
}

static void dns_sd_cancel(void *operations_context, void *handle) {
  struct iterate_kit_posix_tls_default_resolver *state = handle;
  (void)operations_context;
  if (state->native_ref != NULL) {
    DNSServiceRefDeallocate((DNSServiceRef)state->native_ref);
  }
  memset(state, 0, sizeof(*state));
}

static const struct iterate_kit_posix_tls_resolver_ops dns_sd_resolver_ops = {
  .start = dns_sd_start,
  .poll = dns_sd_poll,
  .cancel = dns_sd_cancel,
};

static enum iterate_kit_posix_tls_connect_result drive_resolver(
    struct iterate_kit_posix_tls_stream *stream) {
  int result;
  if (stream->resolver == NULL) {
    stream->address_count = 0U;
    stream->address_index = 0U;
    stream->resolver_failed = false;
    result = stream->resolver_ops->start(
        stream->resolver_context,
        stream->host,
        resolved_address,
        stream,
        &stream->resolver);
    if (result != 0) {
      stream->last_errno = result;
      cancel_resolver(stream);
      return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
    }
  }
  result = stream->resolver_ops->poll(
      stream->resolver_context, stream->resolver);
  if (result != 0 && result != EAGAIN) {
    stream->last_errno = result;
    stream->resolver_failed = true;
  }
  if (stream->resolver_failed) {
    stream->resolver_snapshot_complete = true;
    cancel_resolver(stream);
  } else if (stream->resolver_snapshot_complete) {
    cancel_resolver(stream);
  }
  if (stream->address_index < stream->address_count) {
    return ITERATE_KIT_POSIX_TLS_CONNECT_READY;
  }
  return stream->resolver_snapshot_complete
      ? ITERATE_KIT_POSIX_TLS_CONNECT_FAILED
      : ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK;
}

void iterate_kit_posix_tls_stream_close(
    struct iterate_kit_posix_tls_stream *stream) {
  if (stream == NULL || !stream->initialized) {
    return;
  }
  cancel_resolver(stream);
  if (stream->ssl != NULL) {
    SSL_free(stream->ssl);
    stream->ssl = NULL;
  }
  if (stream->descriptor >= 0) {
    (void)close(stream->descriptor);
    stream->descriptor = -1;
  }
  stream->tcp_connecting = false;
  stream->tls_handshaking = false;
  stream->ready = false;
  stream->address_count = 0U;
  stream->address_index = 0U;
  stream->resolver_snapshot_complete = false;
  stream->resolver_failed = false;
}

void iterate_kit_posix_tls_stream_cleanup(
    struct iterate_kit_posix_tls_stream *stream) {
  if (stream == NULL || !stream->initialized) {
    return;
  }
  iterate_kit_posix_tls_stream_close(stream);
  SSL_CTX_free(stream->context);
  memset(stream, 0, sizeof(*stream));
}

enum iterate_kit_status iterate_kit_posix_tls_stream_prepare(
    struct iterate_kit_posix_tls_stream *stream,
    const struct iterate_kit_posix_tls_stream_options *options) {
  size_t host_length;
  if (stream == NULL || options == NULL || options->host == NULL ||
      options->port == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  host_length = strlen(options->host);
  if (host_length == 0U || host_length >= sizeof(stream->host)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(stream, 0, sizeof(*stream));
  stream->descriptor = -1;
  memcpy(stream->host, options->host, host_length + 1U);
  stream->port = options->port;
  stream->use_tls = options->use_tls;
  stream->dangerous_disable_certificate_verification =
      options->DANGEROUS_disable_certificate_verification;
  if (options->resolver_ops != NULL &&
      (options->resolver_ops->start == NULL ||
       options->resolver_ops->poll == NULL ||
       options->resolver_ops->cancel == NULL)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  stream->resolver_ops = options->resolver_ops != NULL
      ? options->resolver_ops
      : &dns_sd_resolver_ops;
  stream->resolver_context = options->resolver_ops != NULL
      ? options->resolver_context
      : &stream->default_resolver;
  if (!stream->use_tls) {
    stream->dangerous_disable_certificate_verification = false;
    stream->initialized = true;
    return ITERATE_KIT_OK;
  }
  stream->context = SSL_CTX_new(TLS_client_method());
  if (stream->context == NULL ||
      SSL_CTX_set_min_proto_version(
          stream->context, TLS1_2_VERSION) != 1) {
    SSL_CTX_free(stream->context);
    memset(stream, 0, sizeof(*stream));
    return ITERATE_KIT_IO_ERROR;
  }
  if (!stream->dangerous_disable_certificate_verification) {
    SSL_CTX_set_verify(stream->context, SSL_VERIFY_PEER, NULL);
#if defined(__APPLE__)
    /*
     * macOS maintains /etc/ssl/cert.pem as its command-line system trust
     * bundle. Naming it explicitly avoids Homebrew prefix changes silently
     * selecting a different CA universe from the host running the rig.
     */
    if (SSL_CTX_load_verify_locations(
            stream->context, "/etc/ssl/cert.pem", NULL) != 1) {
      SSL_CTX_free(stream->context);
      memset(stream, 0, sizeof(*stream));
      return ITERATE_KIT_IO_ERROR;
    }
#else
    if (SSL_CTX_set_default_verify_paths(stream->context) != 1) {
      SSL_CTX_free(stream->context);
      memset(stream, 0, sizeof(*stream));
      return ITERATE_KIT_IO_ERROR;
    }
#endif
  } else {
    SSL_CTX_set_verify(stream->context, SSL_VERIFY_NONE, NULL);
  }
  stream->initialized = true;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_posix_tls_connect_result start_tcp(
    struct iterate_kit_posix_tls_stream *stream) {
  const struct iterate_kit_posix_tls_address *address =
      &stream->addresses[stream->address_index];
  int flags;
  int result;
  stream->descriptor = socket(
      address->family,
      address->socktype,
      address->protocol);
  if (stream->descriptor < 0) {
    remember_failure(stream);
    return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
  }
#if defined(SO_NOSIGPIPE)
  {
    const int enabled = 1;
    if (setsockopt(
            stream->descriptor,
            SOL_SOCKET,
            SO_NOSIGPIPE,
            &enabled,
            sizeof(enabled)) != 0) {
      remember_failure(stream);
      (void)close(stream->descriptor);
      stream->descriptor = -1;
      return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
    }
  }
#endif
  flags = fcntl(stream->descriptor, F_GETFL, 0);
  if (flags < 0 ||
      fcntl(stream->descriptor, F_SETFL, flags | O_NONBLOCK) < 0) {
    (void)close(stream->descriptor);
    stream->descriptor = -1;
    remember_failure(stream);
    return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
  }
  result = connect(
      stream->descriptor,
      (const struct sockaddr *)&address->storage,
      address->length);
  if (result != 0 && errno != EINPROGRESS && errno != EWOULDBLOCK) {
    remember_failure(stream);
    (void)close(stream->descriptor);
    stream->descriptor = -1;
    ++stream->address_index;
    return stream->address_index < stream->address_count ||
            !stream->resolver_snapshot_complete
        ? ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK
        : ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
  }
  stream->tcp_connecting = result != 0;
  return stream->tcp_connecting
      ? ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK
      : ITERATE_KIT_POSIX_TLS_CONNECT_READY;
}

static bool tcp_connected(
    struct iterate_kit_posix_tls_stream *stream) {
  struct pollfd candidate = {
    .fd = stream->descriptor,
    .events = POLLOUT,
  };
  int socket_error = 0;
  socklen_t length = sizeof(socket_error);
  const int poll_result = poll(&candidate, 1U, 0);
  if (poll_result == 0) {
    errno = EINPROGRESS;
    return false;
  }
  if (poll_result < 0 || (candidate.revents & POLLNVAL) != 0) {
    remember_failure(stream);
    return false;
  }
  if (getsockopt(
          stream->descriptor,
          SOL_SOCKET,
          SO_ERROR,
          &socket_error,
          &length) != 0 || socket_error != 0) {
    errno = socket_error != 0 ? socket_error : errno;
    remember_failure(stream);
    return false;
  }
  stream->tcp_connecting = false;
  return true;
}

static bool try_next_address(
    struct iterate_kit_posix_tls_stream *stream) {
  if (stream->descriptor >= 0) {
    (void)close(stream->descriptor);
    stream->descriptor = -1;
  }
  stream->tcp_connecting = false;
  ++stream->address_index;
  return stream->address_index < stream->address_count;
}

static bool begin_tls(
    struct iterate_kit_posix_tls_stream *stream) {
  stream->ssl = SSL_new(stream->context);
  if (stream->ssl == NULL ||
      SSL_set_fd(stream->ssl, stream->descriptor) != 1 ||
      SSL_set_tlsext_host_name(stream->ssl, stream->host) != 1 ||
      (!stream->dangerous_disable_certificate_verification &&
       SSL_set1_host(stream->ssl, stream->host) != 1)) {
    remember_failure(stream);
    return false;
  }
  stream->tls_handshaking = true;
  return true;
}

enum iterate_kit_posix_tls_connect_result
iterate_kit_posix_tls_stream_connect(
    struct iterate_kit_posix_tls_stream *stream) {
  int result;
  int ssl_error;
  enum iterate_kit_posix_tls_connect_result tcp_result;
  if (stream == NULL || !stream->initialized) {
    return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
  }
  if (stream->ready) {
    return ITERATE_KIT_POSIX_TLS_CONNECT_READY;
  }
  if (!stream->resolver_snapshot_complete) {
    const enum iterate_kit_posix_tls_connect_result resolve_result =
        drive_resolver(stream);
    if (resolve_result == ITERATE_KIT_POSIX_TLS_CONNECT_FAILED &&
        stream->address_index == stream->address_count) {
      return resolve_result;
    }
    if (resolve_result == ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK &&
        stream->address_index == stream->address_count &&
        stream->descriptor < 0) {
      return resolve_result;
    }
  }
  if (stream->descriptor < 0) {
    tcp_result = start_tcp(stream);
    if (tcp_result != ITERATE_KIT_POSIX_TLS_CONNECT_READY) {
      return tcp_result;
    }
  } else if (stream->tcp_connecting && !tcp_connected(stream)) {
    /* SO_ERROR remains EINPROGRESS on macOS until the connect completes. */
    if (errno == EINPROGRESS || errno == EALREADY) {
      return ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK;
    }
    return try_next_address(stream) ||
            !stream->resolver_snapshot_complete
        ? ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK
        : ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
  }
  if (!stream->use_tls) {
    stream->last_errno = 0;
    stream->last_openssl_error = 0UL;
    stream->ready = true;
    stream->resolver_snapshot_complete = true;
    cancel_resolver(stream);
    return ITERATE_KIT_POSIX_TLS_CONNECT_READY;
  }
  if (stream->ssl == NULL && !begin_tls(stream)) {
    iterate_kit_posix_tls_stream_close(stream);
    return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
  }
  ERR_clear_error();
  result = SSL_connect(stream->ssl);
  if (result == 1) {
    if (!stream->dangerous_disable_certificate_verification &&
        SSL_get_verify_result(stream->ssl) != X509_V_OK) {
      remember_failure(stream);
      iterate_kit_posix_tls_stream_close(stream);
      return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
    }
    stream->tls_handshaking = false;
    stream->last_errno = 0;
    stream->last_openssl_error = 0UL;
    stream->ready = true;
    stream->resolver_snapshot_complete = true;
    cancel_resolver(stream);
    return ITERATE_KIT_POSIX_TLS_CONNECT_READY;
  }
  ssl_error = SSL_get_error(stream->ssl, result);
  if (ssl_error == SSL_ERROR_WANT_READ ||
      ssl_error == SSL_ERROR_WANT_WRITE) {
    return ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK;
  }
  remember_failure(stream);
  iterate_kit_posix_tls_stream_close(stream);
  return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
}

static enum iterate_kit_posix_tls_io_result classify_io(
    struct iterate_kit_posix_tls_stream *stream,
    int result) {
  const int ssl_error = SSL_get_error(stream->ssl, result);
  if (ssl_error == SSL_ERROR_WANT_READ ||
      ssl_error == SSL_ERROR_WANT_WRITE) {
    return ITERATE_KIT_POSIX_TLS_IO_WOULD_BLOCK;
  }
  remember_failure(stream);
  stream->ready = false;
  return ITERATE_KIT_POSIX_TLS_IO_FAILED;
}

static enum iterate_kit_posix_tls_io_result classify_socket_io(
    struct iterate_kit_posix_tls_stream *stream,
    ssize_t result) {
  if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
    return ITERATE_KIT_POSIX_TLS_IO_WOULD_BLOCK;
  }
  remember_failure(stream);
  stream->ready = false;
  return ITERATE_KIT_POSIX_TLS_IO_FAILED;
}

enum iterate_kit_posix_tls_io_result iterate_kit_posix_tls_stream_read(
    struct iterate_kit_posix_tls_stream *stream,
    uint8_t *bytes,
    size_t byte_capacity,
    size_t *bytes_read) {
  int result;
  if (bytes_read != NULL) {
    *bytes_read = 0U;
  }
  if (stream == NULL || !stream->ready || bytes == NULL ||
      byte_capacity == 0U || bytes_read == NULL) {
    return ITERATE_KIT_POSIX_TLS_IO_FAILED;
  }
  if (!stream->use_tls) {
    const ssize_t socket_result =
        recv(stream->descriptor, bytes, byte_capacity, 0);
    if (socket_result > 0) {
      *bytes_read = (size_t)socket_result;
      return ITERATE_KIT_POSIX_TLS_IO_PROGRESS;
    }
    return classify_socket_io(stream, socket_result);
  }
  ERR_clear_error();
  result = SSL_read_ex(stream->ssl, bytes, byte_capacity, bytes_read);
  return result == 1
      ? ITERATE_KIT_POSIX_TLS_IO_PROGRESS
      : classify_io(stream, result);
}

enum iterate_kit_posix_tls_io_result iterate_kit_posix_tls_stream_write(
    struct iterate_kit_posix_tls_stream *stream,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  int result;
  if (bytes_written != NULL) {
    *bytes_written = 0U;
  }
  if (stream == NULL || !stream->ready || bytes == NULL ||
      byte_count == 0U || bytes_written == NULL) {
    return ITERATE_KIT_POSIX_TLS_IO_FAILED;
  }
  if (!stream->use_tls) {
    const ssize_t socket_result =
        send(stream->descriptor, bytes, byte_count, 0);
    if (socket_result > 0) {
      *bytes_written = (size_t)socket_result;
      return ITERATE_KIT_POSIX_TLS_IO_PROGRESS;
    }
    return classify_socket_io(stream, socket_result);
  }
  ERR_clear_error();
  result = SSL_write_ex(stream->ssl, bytes, byte_count, bytes_written);
  return result == 1
      ? ITERATE_KIT_POSIX_TLS_IO_PROGRESS
      : classify_io(stream, result);
}
