// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include "json.h"
#include "session_internal.h"

#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

static void notify_imports(
    struct capnweb_session *session, enum capnweb_status status) {
  size_t index;
  for (index = 0U; index < session->options.import_count; ++index) {
    struct capnweb_import *import_entry = &session->options.imports[index];
    if (import_entry->occupied) {
      capnweb_completion_fn completion = import_entry->completion;
      void *context = import_entry->context;
      struct capnweb_result result = {
        CAPNWEB_RESULT_SESSION_ENDED,
        status,
        {NULL, NULL, 0U, CAPNWEB_NO_TOKEN},
      };
      memset(import_entry, 0, sizeof(*import_entry));
      completion(context, &result);
    }
  }
}

static void terminalize(
    struct capnweb_session *session,
    enum capnweb_session_state state,
    enum capnweb_status status) {
  if (session->state != CAPNWEB_SESSION_OPEN) {
    return;
  }
  session->state = state;
  session->terminal_status = status;
  notify_imports(session, status);
}

enum capnweb_status capnweb_session_start_message(
    struct capnweb_session *session, struct capnweb_writer *writer) {
  enum capnweb_status status;
  if (session->state != CAPNWEB_SESSION_OPEN) {
    return session->terminal_status;
  }
  if (session->sending) {
    return CAPNWEB_E_STATE;
  }
  session->sending = true;
  status = capnweb_writer_begin(
      writer,
      session->options.send_text,
      session->options.send_context,
      session->options.output_buffer,
      session->options.output_buffer_size);
  if (status != CAPNWEB_OK) {
    session->sending = false;
    terminalize(
        session,
        CAPNWEB_SESSION_TRANSPORT_FAILED,
        CAPNWEB_E_TRANSPORT);
    return CAPNWEB_E_TRANSPORT;
  }
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_session_finish_message(
    struct capnweb_session *session, struct capnweb_writer *writer) {
  enum capnweb_status status = capnweb_writer_finish(writer);
  session->sending = false;
  if (status != CAPNWEB_OK) {
    terminalize(
        session,
        CAPNWEB_SESSION_TRANSPORT_FAILED,
        CAPNWEB_E_TRANSPORT);
    return CAPNWEB_E_TRANSPORT;
  }
  return CAPNWEB_OK;
}

bool capnweb_format_id(
    int64_t id, char buffer[32], size_t *length) {
  int written = snprintf(buffer, 32U, "%" PRId64, id);
  if (written < 0 || written >= 32) {
    return false;
  }
  *length = (size_t)written;
  return true;
}

static enum capnweb_status send_abort_message(
    struct capnweb_session *session, const char *message) {
  struct capnweb_writer writer;
  enum capnweb_status status =
      capnweb_session_start_message(session, &writer);
  if (status != CAPNWEB_OK) {
    return status;
  }
  capnweb_writer_write_c_string(&writer, "[\"abort\",[\"error\",\"Error\",");
  capnweb_writer_write_quoted(&writer, message);
  capnweb_writer_write_c_string(&writer, "]]");
  return capnweb_session_finish_message(session, &writer);
}

static enum capnweb_status abort_with_status(
    struct capnweb_session *session,
    enum capnweb_status status,
    const char *message) {
  enum capnweb_status send_status = send_abort_message(session, message);
  if (send_status != CAPNWEB_OK) {
    return send_status;
  }
  terminalize(session, CAPNWEB_SESSION_LOCAL_ABORTED, status);
  return status;
}

static enum capnweb_status reject_bad_message(
    struct capnweb_session *session) {
  return abort_with_status(
      session, CAPNWEB_E_INVALID_MESSAGE, "CAPNWEB_E_INVALID_MESSAGE");
}

static void dispose_capability(
    const struct capnweb_capability *capability) {
  if (capability->dispose != NULL) {
    capability->dispose(capability->context);
  }
}

static void release_borrowed_reply(struct capnweb_reply *reply) {
  if ((reply->kind == CAPNWEB_REPLY_EXPRESSION ||
       reply->kind == CAPNWEB_REPLY_BYTES) &&
      reply->value.borrowed.data != NULL) {
    if (reply->value.borrowed.release != NULL) {
      reply->value.borrowed.release(reply->value.borrowed.context);
    }
    memset(&reply->value.borrowed, 0, sizeof(reply->value.borrowed));
  }
}

static void discard_unpublished_reply(struct capnweb_reply *reply) {
  if (reply->kind == CAPNWEB_REPLY_CAPABILITY) {
    dispose_capability(&reply->value.capability);
  }
  release_borrowed_reply(reply);
  memset(reply, 0, sizeof(*reply));
}

static bool reply_is_publishable(const struct capnweb_reply *reply) {
  switch (reply->kind) {
    case CAPNWEB_REPLY_NULL:
    case CAPNWEB_REPLY_BOOLEAN:
    case CAPNWEB_REPLY_INT64:
    case CAPNWEB_REPLY_DEFERRED:
      return true;
    case CAPNWEB_REPLY_EXPRESSION:
      return reply->value.borrowed.data != NULL &&
          reply->value.borrowed.length > 0U &&
          capnweb_json_validate(
              (const char *)reply->value.borrowed.data,
              reply->value.borrowed.length) == CAPNWEB_OK;
    case CAPNWEB_REPLY_ERROR:
      return reply->value.error.type != NULL &&
          reply->value.error.message != NULL;
    case CAPNWEB_REPLY_CAPABILITY:
      return reply->value.capability.dispatch != NULL;
    case CAPNWEB_REPLY_BYTES:
      return reply->value.borrowed.data != NULL ||
          reply->value.borrowed.length == 0U;
    case CAPNWEB_REPLY_UNSET:
    default:
      return false;
  }
}

struct capnweb_pending_call *capnweb_session_find_pending(
    struct capnweb_session *session, int64_t id) {
  size_t index;
  for (index = 0U; index < session->options.pending_call_count; ++index) {
    struct capnweb_pending_call *pending =
        &session->options.pending_calls[index];
    if (pending->occupied && pending->id == id) {
      return pending;
    }
  }
  return NULL;
}

static struct capnweb_pending_call *allocate_pending(
    struct capnweb_session *session) {
  size_t index;
  if (session->next_incoming_call_id <= 0 ||
      session->next_incoming_call_id == INT64_MAX) {
    return NULL;
  }
  for (index = 0U; index < session->options.pending_call_count; ++index) {
    struct capnweb_pending_call *pending =
        &session->options.pending_calls[index];
    if (!pending->occupied) {
      memset(pending, 0, sizeof(*pending));
      pending->occupied = true;
      pending->id = session->next_incoming_call_id++;
      pending->refcount = 1U;
      return pending;
    }
  }
  return NULL;
}

struct capnweb_export *capnweb_session_find_export(
    struct capnweb_session *session, int64_t id) {
  size_t index;
  for (index = 0U; index < session->options.export_count; ++index) {
    struct capnweb_export *export_entry = &session->options.exports[index];
    if (export_entry->occupied && export_entry->id == id) {
      return export_entry;
    }
  }
  return NULL;
}

static struct capnweb_export *export_capability(
    struct capnweb_session *session,
    const struct capnweb_capability *capability,
    size_t local_refcount,
    size_t refcount) {
  size_t index;
  if (session->next_outgoing_export_id >= 0 ||
      session->next_outgoing_export_id == INT64_MIN) {
    return NULL;
  }
  for (index = 0U; index < session->options.export_count; ++index) {
    struct capnweb_export *export_entry = &session->options.exports[index];
    if (!export_entry->occupied) {
      memset(export_entry, 0, sizeof(*export_entry));
      export_entry->occupied = true;
      export_entry->id = session->next_outgoing_export_id--;
      export_entry->local_refcount = local_refcount;
      export_entry->refcount = refcount;
      export_entry->capability = *capability;
      return export_entry;
    }
  }
  return NULL;
}

static void dispose_export_if_unreferenced(
    struct capnweb_export *export_entry) {
  if (export_entry->refcount == 0U &&
      export_entry->local_refcount == 0U) {
    dispose_capability(&export_entry->capability);
    memset(export_entry, 0, sizeof(*export_entry));
  }
}

static void release_pending(
    struct capnweb_session *session,
    struct capnweb_pending_call *pending) {
  if (pending->reply.kind == CAPNWEB_REPLY_CAPABILITY) {
    struct capnweb_export *export_entry =
        capnweb_session_find_export(
            session, pending->capability_export_id);
    if (export_entry != NULL) {
      if (export_entry->local_refcount > 0U) {
        --export_entry->local_refcount;
      }
      dispose_export_if_unreferenced(export_entry);
    } else {
      dispose_capability(&pending->reply.value.capability);
    }
  }
  release_borrowed_reply(&pending->reply);
  memset(pending, 0, sizeof(*pending));
}

enum capnweb_status capnweb_session_adopt_reply(
    struct capnweb_session *session,
    struct capnweb_pending_call *pending) {
  struct capnweb_export *export_entry;
  if (session == NULL || pending == NULL || !pending->occupied) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (!reply_is_publishable(&pending->reply)) {
    discard_unpublished_reply(&pending->reply);
    return capnweb_reply_set_error(
        &pending->reply, "Error", "CAPNWEB_E_DISPATCH");
  }
  if (pending->reply.kind != CAPNWEB_REPLY_CAPABILITY) {
    return CAPNWEB_OK;
  }
  if (pending->capability_export_id != 0) {
    return CAPNWEB_E_STATE;
  }
  export_entry = export_capability(
      session, &pending->reply.value.capability, 1U, 0U);
  if (export_entry == NULL) {
    return abort_with_status(
        session, CAPNWEB_E_LIMIT, "CAPNWEB_E_EXPORT_LIMIT");
  }
  pending->capability_export_id = export_entry->id;
  memset(
      &pending->reply.value.capability,
      0,
      sizeof(pending->reply.value.capability));
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_session_export_capability(
    struct capnweb_session *session,
    struct capnweb_capability capability,
    struct capnweb_local_capability *result) {
  struct capnweb_export *export_entry;
  if (session == NULL ||
      capability.dispatch == NULL ||
      result == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (session->state != CAPNWEB_SESSION_OPEN) {
    return session->terminal_status;
  }
  if (session->sending) {
    return CAPNWEB_E_STATE;
  }
  export_entry = export_capability(
      session, &capability, 1U, 0U);
  if (export_entry == NULL) {
    return CAPNWEB_E_LIMIT;
  }
  *result = (struct capnweb_local_capability){
    session,
    export_entry->id,
  };
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_session_release_local_capability(
    struct capnweb_session *session,
    struct capnweb_local_capability capability) {
  struct capnweb_export *export_entry;
  if (session == NULL ||
      capability.session != session ||
      capability.id >= 0) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  export_entry = capnweb_session_find_export(session, capability.id);
  if (export_entry == NULL || export_entry->local_refcount == 0U) {
    return CAPNWEB_E_STATE;
  }
  --export_entry->local_refcount;
  dispose_export_if_unreferenced(export_entry);
  return CAPNWEB_OK;
}

static struct capnweb_import *find_import(
    struct capnweb_session *session, int64_t id) {
  size_t index;
  for (index = 0U; index < session->options.import_count; ++index) {
    struct capnweb_import *import_entry = &session->options.imports[index];
    if (import_entry->occupied && import_entry->id == id) {
      return import_entry;
    }
  }
  return NULL;
}

struct capnweb_import *capnweb_session_allocate_import(
    struct capnweb_session *session,
    capnweb_completion_fn completion,
    void *context) {
  size_t index;
  if (session->next_outgoing_call_id <= 0 ||
      session->next_outgoing_call_id == INT64_MAX) {
    return NULL;
  }
  for (index = 0U; index < session->options.import_count; ++index) {
    struct capnweb_import *import_entry = &session->options.imports[index];
    if (!import_entry->occupied) {
      memset(import_entry, 0, sizeof(*import_entry));
      import_entry->occupied = true;
      import_entry->id = session->next_outgoing_call_id++;
      import_entry->completion = completion;
      import_entry->context = context;
      return import_entry;
    }
  }
  return NULL;
}

static struct capnweb_value make_value(
    const struct capnweb_json_document *document, size_t token) {
  return (struct capnweb_value){
    document->json,
    document->tokens,
    document->count,
    token,
  };
}

static bool path_is_supported(
    const struct capnweb_value *path) {
  size_t index;
  if (capnweb_value_get_type(path) != CAPNWEB_JSON_ARRAY) {
    return false;
  }
  for (index = 0U; index < capnweb_value_array_size(path); ++index) {
    struct capnweb_value segment;
    enum capnweb_json_type type;
    if (!capnweb_value_array_at(path, index, &segment)) {
      return false;
    }
    type = capnweb_value_get_type(&segment);
    if (type != CAPNWEB_JSON_STRING && type != CAPNWEB_JSON_NUMBER) {
      return false;
    }
  }
  return true;
}

static bool reference_expression_is_well_formed(
    const struct capnweb_value *expression) {
  struct capnweb_value id;
  struct capnweb_value path;
  struct capnweb_value arguments;
  int64_t unused_id;
  size_t expression_size = capnweb_value_array_size(expression);

  if (expression_size < 2U || expression_size > 4U ||
      !capnweb_value_array_at(expression, 1U, &id) ||
      !capnweb_value_get_int64(&id, &unused_id)) {
    return false;
  }
  if (expression_size >= 3U &&
      (!capnweb_value_array_at(expression, 2U, &path) ||
       !path_is_supported(&path))) {
    return false;
  }
  return expression_size < 4U ||
      (capnweb_value_array_at(expression, 3U, &arguments) &&
       capnweb_value_get_type(&arguments) == CAPNWEB_JSON_ARRAY);
}

static enum capnweb_status handle_push(
    struct capnweb_session *session,
    const struct capnweb_value *message) {
  struct capnweb_value expression;
  struct capnweb_value expression_type;
  struct capnweb_value target;
  struct capnweb_value path;
  struct capnweb_value arguments = {0};
  size_t expression_size;
  bool has_arguments;
  int64_t target_id;
  struct capnweb_pending_call *pending;
  struct capnweb_pending_call *target_pending = NULL;
  struct capnweb_export *target_export = NULL;
  struct capnweb_capability capability = {0};
  struct capnweb_call call;
  enum capnweb_status dispatch_status;

  if (!capnweb_value_array_at(message, 1U, &expression) ||
      capnweb_value_get_type(&expression) != CAPNWEB_JSON_ARRAY) {
    return reject_bad_message(session);
  }
  expression_size = capnweb_value_array_size(&expression);
  if (!capnweb_value_array_at(&expression, 0U, &expression_type)) {
    return reject_bad_message(session);
  }
  if (capnweb_value_string_equals(&expression_type, "import")) {
    if (!reference_expression_is_well_formed(&expression)) {
      return reject_bad_message(session);
    }
    return abort_with_status(
        session, CAPNWEB_E_UNSUPPORTED, "CAPNWEB_E_UNSUPPORTED_IMPORT");
  }
  if ((expression_size != 3U && expression_size != 4U) ||
      !capnweb_value_string_equals(&expression_type, "pipeline") ||
      !capnweb_value_array_at(&expression, 1U, &target) ||
      !capnweb_value_array_at(&expression, 2U, &path)) {
    return reject_bad_message(session);
  }
  has_arguments = expression_size == 4U;
  if ((has_arguments &&
       !capnweb_value_array_at(&expression, 3U, &arguments)) ||
      !capnweb_value_get_int64(&target, &target_id) ||
      !path_is_supported(&path) ||
      (has_arguments &&
       capnweb_value_get_type(&arguments) != CAPNWEB_JSON_ARRAY)) {
    return reject_bad_message(session);
  }

  if (target_id == 0) {
    capability = session->options.main_capability;
  } else if (target_id > 0) {
    target_pending = capnweb_session_find_pending(session, target_id);
    if (target_pending == NULL) {
      return reject_bad_message(session);
    }
  } else {
    target_export = capnweb_session_find_export(session, target_id);
    if (target_export == NULL) {
      return reject_bad_message(session);
    }
  }

  pending = allocate_pending(session);
  if (pending == NULL) {
    return abort_with_status(
        session, CAPNWEB_E_LIMIT, "CAPNWEB_E_PENDING_CALL_LIMIT");
  }
  if (target_pending != NULL &&
      target_pending->reply.kind == CAPNWEB_REPLY_ERROR) {
    (void)capnweb_reply_set_error(
        &pending->reply,
        target_pending->reply.value.error.type,
        target_pending->reply.value.error.message);
    return CAPNWEB_OK;
  }
  if (target_pending != NULL &&
      target_pending->reply.kind != CAPNWEB_REPLY_CAPABILITY) {
    (void)capnweb_reply_set_error(
        &pending->reply, "Error", "CAPNWEB_E_UNSUPPORTED_PIPELINE");
    return CAPNWEB_OK;
  }
  if (target_pending != NULL) {
    target_export = capnweb_session_find_export(
        session, target_pending->capability_export_id);
    if (target_export == NULL) {
      return abort_with_status(
          session, CAPNWEB_E_STATE, "CAPNWEB_E_EXPORT_STATE");
    }
    capability = target_export->capability;
  } else if (target_export != NULL) {
    capability = target_export->capability;
  }
  call = (struct capnweb_call){
    path,
    arguments,
    has_arguments,
    {session, pending->id},
  };
  if (capability.dispatch == NULL) {
    return abort_with_status(
        session, CAPNWEB_E_STATE, "CAPNWEB_E_CAPABILITY_STATE");
  }
  dispatch_status = capability.dispatch(
      capability.context, &call, &pending->reply);
  if (session->state != CAPNWEB_SESSION_OPEN) {
    discard_unpublished_reply(&pending->reply);
    return session->terminal_status;
  }
  if (dispatch_status != CAPNWEB_OK ||
      pending->reply.kind == CAPNWEB_REPLY_UNSET) {
    discard_unpublished_reply(&pending->reply);
    (void)capnweb_reply_set_error(
        &pending->reply, "Error", "CAPNWEB_E_DISPATCH");
  }
  dispatch_status = capnweb_session_adopt_reply(session, pending);
  if (dispatch_status != CAPNWEB_OK) {
    return dispatch_status;
  }
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_session_send_pending_resolution(
    struct capnweb_session *session,
    struct capnweb_pending_call *pending) {
  struct capnweb_writer writer;
  struct capnweb_export *export_entry = NULL;
  char id_text[32];
  char export_text[32];
  size_t id_length;
  size_t export_length = 0U;
  bool releases_borrowed;
  enum capnweb_status status;

  if (!pending->pulled || pending->resolution_sent) {
    return CAPNWEB_E_STATE;
  }
  if (pending->reply.kind == CAPNWEB_REPLY_DEFERRED) {
    return CAPNWEB_OK;
  }
  if (!capnweb_format_id(pending->id, id_text, &id_length)) {
    return CAPNWEB_E_LIMIT;
  }
  if (pending->reply.kind == CAPNWEB_REPLY_CAPABILITY) {
    export_entry = capnweb_session_find_export(
        session, pending->capability_export_id);
    if (export_entry == NULL) {
      return abort_with_status(
          session, CAPNWEB_E_STATE, "CAPNWEB_E_EXPORT_STATE");
    }
    if (export_entry->refcount == SIZE_MAX) {
      return abort_with_status(
          session, CAPNWEB_E_LIMIT, "CAPNWEB_E_EXPORT_REFCOUNT_LIMIT");
    }
    if (!capnweb_format_id(
        pending->capability_export_id, export_text, &export_length)) {
      return CAPNWEB_E_LIMIT;
    }
    ++export_entry->refcount;
  }

  releases_borrowed =
      pending->reply.kind == CAPNWEB_REPLY_EXPRESSION ||
      pending->reply.kind == CAPNWEB_REPLY_BYTES;
  pending->resolution_sent = true;
  status = capnweb_session_start_message(session, &writer);
  if (status != CAPNWEB_OK) {
    if (releases_borrowed) {
      release_borrowed_reply(&pending->reply);
    }
    return status;
  }
  capnweb_writer_write_c_string(
      &writer,
      pending->reply.kind == CAPNWEB_REPLY_ERROR
          ? "[\"reject\","
          : "[\"resolve\",");
  capnweb_writer_write(&writer, id_text, id_length);
  capnweb_writer_write(&writer, ",", 1U);

  switch (pending->reply.kind) {
    case CAPNWEB_REPLY_NULL:
      capnweb_writer_write_c_string(&writer, "null");
      break;
    case CAPNWEB_REPLY_BOOLEAN:
      capnweb_writer_write_c_string(
          &writer, pending->reply.value.boolean ? "true" : "false");
      break;
    case CAPNWEB_REPLY_INT64: {
      char integer_text[32];
      size_t integer_length;
      if (!capnweb_format_id(
          pending->reply.value.integer, integer_text, &integer_length)) {
        session->sending = false;
        terminalize(
            session,
            CAPNWEB_SESSION_TRANSPORT_FAILED,
            CAPNWEB_E_TRANSPORT);
        return CAPNWEB_E_TRANSPORT;
      }
      capnweb_writer_write(&writer, integer_text, integer_length);
      break;
    }
    case CAPNWEB_REPLY_EXPRESSION:
      capnweb_writer_write(
          &writer,
          (const char *)pending->reply.value.borrowed.data,
          pending->reply.value.borrowed.length);
      break;
    case CAPNWEB_REPLY_ERROR:
      capnweb_writer_write_c_string(&writer, "[\"error\",");
      capnweb_writer_write_quoted(&writer, pending->reply.value.error.type);
      capnweb_writer_write(&writer, ",", 1U);
      capnweb_writer_write_quoted(&writer, pending->reply.value.error.message);
      capnweb_writer_write(&writer, "]", 1U);
      break;
    case CAPNWEB_REPLY_CAPABILITY:
      capnweb_writer_write_c_string(&writer, "[\"export\",");
      capnweb_writer_write(&writer, export_text, export_length);
      capnweb_writer_write(&writer, "]", 1U);
      break;
    case CAPNWEB_REPLY_BYTES:
      capnweb_writer_write_c_string(&writer, "[\"bytes\",\"");
      capnweb_writer_write_base64(
          &writer,
          (const uint8_t *)pending->reply.value.borrowed.data,
          pending->reply.value.borrowed.length);
      capnweb_writer_write_c_string(&writer, "\"]");
      break;
    case CAPNWEB_REPLY_UNSET:
    case CAPNWEB_REPLY_DEFERRED:
    default:
      session->sending = false;
      terminalize(
          session,
          CAPNWEB_SESSION_TRANSPORT_FAILED,
          CAPNWEB_E_TRANSPORT);
      return CAPNWEB_E_TRANSPORT;
  }
  capnweb_writer_write(&writer, "]", 1U);
  status = capnweb_session_finish_message(session, &writer);
  if (releases_borrowed) {
    release_borrowed_reply(&pending->reply);
  }
  return status;
}

static enum capnweb_status handle_pull(
    struct capnweb_session *session,
    const struct capnweb_value *message) {
  struct capnweb_value id_value;
  int64_t id;
  struct capnweb_pending_call *pending;
  if (!capnweb_value_array_at(message, 1U, &id_value) ||
      !capnweb_value_get_int64(&id_value, &id)) {
    return reject_bad_message(session);
  }
  pending = capnweb_session_find_pending(session, id);
  if (pending == NULL || pending->pulled) {
    return reject_bad_message(session);
  }
  pending->pulled = true;
  return capnweb_session_send_pending_resolution(session, pending);
}

enum capnweb_status capnweb_session_send_release(
    struct capnweb_session *session, int64_t id) {
  struct capnweb_writer writer;
  char id_text[32];
  size_t id_length;
  enum capnweb_status status;
  if (!capnweb_format_id(id, id_text, &id_length)) {
    return CAPNWEB_E_LIMIT;
  }
  status = capnweb_session_start_message(session, &writer);
  if (status != CAPNWEB_OK) {
    return status;
  }
  capnweb_writer_write_c_string(&writer, "[\"release\",");
  capnweb_writer_write(&writer, id_text, id_length);
  capnweb_writer_write_c_string(&writer, ",1]");
  return capnweb_session_finish_message(session, &writer);
}

static enum capnweb_status handle_resolution(
    struct capnweb_session *session,
    const struct capnweb_value *message,
    enum capnweb_result_kind kind) {
  struct capnweb_value id_value;
  struct capnweb_value value;
  int64_t id;
  struct capnweb_import *import_entry;
  struct capnweb_result result;
  capnweb_completion_fn completion;
  void *context;
  enum capnweb_status release_status;

  if (!capnweb_value_array_at(message, 1U, &id_value) ||
      !capnweb_value_get_int64(&id_value, &id) ||
      !capnweb_value_array_at(message, 2U, &value)) {
    return reject_bad_message(session);
  }
  import_entry = find_import(session, id);
  if (import_entry == NULL) {
    return reject_bad_message(session);
  }
  result = (struct capnweb_result){
    kind,
    CAPNWEB_OK,
    value,
  };
  completion = import_entry->completion;
  context = import_entry->context;
  memset(import_entry, 0, sizeof(*import_entry));

  release_status = capnweb_session_send_release(session, id);
  completion(context, &result);
  return release_status;
}

static enum capnweb_status handle_release(
    struct capnweb_session *session,
    const struct capnweb_value *message) {
  struct capnweb_value id_value;
  struct capnweb_value count_value;
  int64_t id;
  int64_t count;
  struct capnweb_pending_call *pending;
  struct capnweb_export *export_entry;

  if (!capnweb_value_array_at(message, 1U, &id_value) ||
      !capnweb_value_array_at(message, 2U, &count_value) ||
      !capnweb_value_get_int64(&id_value, &id) ||
      !capnweb_value_get_int64(&count_value, &count) ||
      count <= 0) {
    return reject_bad_message(session);
  }
  if (id > 0) {
    pending = capnweb_session_find_pending(session, id);
    if (pending == NULL || (uint64_t)count > pending->refcount) {
      return reject_bad_message(session);
    }
    pending->refcount -= (size_t)count;
    if (pending->refcount == 0U) {
      release_pending(session, pending);
    }
    return CAPNWEB_OK;
  }
  if (id < 0) {
    export_entry = capnweb_session_find_export(session, id);
    if (export_entry == NULL || (uint64_t)count > export_entry->refcount) {
      return reject_bad_message(session);
    }
    export_entry->refcount -= (size_t)count;
    dispose_export_if_unreferenced(export_entry);
    return CAPNWEB_OK;
  }
  return reject_bad_message(session);
}

static enum capnweb_status process_message(
    struct capnweb_session *session, const char *message, size_t length) {
  struct capnweb_json_document document;
  struct capnweb_value root;
  struct capnweb_value command;
  enum capnweb_status status;

  while (length > 0U &&
         (message[length - 1U] == '\n' || message[length - 1U] == '\r')) {
    --length;
  }
  document = (struct capnweb_json_document){
    message,
    length,
    session->options.tokens,
    session->options.token_count,
    0U,
  };
  status = capnweb_json_parse(&document);
  if (status == CAPNWEB_E_LIMIT) {
    return abort_with_status(
        session, CAPNWEB_E_LIMIT, "CAPNWEB_E_TOKEN_LIMIT");
  }
  if (status != CAPNWEB_OK ||
      document.count == 0U ||
      document.tokens[0].type != CAPNWEB_JSON_ARRAY ||
      document.tokens[0].count == 0U) {
    return reject_bad_message(session);
  }

  root = make_value(&document, 0U);
  if (!capnweb_value_array_at(&root, 0U, &command)) {
    return reject_bad_message(session);
  }
  if (capnweb_value_string_equals(&command, "push") &&
      capnweb_value_array_size(&root) == 2U) {
    return handle_push(session, &root);
  }
  if (capnweb_value_string_equals(&command, "pull") &&
      capnweb_value_array_size(&root) == 2U) {
    return handle_pull(session, &root);
  }
  if (capnweb_value_string_equals(&command, "release") &&
      capnweb_value_array_size(&root) == 3U) {
    return handle_release(session, &root);
  }
  if (capnweb_value_string_equals(&command, "resolve") &&
      capnweb_value_array_size(&root) == 3U) {
    return handle_resolution(
        session, &root, CAPNWEB_RESULT_VALUE);
  }
  if (capnweb_value_string_equals(&command, "reject") &&
      capnweb_value_array_size(&root) == 3U) {
    return handle_resolution(
        session, &root, CAPNWEB_RESULT_REJECTION);
  }
  if (capnweb_value_string_equals(&command, "stream") &&
      capnweb_value_array_size(&root) == 2U) {
    return abort_with_status(
        session, CAPNWEB_E_UNSUPPORTED, "CAPNWEB_E_UNSUPPORTED_STREAM");
  }
  if (capnweb_value_string_equals(&command, "pipe")) {
    return abort_with_status(
        session, CAPNWEB_E_UNSUPPORTED, "CAPNWEB_E_UNSUPPORTED_PIPE");
  }
  if (capnweb_value_string_equals(&command, "abort") &&
      capnweb_value_array_size(&root) == 2U) {
    terminalize(
        session,
        CAPNWEB_SESSION_REMOTE_ABORTED,
        CAPNWEB_E_REMOTE_ABORT);
    return CAPNWEB_E_REMOTE_ABORT;
  }
  return reject_bad_message(session);
}

static bool table_is_valid(
    const void *table, size_t count, size_t element_size) {
  if (count == 0U) {
    return table == NULL;
  }
  return table != NULL && count <= SIZE_MAX / element_size;
}

static bool scratch_is_valid(
    const void *scratch, size_t count, size_t element_size) {
  return count > 0U &&
      scratch != NULL &&
      count <= SIZE_MAX / element_size;
}

enum capnweb_status capnweb_session_init(
    struct capnweb_session *session,
    const struct capnweb_session_options *options) {
  if (session == NULL ||
      options == NULL ||
      options->main_capability.dispatch == NULL ||
      options->send_text == NULL ||
      !table_is_valid(
          options->pending_calls,
          options->pending_call_count,
          sizeof(*options->pending_calls)) ||
      !table_is_valid(
          options->exports,
          options->export_count,
          sizeof(*options->exports)) ||
      !table_is_valid(
          options->imports,
          options->import_count,
          sizeof(*options->imports)) ||
      !scratch_is_valid(
          options->tokens,
          options->token_count,
          sizeof(*options->tokens)) ||
      options->output_buffer == NULL ||
      options->output_buffer_size == 0U) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }

  memset(session, 0, sizeof(*session));
  session->options = *options;
  session->next_incoming_call_id = 1;
  session->next_outgoing_export_id = -1;
  session->next_outgoing_call_id = 1;
  session->state = CAPNWEB_SESSION_OPEN;
  session->terminal_status = CAPNWEB_OK;
  if (options->pending_call_count > 0U) {
    memset(
        options->pending_calls,
        0,
        options->pending_call_count * sizeof(*options->pending_calls));
  }
  if (options->export_count > 0U) {
    memset(
        options->exports,
        0,
        options->export_count * sizeof(*options->exports));
  }
  if (options->import_count > 0U) {
    memset(
        options->imports,
        0,
        options->import_count * sizeof(*options->imports));
  }
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_session_receive(
    struct capnweb_session *session, const char *message, size_t length) {
  enum capnweb_status status;
  if (session == NULL || message == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (session->state != CAPNWEB_SESSION_OPEN) {
    return session->terminal_status;
  }
  if (session->receiving || session->sending) {
    return CAPNWEB_E_STATE;
  }
  session->receiving = true;
  status = process_message(session, message, length);
  session->receiving = false;
  return status;
}

void capnweb_session_close(struct capnweb_session *session) {
  size_t index;
  if (session == NULL || session->state == CAPNWEB_SESSION_CLOSED) {
    return;
  }
  if (session->state == CAPNWEB_SESSION_OPEN) {
    terminalize(
        session, CAPNWEB_SESSION_CLOSED, CAPNWEB_E_CLOSED);
  } else {
    session->state = CAPNWEB_SESSION_CLOSED;
  }
  for (index = 0U;
       index < session->options.pending_call_count;
       ++index) {
    struct capnweb_pending_call *pending =
        &session->options.pending_calls[index];
    if (pending->occupied) {
      release_pending(session, pending);
    }
  }
  for (index = 0U; index < session->options.export_count; ++index) {
    struct capnweb_export *export_entry = &session->options.exports[index];
    if (export_entry->occupied) {
      dispose_capability(&export_entry->capability);
      memset(export_entry, 0, sizeof(*export_entry));
    }
  }
}

enum capnweb_session_state capnweb_session_get_state(
    const struct capnweb_session *session) {
  return session == NULL ? CAPNWEB_SESSION_CLOSED : session->state;
}

enum capnweb_status capnweb_session_get_terminal_status(
    const struct capnweb_session *session) {
  return session == NULL ? CAPNWEB_E_INVALID_ARGUMENT :
      session->terminal_status;
}
