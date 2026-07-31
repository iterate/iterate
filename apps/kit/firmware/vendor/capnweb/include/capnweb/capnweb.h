// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#ifndef CAPNWEB_CAPNWEB_H
#define CAPNWEB_CAPNWEB_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum capnweb_status {
  CAPNWEB_OK = 0,
  CAPNWEB_E_INVALID_ARGUMENT = -1,
  CAPNWEB_E_INVALID_MESSAGE = -2,
  CAPNWEB_E_LIMIT = -3,
  CAPNWEB_E_TRANSPORT = -4,
  CAPNWEB_E_REMOTE_ABORT = -5,
  CAPNWEB_E_CLOSED = -6,
  CAPNWEB_E_UNSUPPORTED = -7,
  CAPNWEB_E_STATE = -8,
  CAPNWEB_E_CANCELED = -9,
};

enum capnweb_json_type {
  CAPNWEB_JSON_UNDEFINED = 0,
  CAPNWEB_JSON_NULL,
  CAPNWEB_JSON_BOOLEAN,
  CAPNWEB_JSON_NUMBER,
  CAPNWEB_JSON_STRING,
  CAPNWEB_JSON_ARRAY,
  CAPNWEB_JSON_OBJECT,
};

/**
 * One parser token. Applications allocate a bounded token array and give it to
 * the session as scratch space; its fields are deliberately not an API.
 */
struct capnweb_json_token {
  enum capnweb_json_type type;
  size_t start;
  size_t end;
  size_t child;
  size_t next;
  size_t count;
};

struct capnweb_session;

struct capnweb_string {
  const char *data;
  size_t length;
};

struct capnweb_local_capability {
  /** Opaque, session-bound handle returned by export_capability(). */
  struct capnweb_session *session;
  int64_t id;
};

enum capnweb_expression_kind {
  CAPNWEB_EXPRESSION_NULL = 0,
  CAPNWEB_EXPRESSION_BOOLEAN,
  CAPNWEB_EXPRESSION_INT64,
  CAPNWEB_EXPRESSION_STRING,
  CAPNWEB_EXPRESSION_ARRAY,
  CAPNWEB_EXPRESSION_OBJECT,
  CAPNWEB_EXPRESSION_CAPABILITY,
};

struct capnweb_expression;

struct capnweb_expression_array {
  const struct capnweb_expression *values;
  size_t count;
};

struct capnweb_object_field {
  struct capnweb_string key;
  const struct capnweb_expression *value;
};

struct capnweb_expression_object {
  const struct capnweb_object_field *fields;
  size_t count;
};

union capnweb_expression_value {
  bool boolean;
  int64_t integer;
  struct capnweb_string string;
  struct capnweb_expression_array array;
  struct capnweb_expression_object object;
  struct capnweb_local_capability capability;
};

struct capnweb_expression {
  enum capnweb_expression_kind kind;
  union capnweb_expression_value value;
};

/**
 * A borrowed view into the message currently being dispatched or completed.
 * It remains valid only until the callback returns.
 */
struct capnweb_value {
  const char *json;
  const struct capnweb_json_token *tokens;
  size_t token_count;
  size_t token;
};

struct capnweb_responder {
  struct capnweb_session *session;
  int64_t id;
};

struct capnweb_call {
  struct capnweb_value path;
  struct capnweb_value arguments;
  bool has_arguments;
  struct capnweb_responder responder;
};

struct capnweb_reply;

typedef enum capnweb_status (*capnweb_dispatch_fn)(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply);
typedef void (*capnweb_dispose_fn)(void *context);
typedef void (*capnweb_release_fn)(void *context);

struct capnweb_capability {
  capnweb_dispatch_fn dispatch;
  void *context;
  capnweb_dispose_fn dispose;
};

/**
 * Outbound messages are emitted as BEGIN, one or more DATA fragments, and END.
 * BEGIN and END have NULL data and zero length. A transport failure is terminal
 * because a partially emitted Cap'n Web message cannot be recovered safely.
 */
enum capnweb_text_fragment_kind {
  CAPNWEB_TEXT_BEGIN = 0,
  CAPNWEB_TEXT_DATA,
  CAPNWEB_TEXT_END,
};

typedef enum capnweb_status (*capnweb_send_text_fn)(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length);

enum capnweb_reply_kind {
  CAPNWEB_REPLY_UNSET = 0,
  CAPNWEB_REPLY_NULL,
  CAPNWEB_REPLY_BOOLEAN,
  CAPNWEB_REPLY_INT64,
  CAPNWEB_REPLY_EXPRESSION,
  CAPNWEB_REPLY_ERROR,
  CAPNWEB_REPLY_CAPABILITY,
  CAPNWEB_REPLY_DEFERRED,
  CAPNWEB_REPLY_BYTES,
};

