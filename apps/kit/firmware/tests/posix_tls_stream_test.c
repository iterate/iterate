#include "iterate/kit/platforms/posix_tls_stream.h"

#include <assert.h>
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

enum fake_resolver_mode {
  FAKE_RESOLVER_DUAL_STACK,
  FAKE_RESOLVER_PENDING,
  FAKE_RESOLVER_ERROR,
};

struct fake_resolver {
  iterate_kit_posix_tls_resolved_address_fn resolved;
  void *resolved_context;
  enum fake_resolver_mode mode;
  unsigned int polls;
  unsigned int cancellations;
};

static int fake_resolver_start(
    void *operations_context,
    const char *host,
    iterate_kit_posix_tls_resolved_address_fn resolved,
    void *resolved_context,
    void **handle) {
  struct fake_resolver *resolver = operations_context;
  assert(strcmp(host, "resolver.test") == 0);
  resolver->resolved = resolved;
  resolver->resolved_context = resolved_context;
  *handle = resolver;
  return 0;
}

static int fake_resolver_poll(void *operations_context, void *handle) {
  struct fake_resolver *resolver = operations_context;
  assert(handle == resolver);
  ++resolver->polls;
  if (resolver->mode == FAKE_RESOLVER_PENDING) {
    return EAGAIN;
  }
  if (resolver->mode == FAKE_RESOLVER_ERROR) {
    return EHOSTUNREACH;
  }
  if (resolver->polls == 1U) {
    struct sockaddr_in6 ipv6;
    memset(&ipv6, 0, sizeof(ipv6));
    ipv6.sin6_family = AF_INET6;
    ipv6.sin6_addr = in6addr_loopback;
    resolver->resolved(
        resolver->resolved_context,
        0,
        true,
        (const struct sockaddr *)&ipv6);
    return 0;
  }
  if (resolver->polls == 2U) {
    struct sockaddr_in ipv4;
    memset(&ipv4, 0, sizeof(ipv4));
    ipv4.sin_family = AF_INET;
    ipv4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    resolver->resolved(
        resolver->resolved_context,
        0,
        true,
        (const struct sockaddr *)&ipv4);
  }
  return EAGAIN;
}

static void fake_resolver_cancel(
    void *operations_context, void *handle) {
  struct fake_resolver *resolver = operations_context;
  assert(handle == resolver);
  ++resolver->cancellations;
}

static const struct iterate_kit_posix_tls_resolver_ops fake_resolver_ops = {
  .start = fake_resolver_start,
  .poll = fake_resolver_poll,
  .cancel = fake_resolver_cancel,
};

static const struct iterate_kit_byte_stream_ops *const ops =
    &iterate_kit_posix_tls_stream_ops;

