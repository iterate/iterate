#ifndef ITERATE_KIT_ITX_CONNECTION_H
#define ITERATE_KIT_ITX_CONNECTION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/itx_mount.h"

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_itx_connection_state {
  ITERATE_KIT_ITX_CONNECTION_DISCONNECTED = 0,
  ITERATE_KIT_ITX_CONNECTION_MOUNTING,
  ITERATE_KIT_ITX_CONNECTION_READY,
  ITERATE_KIT_ITX_CONNECTION_FAILED,
  ITERATE_KIT_ITX_CONNECTION_CLOSED,
};

/**
 * The connection state as a word, for `health()`.
 *
 * It was the one state in the mount chain nothing published, and a voicelab
 * that had latched failed could not be told from one waiting on a connection
 * that had latched under it. Never NULL.
 */
const char *iterate_kit_itx_connection_state_name(
    enum iterate_kit_itx_connection_state state);

typedef void (*iterate_kit_itx_connection_session_ended_fn)(void *context);

struct iterate_kit_itx_connection_options {
  /*
   * All arrays, buffers, strings, callback contexts, and capability state are
   * borrowed for the connection lifetime. Counts make Cap'n Web's RAM ceiling
   * part of the device profile; exhaustion is an explicit protocol failure,
   * never a heap-growth path.
   */
  struct capnweb_pending_call *pending_calls;
  size_t pending_call_count;
  struct capnweb_export *exports;
  size_t export_count;
  struct capnweb_import *imports;
  size_t import_count;
  struct capnweb_json_token *tokens;
  size_t token_count;
  char *outbound_buffer;
  size_t outbound_buffer_size;
  capnweb_send_text_fn send_text;
  void *send_text_context;
  const char *project_id;
  const char *project_api_key;
  /** This device's client path, e.g. "/clients/stackchan" — see itx_mount.h. */
  const char *client_path;
  struct capnweb_capability capability;
  /** Human label for this client; journals as the provision's instructions. */
  const char *description;
  const char *types;
  iterate_kit_itx_connection_session_ended_fn session_ended;
  void *session_ended_context;
};

/**
 * Allocation-free Cap'n Web connection state. A platform owns the actual
 * socket and serializes calls to this object; the object owns protocol state,
 * bounded Cap'n Web parser tables, authentication, and the live mount.
 * WebSocket frame/text reassembly stays in `websocket_text`, which calls this
 * object only with one complete text message.
 *
 * This layer does not reconnect, wait, or own the WebSocket. `open()` begins
 * protocol state only after transport connection; `lost()` tears protocol
 * state down without writing; `close()` may emit releases while transport is
 * still writable. Mixing those paths would turn network loss into blocking
 * cleanup or omit deliberate unmounts.
 */
struct iterate_kit_itx_connection {
  struct iterate_kit_itx_connection_options options;
  struct capnweb_session session;
  struct iterate_kit_itx_mount mount;
  enum iterate_kit_itx_connection_state state;
  enum capnweb_status capnweb_status;
  uint32_t generation;
  bool initialized;
  bool session_open;
};

/** How much of a session's fixed tables is in use, right now. */
struct iterate_kit_itx_connection_tables {
  /** Capabilities this device has handed out, and the table's size. */
  uint32_t exports_used;
  uint32_t exports_capacity;
  /** Answers this device is still waiting for, and the table's size. */
  uint32_t imports_used;
  uint32_t imports_capacity;
  /** Calls made TO this device that it has not answered, and the size. */
  uint32_t calls_used;
  uint32_t calls_capacity;
};

/**
 * Count the occupied slots in a session's three tables.
 *
 * A FULL TABLE LOOKS LIKE A BROKEN DEVICE. These are fixed arrays sized at
 * boot; when one fills, the next call fails with a status nobody traces back to
 * a table, and the device latches into a state it never leaves. Nothing
 * published how full they were, so "it worked twice and then never again" — the
 * signature of a leak — could not be told from a network fault.
 *
 * Cheap: three linear scans of a few dozen entries, on the health path only.
 */
void iterate_kit_itx_connection_tables(
    const struct iterate_kit_itx_connection *connection,
    struct iterate_kit_itx_connection_tables *out);

enum capnweb_status iterate_kit_itx_connection_init(
    struct iterate_kit_itx_connection *connection,
    const struct iterate_kit_itx_connection_options *options);

/**
 * Starts a fresh Cap'n Web session after the platform socket is connected.
 * Each newly initialized Cap'n Web session advances `generation`, even if its
 * mount later fails. Wrap is a hard limit rather than reusing an identity that
 * diagnostics may mistake for an old session.
 */
enum capnweb_status iterate_kit_itx_connection_open(
    struct iterate_kit_itx_connection *connection);

enum capnweb_status iterate_kit_itx_connection_receive_text(
    struct iterate_kit_itx_connection *connection,
    const char *message,
    size_t length);

/**
 * Reconciles state after an external peer poll may have sent RPC messages.
 * This is pure protocol progress on the owner task; it performs no socket I/O
 * beyond sends synchronously requested through the configured callback.
 */
enum iterate_kit_itx_connection_state
iterate_kit_itx_connection_refresh(
    struct iterate_kit_itx_connection *connection);

/** Ends protocol state without trying to write to a socket that was lost. */
void iterate_kit_itx_connection_lost(
    struct iterate_kit_itx_connection *connection);

/** Cleanly releases the live provision while the socket remains writable. */
enum capnweb_status iterate_kit_itx_connection_close(
    struct iterate_kit_itx_connection *connection);

#ifdef __cplusplus
}
#endif

#endif