struct capnweb_borrowed_data {
  const void *data;
  size_t length;
  capnweb_release_fn release;
  void *context;
};

struct capnweb_error {
  const char *type;
  const char *message;
};

union capnweb_reply_value {
  bool boolean;
  int64_t integer;
  struct capnweb_borrowed_data borrowed;
  struct capnweb_error error;
  struct capnweb_capability capability;
};

struct capnweb_reply {
  enum capnweb_reply_kind kind;
  union capnweb_reply_value value;
};

/**
 * Table entries are public so applications can allocate them statically. Their
 * fields are session internals and must not be read or changed by applications.
 */
struct capnweb_pending_call {
  int64_t id;
  int64_t capability_export_id;
  size_t refcount;
  bool occupied;
  bool pulled;
  bool resolution_sent;
  struct capnweb_reply reply;
};

struct capnweb_export {
  int64_t id;
  size_t refcount;
  size_t local_refcount;
  bool occupied;
  struct capnweb_capability capability;
};

enum capnweb_result_kind {
  CAPNWEB_RESULT_VALUE = 0,
  CAPNWEB_RESULT_REJECTION,
  CAPNWEB_RESULT_SESSION_ENDED,
};

struct capnweb_result {
  enum capnweb_result_kind kind;
  enum capnweb_status status;
  struct capnweb_value value;
};

typedef void (*capnweb_completion_fn)(
    void *context, const struct capnweb_result *result);

struct capnweb_import {
  int64_t id;
  bool occupied;
  capnweb_completion_fn completion;
  void *context;
};

struct capnweb_remote_capability {
  int64_t id;
};

enum capnweb_session_state {
  CAPNWEB_SESSION_OPEN = 0,
  CAPNWEB_SESSION_LOCAL_ABORTED,
  CAPNWEB_SESSION_REMOTE_ABORTED,
  CAPNWEB_SESSION_TRANSPORT_FAILED,
  CAPNWEB_SESSION_CLOSED,
};

struct capnweb_session_options {
  /** Borrowed for the session lifetime; close never disposes this capability. */
  struct capnweb_capability main_capability;
  capnweb_send_text_fn send_text;
  void *send_context;

  struct capnweb_pending_call *pending_calls;
  size_t pending_call_count;

  struct capnweb_export *exports;
  size_t export_count;

  struct capnweb_import *imports;
  size_t import_count;

  struct capnweb_json_token *tokens;
  size_t token_count;

  /**
   * Small scratch buffer used to coalesce outbound DATA fragments. Its size
   * bounds transient serialization memory, not the size of a message.
   */
  char *output_buffer;
  size_t output_buffer_size;
};

struct capnweb_session {
  struct capnweb_session_options options;
  int64_t next_incoming_call_id;
  int64_t next_outgoing_export_id;
  int64_t next_outgoing_call_id;
  enum capnweb_session_state state;
  enum capnweb_status terminal_status;
  bool receiving;
  bool sending;
};

enum capnweb_status capnweb_session_init(
    struct capnweb_session *session,
    const struct capnweb_session_options *options);

/**
 * Receives one complete UTF-8 text message. The session is single-threaded;
 * callers must serialize receive, call, responder, release, and close actions.
 */
enum capnweb_status capnweb_session_receive(
    struct capnweb_session *session, const char *message, size_t length);

void capnweb_session_close(struct capnweb_session *session);

enum capnweb_session_state capnweb_session_get_state(
    const struct capnweb_session *session);
enum capnweb_status capnweb_session_get_terminal_status(
    const struct capnweb_session *session);

enum capnweb_json_type capnweb_value_get_type(
    const struct capnweb_value *value);
size_t capnweb_value_array_size(const struct capnweb_value *value);
bool capnweb_value_array_at(
    const struct capnweb_value *value,
    size_t index,
    struct capnweb_value *element);
/**
 * Borrows the element array from a Cap'n Web array expression.
 *
 * On the wire an application array is `[ [item, ...] ]`, which distinguishes
 * it from protocol reference expressions such as `["export", id]`. Raw JSON
 * traversal deliberately preserves that encoding; use this helper at an
 * application boundary that expects an evaluated array value.
 */
bool capnweb_value_get_expression_array(
    const struct capnweb_value *value,
    struct capnweb_value *elements);
bool capnweb_value_object_get(
    const struct capnweb_value *value,
    const char *key,
    struct capnweb_value *element);
bool capnweb_value_get_boolean(
    const struct capnweb_value *value, bool *result);