static void plain_stream_transfers_bytes_over_loopback(void) {
  static const uint8_t request[] = "ping";
  static const uint8_t response[] = "pong";
  struct sockaddr_in address;
  socklen_t address_length = sizeof(address);
  struct iterate_kit_posix_tls_stream stream;
  struct fake_resolver resolver = {
    .mode = FAKE_RESOLVER_DUAL_STACK,
  };
  struct iterate_kit_posix_tls_stream_options options = {
    .host = "resolver.test",
    .use_tls = false,
    .resolver_ops = &fake_resolver_ops,
    .resolver_context = &resolver,
  };
  uint8_t bytes[sizeof(response)];
  size_t byte_count = 0U;
  int listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  int peer;
  unsigned int poll_count;
  assert(listener >= 0);
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  assert(bind(
             listener,
             (const struct sockaddr *)&address,
             sizeof(address)) == 0);
  assert(getsockname(
             listener,
             (struct sockaddr *)&address,
             &address_length) == 0);
  assert(listen(listener, 1) == 0);
  options.port = ntohs(address.sin_port);
  assert(iterate_kit_posix_tls_stream_prepare(
             &stream, &options) == ITERATE_KIT_OK);
  for (poll_count = 0U; poll_count < 1000U; ++poll_count) {
    const enum iterate_kit_byte_stream_result result = ops->connect(&stream);
    if (result == ITERATE_KIT_BYTE_STREAM_PROGRESS) {
      break;
    }
    assert(result == ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  }
  assert(stream.ready);
  assert(resolver.polls >= 2U);
  assert(resolver.cancellations == 1U);
  peer = accept(listener, NULL, NULL);
  assert(peer >= 0);
  assert(ops->write(&stream, request, sizeof(request), &byte_count) ==
         ITERATE_KIT_BYTE_STREAM_PROGRESS);
  assert(byte_count == sizeof(request));
  assert(read(peer, bytes, sizeof(request)) == (ssize_t)sizeof(request));
  assert(memcmp(bytes, request, sizeof(request)) == 0);
  assert(write(peer, response, sizeof(response)) == (ssize_t)sizeof(response));
  for (poll_count = 0U; poll_count < 1000U; ++poll_count) {
    const enum iterate_kit_byte_stream_result result =
        ops->read(&stream, bytes, sizeof(bytes), &byte_count);
    if (result == ITERATE_KIT_BYTE_STREAM_PROGRESS) {
      break;
    }
    assert(result == ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  }
  assert(byte_count == sizeof(response));
  assert(memcmp(bytes, response, sizeof(response)) == 0);
  iterate_kit_posix_tls_stream_cleanup(&stream);
  assert(close(peer) == 0);
  assert(close(listener) == 0);
}

/* Closing a stalled attempt must cancel the exact resolver generation. */
static void pending_resolution_is_cancelled_on_close(void) {
  struct iterate_kit_posix_tls_stream stream;
  struct fake_resolver resolver = {
    .mode = FAKE_RESOLVER_PENDING,
  };
  const struct iterate_kit_posix_tls_stream_options options = {
    .host = "resolver.test",
    .port = 443U,
    .use_tls = true,
    .resolver_ops = &fake_resolver_ops,
    .resolver_context = &resolver,
  };
  assert(iterate_kit_posix_tls_stream_prepare(&stream, &options) ==
         ITERATE_KIT_OK);
  assert(ops->connect(&stream) == ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK);
  assert(resolver.cancellations == 0U);
  iterate_kit_posix_tls_stream_cleanup(&stream);
  assert(resolver.cancellations == 1U);
}

static void resolution_error_is_terminal_and_cancelled(void) {
  struct iterate_kit_posix_tls_stream stream;
  struct fake_resolver resolver = {
    .mode = FAKE_RESOLVER_ERROR,
  };
  const struct iterate_kit_posix_tls_stream_options options = {
    .host = "resolver.test",
    .port = 443U,
    .use_tls = true,
    .resolver_ops = &fake_resolver_ops,
    .resolver_context = &resolver,
  };
  assert(iterate_kit_posix_tls_stream_prepare(&stream, &options) ==
         ITERATE_KIT_OK);
  assert(ops->connect(&stream) == ITERATE_KIT_BYTE_STREAM_FAILED);
  assert(stream.last_errno == EHOSTUNREACH);
  assert(resolver.cancellations == 1U);
  iterate_kit_posix_tls_stream_cleanup(&stream);
}

/*
 * Resolution used to run synchronously in prepare(), before the transport
 * armed its open-attempt deadline. A deliberately unresolvable name must be
 * accepted here without starting DNS; the first connect() poll owns that work
 * and the surrounding transport can therefore cancel it at its deadline.
 */
static void endpoint_resolution_starts_inside_connect(void) {
  struct iterate_kit_posix_tls_stream stream;
  const struct iterate_kit_posix_tls_stream_options options = {
    .host = "deadline-proof.invalid",
    .port = 443U,
    .use_tls = true,
  };
  assert(iterate_kit_posix_tls_stream_prepare(&stream, &options) ==
         ITERATE_KIT_OK);
  assert(stream.resolver == NULL);
  assert(stream.address_count == 0U);
  iterate_kit_posix_tls_stream_cleanup(&stream);
}

int main(void) {
  plain_stream_transfers_bytes_over_loopback();
  pending_resolution_is_cancelled_on_close();
  resolution_error_is_terminal_and_cancelled();
  endpoint_resolution_starts_inside_connect();
  return 0;
}
