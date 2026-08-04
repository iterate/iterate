#include "iterate/kit/platforms/posix_tls_stream.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

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
  stream->last_openssl_error = ERR_peek_last_error();
}

static bool resolve_endpoint(
    struct iterate_kit_posix_tls_stream *stream) {
  struct addrinfo hints;
  struct addrinfo *addresses = NULL;
  const struct addrinfo *address;
  char port[6];
  int result;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;
  (void)snprintf(port, sizeof(port), "%u", (unsigned int)stream->port);
  result = getaddrinfo(stream->host, port, &hints, &addresses);
  if (result != 0) {
    stream->last_errno = result;
    return false;
  }
  address = addresses;
  while (address != NULL &&
         address->ai_addrlen > sizeof(stream->address)) {
    address = address->ai_next;
  }
  if (address == NULL) {
    freeaddrinfo(addresses);
    stream->last_errno = EAI_OVERFLOW;
    return false;
  }
  memcpy(&stream->address, address->ai_addr, address->ai_addrlen);
  stream->address_length = address->ai_addrlen;
  stream->address_family = address->ai_family;
  stream->address_socktype = address->ai_socktype;
  stream->address_protocol = address->ai_protocol;
  freeaddrinfo(addresses);
  return true;
}

void iterate_kit_posix_tls_stream_close(
    struct iterate_kit_posix_tls_stream *stream) {
  if (stream == NULL || !stream->initialized) {
    return;
  }
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
  stream->dangerous_disable_certificate_verification =
      options->DANGEROUS_disable_certificate_verification;
  if (!resolve_endpoint(stream)) {
    memset(stream, 0, sizeof(*stream));
    return ITERATE_KIT_IO_ERROR;
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
  int flags;
  int result;
  stream->descriptor = socket(
      stream->address_family,
      stream->address_socktype,
      stream->address_protocol);
  if (stream->descriptor < 0) {
    remember_failure(stream);
    return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
  }
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
      (const struct sockaddr *)&stream->address,
      stream->address_length);
  if (result != 0 && errno != EINPROGRESS && errno != EWOULDBLOCK) {
    remember_failure(stream);
    (void)close(stream->descriptor);
    stream->descriptor = -1;
    return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
  }
  stream->tcp_connecting = result != 0;
  return stream->tcp_connecting
      ? ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK
      : ITERATE_KIT_POSIX_TLS_CONNECT_READY;
}

static bool tcp_connected(
    struct iterate_kit_posix_tls_stream *stream) {
  int socket_error = 0;
  socklen_t length = sizeof(socket_error);
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
    iterate_kit_posix_tls_stream_close(stream);
    return ITERATE_KIT_POSIX_TLS_CONNECT_FAILED;
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
    stream->ready = true;
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
  ERR_clear_error();
  result = SSL_write_ex(stream->ssl, bytes, byte_count, bytes_written);
  return result == 1
      ? ITERATE_KIT_POSIX_TLS_IO_PROGRESS
      : classify_io(stream, result);
}