bool capnweb_value_get_int64(
    const struct capnweb_value *value, int64_t *result);
bool capnweb_value_string_equals(
    const struct capnweb_value *value, const char *expected);
enum capnweb_status capnweb_value_copy_string(
    const struct capnweb_value *value,
    char *buffer,
    size_t capacity,
    size_t *length);
bool capnweb_value_get_remote_capability(
    const struct capnweb_value *value,
    struct capnweb_remote_capability *capability);

bool capnweb_call_path_equals(
    const struct capnweb_call *call,
    const char *const *segments,
    size_t segment_count);

enum capnweb_status capnweb_reply_set_null(struct capnweb_reply *reply);
enum capnweb_status capnweb_reply_set_boolean(
    struct capnweb_reply *reply, bool value);
enum capnweb_status capnweb_reply_set_int64(
    struct capnweb_reply *reply, int64_t value);
enum capnweb_status capnweb_reply_set_borrowed_expression(
    struct capnweb_reply *reply,
    const char *expression,
    size_t length,
    capnweb_release_fn release,
    void *context);

/** Transfers one capability owner to reply only when CAPNWEB_OK is returned. */
enum capnweb_status capnweb_reply_set_capability(
    struct capnweb_reply *reply, struct capnweb_capability capability);
enum capnweb_status capnweb_reply_set_bytes(
    struct capnweb_reply *reply,
    const uint8_t *data,
    size_t length,
    capnweb_release_fn release,
    void *context);
enum capnweb_status capnweb_reply_defer(struct capnweb_reply *reply);
enum capnweb_status capnweb_reply_set_error(
    struct capnweb_reply *reply, const char *type, const char *message);

enum capnweb_status capnweb_responder_set_null(
    struct capnweb_responder responder);
enum capnweb_status capnweb_responder_set_boolean(
    struct capnweb_responder responder, bool value);
enum capnweb_status capnweb_responder_set_int64(
    struct capnweb_responder responder, int64_t value);
enum capnweb_status capnweb_responder_set_borrowed_expression(
    struct capnweb_responder responder,
    const char *expression,
    size_t length,
    capnweb_release_fn release,
    void *context);

/** Transfers one capability owner to the session only on CAPNWEB_OK. */
enum capnweb_status capnweb_responder_set_capability(
    struct capnweb_responder responder,
    struct capnweb_capability capability);
enum capnweb_status capnweb_responder_set_bytes(
    struct capnweb_responder responder,
    const uint8_t *data,
    size_t length,
    capnweb_release_fn release,
    void *context);
enum capnweb_status capnweb_responder_set_error(
    struct capnweb_responder responder,
    const char *type,
    const char *message);

enum capnweb_status capnweb_session_call_path(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *const *path,
    size_t path_count,
    const char *arguments,
    size_t arguments_length,
    capnweb_completion_fn completion,
    void *context);
enum capnweb_status capnweb_session_call(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *method,
    const char *arguments,
    size_t arguments_length,
    capnweb_completion_fn completion,
    void *context);
enum capnweb_status capnweb_session_call_expressions(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *const *path,
    size_t path_count,
    const struct capnweb_expression *arguments,
    size_t argument_count,
    capnweb_completion_fn completion,
    void *context);

/**
 * Fire-and-forget call: pushes the pipeline expression and immediately
 * releases the result import instead of pulling it, so the peer never
 * serializes a resolution back. The import id is still allocated (ids are
 * implicit and strictly sequential on the wire) but its slot is freed before
 * this returns, so one-way calls do not consume import capacity.
 *
 * This is the only sustainable shape for high-frequency appends (e.g. 50/s
 * PCM frames): a pulled append would echo the committed events — payload
 * included — back into the bounded inbox and token budget on every call.
 * Errors the peer would have reported in the resolution are lost by design;
 * pair a low-rate pulled call on the same target as the health probe.
 */
enum capnweb_status capnweb_session_call_oneway_path(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *const *path,
    size_t path_count,
    const char *arguments,
    size_t arguments_length);

/**
 * Transfers one owner of capability to session on success. The returned handle
 * keeps a local hold until release_local_capability(); serializing it in a
 * typed expression creates a separate remote wire hold. Failure leaves
 * capability application-owned.
 */
enum capnweb_status capnweb_session_export_capability(
    struct capnweb_session *session,
    struct capnweb_capability capability,
    struct capnweb_local_capability *result);

/** Drops the one local hold represented by capability. */
enum capnweb_status capnweb_session_release_local_capability(
    struct capnweb_session *session,
    struct capnweb_local_capability capability);
enum capnweb_status capnweb_session_release_remote(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability);

#ifdef __cplusplus
}
#endif

#endif
