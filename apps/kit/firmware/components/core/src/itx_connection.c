#include "iterate/kit/itx_connection.h"

#include <limits.h>
#include <string.h>

/*
 * This object is the protocol half of one control WebSocket. The ESP platform
 * owns socket connection/retry and serializes all calls; this layer owns one
 * bounded Cap'n Web session plus the authenticate -> project -> live-provision
 * mount.
 * Keeping transport and protocol lifecycles separate lets a lost socket close
 * local state without attempting I/O, while an intentional shutdown can still
 * release its live provision.
 *
 * All arrays and buffers are caller-owned. Heap allocation was rejected both
 * for deterministic ESP memory and because a hostile peer must not grow parser,
 * import, export, or pending-call state without a profile-visible limit.
 */
static bool valid_storage(const void *storage, size_t count) {
  return count == 0U || storage != NULL;
}

static bool valid_options(
    const struct iterate_kit_itx_connection_options *options) {
  return options != NULL &&
      valid_storage(options->pending_calls, options->pending_call_count) &&
      valid_storage(options->exports, options->export_count) &&
      valid_storage(options->imports, options->import_count) &&
      options->tokens != NULL &&
      options->token_count > 0U &&
      options->outbound_buffer != NULL &&
      options->outbound_buffer_size > 0U &&
      options->send_text != NULL &&
      options->project_id != NULL &&
      options->project_api_key != NULL &&
      options->client_path != NULL &&
      options->description != NULL &&
      options->capability.dispatch != NULL;
}

static void end_session(
    struct iterate_kit_itx_connection *connection) {
  if (!connection->session_open) {
    return;
  }
  capnweb_session_close(&connection->session);
  connection->session_open = false;
  /*
   * Notify exactly once per opened generation, after Cap'n Web has settled its
   * callbacks. Device modules use this boundary to discard session-scoped
   * imports; notifying earlier would allow them to race completion callbacks.
   */
  if (connection->options.session_ended != NULL) {
    connection->options.session_ended(
        connection->options.session_ended_context);
  }
}

static enum iterate_kit_itx_connection_state refresh(
    struct iterate_kit_itx_connection *connection) {
  enum capnweb_session_state session_state;
  if (!connection->initialized) {
    return ITERATE_KIT_ITX_CONNECTION_FAILED;
  }
  if (connection->state == ITERATE_KIT_ITX_CONNECTION_DISCONNECTED ||
      connection->state == ITERATE_KIT_ITX_CONNECTION_CLOSED) {
    return connection->state;
  }
  session_state = capnweb_session_get_state(&connection->session);
  if (session_state != CAPNWEB_SESSION_OPEN) {
    /*
     * A terminal session is never kept in READY merely because the mount once
     * succeeded. Capture the protocol's terminal status before close resets
     * ownership, so reconnect diagnostics retain the causal failure.
     */
    const enum capnweb_status status =
        capnweb_session_get_terminal_status(&connection->session);
    end_session(connection);
    connection->state = ITERATE_KIT_ITX_CONNECTION_FAILED;
    connection->capnweb_status = status;
    return connection->state;
  }
  if (connection->mount.state == ITERATE_KIT_ITX_MOUNT_READY) {
    connection->state = ITERATE_KIT_ITX_CONNECTION_READY;
    connection->capnweb_status = CAPNWEB_OK;
  } else if (
      connection->mount.state == ITERATE_KIT_ITX_MOUNT_FAILED) {
    /*
     * Mount failures are terminal for this generation. Retrying auth/provide
     * calls inside the same session could duplicate a live provision and blur
     * rejection versus transport recovery; the outer platform decides whether
     * and when to open a fresh generation.
     */
    const enum capnweb_status status = connection->mount.capnweb_status;
    end_session(connection);
    connection->state = ITERATE_KIT_ITX_CONNECTION_FAILED;
    connection->capnweb_status = status;
  } else {
    connection->state = ITERATE_KIT_ITX_CONNECTION_MOUNTING;
  }
  return connection->state;
}

