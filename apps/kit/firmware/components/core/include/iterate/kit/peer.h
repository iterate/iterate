#ifndef ITERATE_KIT_PEER_H
#define ITERATE_KIT_PEER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_poll_status {
  ITERATE_KIT_POLL_OK = 0,
  ITERATE_KIT_POLL_DRIVER_ERROR,
  ITERATE_KIT_POLL_CALLBACK_REJECTED,
  ITERATE_KIT_POLL_CAPNWEB_ERROR,
};

struct iterate_kit_poll_result {
  enum iterate_kit_poll_status status;
  enum capnweb_status capnweb_status;
};

struct iterate_kit_method {
  const char *const *path;
  size_t path_count;
  capnweb_dispatch_fn dispatch;
};

typedef struct iterate_kit_poll_result (*iterate_kit_module_poll_fn)(
    void *context, uint64_t now_ms);
typedef struct iterate_kit_poll_result (*iterate_kit_module_close_fn)(
    void *context);
typedef void (*iterate_kit_module_session_ended_fn)(void *context);

/**
 * One composable capability module. Method and module arrays are borrowed for
 * the peer lifetime and are normally static or embedded in a device profile.
 *
 * poll() must perform bounded cooperative work; the peer adds no task, queue,
 * mutex, allocation, or retry. session_ended() releases session-scoped remote
 * handles without shutting down physical hardware. close() is the separate
 * device-lifecycle boundary and may therefore stop hardware.
 */
struct iterate_kit_module {
  const struct iterate_kit_method *methods;
  size_t method_count;
  void *context;
  iterate_kit_module_poll_fn poll;
  iterate_kit_module_close_fn close;
  /**
   * Drops handles borrowed from a Cap'n Web session without touching the
   * physical device. The owner calls this after that session has ended.
   */
  iterate_kit_module_session_ended_fn session_ended;
};

struct iterate_kit_peer_options {
  const char *description_expression;
  size_t description_expression_length;
  const struct iterate_kit_module *modules;
  size_t module_count;
};

/**
 * Allocation-free Cap'n Web target assembled from independent modules.
 *
 * Method paths must be globally unique. Initialization rejects ambiguity
 * instead of resolving it by module order, because generated profile ordering
 * must never silently select a different physical action. The peer borrows the
 * generated description expression and tables for its whole lifetime and is
 * mutated by one cooperative owner.
 */
struct iterate_kit_peer {
  struct iterate_kit_peer_options options;
  struct iterate_kit_poll_result last_poll_result;
  bool initialized;
};

enum capnweb_status iterate_kit_peer_init(
    struct iterate_kit_peer *peer,
    const struct iterate_kit_peer_options *options);
struct capnweb_capability iterate_kit_peer_capability(
    struct iterate_kit_peer *peer);
struct iterate_kit_poll_result iterate_kit_peer_poll(
    struct iterate_kit_peer *peer, uint64_t now_ms);
void iterate_kit_peer_session_ended(struct iterate_kit_peer *peer);
struct iterate_kit_poll_result iterate_kit_peer_close(
    struct iterate_kit_peer *peer);

#ifdef __cplusplus
}
#endif

#endif