enum capnweb_status iterate_kit_itx_connection_init(
    struct iterate_kit_itx_connection *connection,
    const struct iterate_kit_itx_connection_options *options) {
  if (connection == NULL || !valid_options(options)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(connection, 0, sizeof(*connection));
  connection->options = *options;
  connection->state = ITERATE_KIT_ITX_CONNECTION_DISCONNECTED;
  connection->capnweb_status = CAPNWEB_OK;
  connection->initialized = true;
  return CAPNWEB_OK;
}

enum capnweb_status iterate_kit_itx_connection_open(
    struct iterate_kit_itx_connection *connection) {
  struct capnweb_session_options session_options;
  struct iterate_kit_itx_mount_options mount_options;
  enum capnweb_status status;
  if (connection == NULL || !connection->initialized) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (connection->state != ITERATE_KIT_ITX_CONNECTION_DISCONNECTED &&
      connection->state != ITERATE_KIT_ITX_CONNECTION_CLOSED) {
    return CAPNWEB_E_STATE;
  }
  if (connection->generation == UINT32_MAX) {
    /*
     * Generation is used to distinguish reconnect epochs in diagnostics.
     * Reusing zero after wrap could make stale events look current, so an
     * effectively unreachable uptime limit is explicit rather than ambiguous.
     */
    connection->state = ITERATE_KIT_ITX_CONNECTION_FAILED;
    connection->capnweb_status = CAPNWEB_E_LIMIT;
    return CAPNWEB_E_LIMIT;
  }
  session_options = (struct capnweb_session_options){
    connection->options.capability,
    connection->options.send_text,
    connection->options.send_text_context,
    connection->options.pending_calls,
    connection->options.pending_call_count,
    connection->options.exports,
    connection->options.export_count,
    connection->options.imports,
    connection->options.import_count,
    connection->options.tokens,
    connection->options.token_count,
    connection->options.outbound_buffer,
    connection->options.outbound_buffer_size,
  };
  status = capnweb_session_init(
      &connection->session, &session_options);
  if (status != CAPNWEB_OK) {
    connection->state = ITERATE_KIT_ITX_CONNECTION_FAILED;
    connection->capnweb_status = status;
    return status;
  }
  connection->session_open = true;
  ++connection->generation;
  /*
   * Start the mount only after the session is fully initialized and marked
   * open. Its first call can synchronously use send_text; reversing this order
   * would make cleanup/notification believe no session owns that call.
   */
  mount_options = (struct iterate_kit_itx_mount_options){
    &connection->session,
    connection->options.project_id,
    connection->options.project_api_key,
    connection->options.client_path,
    connection->options.capability,
    connection->options.description,
    connection->options.types,
  };
  status = iterate_kit_itx_mount_start(
      &connection->mount, &mount_options);
  if (status != CAPNWEB_OK) {
    connection->state = ITERATE_KIT_ITX_CONNECTION_FAILED;
    connection->capnweb_status = status;
    end_session(connection);
    return status;
  }
  connection->state = ITERATE_KIT_ITX_CONNECTION_MOUNTING;
  connection->capnweb_status = CAPNWEB_OK;
  return CAPNWEB_OK;
}

enum capnweb_status iterate_kit_itx_connection_receive_text(
    struct iterate_kit_itx_connection *connection,
    const char *message,
    size_t length) {
  enum capnweb_status status;
  if (connection == NULL ||
      !connection->initialized ||
      (message == NULL && length > 0U)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (connection->state != ITERATE_KIT_ITX_CONNECTION_MOUNTING &&
      connection->state != ITERATE_KIT_ITX_CONNECTION_READY) {
    return CAPNWEB_E_STATE;
  }
  status = capnweb_session_receive(
      &connection->session, message, length);
  if (status != CAPNWEB_OK) {
    /*
     * Invalid text is a session-fatal protocol boundary, not a message to skip.
     * Continuing after Cap'n Web loses framing/reference coherence could mount
     * or invoke the wrong capability.
     */
    connection->state = ITERATE_KIT_ITX_CONNECTION_FAILED;
    connection->capnweb_status = status;
    end_session(connection);
    return status;
  }
  (void)refresh(connection);
  return CAPNWEB_OK;
}

enum iterate_kit_itx_connection_state
iterate_kit_itx_connection_refresh(
    struct iterate_kit_itx_connection *connection) {
  if (connection == NULL) {
    return ITERATE_KIT_ITX_CONNECTION_FAILED;
  }
  return refresh(connection);
}

void iterate_kit_itx_connection_lost(
    struct iterate_kit_itx_connection *connection) {
  if (connection == NULL || !connection->initialized) {
    return;
  }
  if (connection->session_open) {
    /*
     * Transport is already gone, so only local session close is safe. The live
     * remote provision disappears with that session; emitting explicit release
     * frames here would block/fail and obscure the original network loss.
     */
    end_session(connection);
  }
  connection->state = ITERATE_KIT_ITX_CONNECTION_DISCONNECTED;
  connection->capnweb_status = CAPNWEB_E_CLOSED;
}

enum capnweb_status iterate_kit_itx_connection_close(
    struct iterate_kit_itx_connection *connection) {
  enum capnweb_status status;
  if (connection == NULL || !connection->initialized) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (connection->state == ITERATE_KIT_ITX_CONNECTION_CLOSED) {
    return CAPNWEB_OK;
  }
  if (connection->state == ITERATE_KIT_ITX_CONNECTION_DISCONNECTED) {
    connection->state = ITERATE_KIT_ITX_CONNECTION_CLOSED;
    return CAPNWEB_OK;
  }
  status = CAPNWEB_OK;
  if (connection->session_open) {
    /*
     * Deliberate close still has a writable transport, so release the mount
     * first. Regardless of release success, close local session state exactly
     * once and return the classified cleanup error to the owner.
     */
    status = iterate_kit_itx_mount_close(&connection->mount);
    end_session(connection);
  }
  connection->state = ITERATE_KIT_ITX_CONNECTION_CLOSED;
  connection->capnweb_status = status;
  return status;
}

const char *iterate_kit_itx_connection_state_name(
    enum iterate_kit_itx_connection_state state) {
  switch (state) {
    case ITERATE_KIT_ITX_CONNECTION_DISCONNECTED: return "disconnected";
    case ITERATE_KIT_ITX_CONNECTION_MOUNTING: return "mounting";
    case ITERATE_KIT_ITX_CONNECTION_READY: return "ready";
    case ITERATE_KIT_ITX_CONNECTION_FAILED: return "failed";
    case ITERATE_KIT_ITX_CONNECTION_CLOSED: return "closed";
    default: return "unknown";
  }
}

void iterate_kit_itx_connection_tables(
    const struct iterate_kit_itx_connection *connection,
    struct iterate_kit_itx_connection_tables *out) {
  size_t index;

  if (out == NULL) return;
  /* Zeroed rather than left alone: a caller that reads a partly-filled struct
   * after a NULL connection would report capacities of whatever was on the
   * stack, which reads as a table that is fine. */
  out->exports_used = 0U;
  out->exports_capacity = 0U;
  out->imports_used = 0U;
  out->imports_capacity = 0U;
  out->calls_used = 0U;
  out->calls_capacity = 0U;
  if (connection == NULL || !connection->initialized) return;

  const struct capnweb_session_options *options = &connection->session.options;
  out->exports_capacity = (uint32_t)options->export_count;
  out->imports_capacity = (uint32_t)options->import_count;
  out->calls_capacity = (uint32_t)options->pending_call_count;
  for (index = 0U; index < options->export_count; index++) {
    if (options->exports[index].occupied) out->exports_used++;
  }
  for (index = 0U; index < options->import_count; index++) {
    if (options->imports[index].occupied) out->imports_used++;
  }
  for (index = 0U; index < options->pending_call_count; index++) {
    if (options->pending_calls[index].occupied) out->calls_used++;
  }
}
