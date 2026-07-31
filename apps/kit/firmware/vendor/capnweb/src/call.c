// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include "json.h"
#include "session_internal.h"

#include <string.h>

static bool is_json_whitespace(char character) {
  return character == ' ' ||
      character == '\t' ||
      character == '\r' ||
      character == '\n';
}

static bool arguments_are_array(
    const char *arguments, size_t length) {
  size_t start = 0U;
  size_t end = length;
  if (capnweb_json_validate(arguments, length) != CAPNWEB_OK) {
    return false;
  }
  while (start < end && is_json_whitespace(arguments[start])) {
    ++start;
  }
  while (end > start && is_json_whitespace(arguments[end - 1U])) {
    --end;
  }
  return end - start >= 2U &&
      arguments[start] == '[' &&
      arguments[end - 1U] == ']';
}

static bool path_is_valid(
    const char *const *path, size_t path_count) {
  size_t index;
  if (path == NULL) {
    return path_count == 0U;
  }
  for (index = 0U; index < path_count; ++index) {
    if (path[index] == NULL) {
      return false;
    }
  }
  return true;
}

enum capnweb_status capnweb_session_call_encoded(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *const *path,
    size_t path_count,
    capnweb_completion_fn completion,
    void *completion_context,
    capnweb_prepare_arguments_fn prepare_arguments,
    capnweb_write_arguments_fn write_arguments,
    void *arguments_context) {
  struct capnweb_import *import_entry;
  struct capnweb_writer writer;
  char target_text[32];
  char import_text[32];
  size_t target_length;
  size_t import_length;
  size_t index;
  enum capnweb_status status;

  if (session == NULL ||
      capability.id > 0 ||
      completion == NULL ||
      write_arguments == NULL ||
      !path_is_valid(path, path_count) ||
      arguments_context == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (session->state != CAPNWEB_SESSION_OPEN) {
    return session->terminal_status;
  }
  if (session->sending) {
    return CAPNWEB_E_STATE;
  }
  if (!capnweb_format_id(
      capability.id, target_text, &target_length)) {
    return CAPNWEB_E_LIMIT;
  }
  import_entry = capnweb_session_allocate_import(
      session, completion, completion_context);
  if (import_entry == NULL) {
    return CAPNWEB_E_LIMIT;
  }
  if (!capnweb_format_id(
      import_entry->id, import_text, &import_length)) {
    memset(import_entry, 0, sizeof(*import_entry));
    return CAPNWEB_E_LIMIT;
  }
  if (prepare_arguments != NULL) {
    prepare_arguments(session, arguments_context);
  }

  status = capnweb_session_start_message(session, &writer);
  if (status != CAPNWEB_OK) {
    return status;
  }
  capnweb_writer_write_c_string(&writer, "[\"push\",[\"pipeline\",");
  capnweb_writer_write(&writer, target_text, target_length);
  capnweb_writer_write_c_string(&writer, ",[");
  for (index = 0U; index < path_count; ++index) {
    if (index > 0U) {
      capnweb_writer_write(&writer, ",", 1U);
    }
    capnweb_writer_write_quoted(&writer, path[index]);
  }
  capnweb_writer_write_c_string(&writer, "],");
  write_arguments(&writer, arguments_context);
  capnweb_writer_write_c_string(&writer, "]]");
  status = capnweb_session_finish_message(session, &writer);
  if (status != CAPNWEB_OK) {
    return status;
  }

  status = capnweb_session_start_message(session, &writer);
  if (status != CAPNWEB_OK) {
    return status;
  }
  capnweb_writer_write_c_string(&writer, "[\"pull\",");
  capnweb_writer_write(&writer, import_text, import_length);
  capnweb_writer_write(&writer, "]", 1U);
  return capnweb_session_finish_message(session, &writer);
}

struct raw_arguments {
  const char *data;
  size_t length;
};

static void write_raw_arguments(
    struct capnweb_writer *writer, void *context) {
  const struct raw_arguments *arguments = context;
  capnweb_writer_write(writer, arguments->data, arguments->length);
}

enum capnweb_status capnweb_session_call_path(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *const *path,
    size_t path_count,
    const char *arguments,
    size_t arguments_length,
    capnweb_completion_fn completion,
    void *context) {
  struct raw_arguments raw_arguments;
  if (arguments == NULL ||
      !arguments_are_array(arguments, arguments_length)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  raw_arguments = (struct raw_arguments){
    arguments,
    arguments_length,
  };
  return capnweb_session_call_encoded(
      session,
      capability,
      path,
      path_count,
      completion,
      context,
      NULL,
      write_raw_arguments,
      &raw_arguments);
}

enum capnweb_status capnweb_session_call(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *method,
    const char *arguments,
    size_t arguments_length,
    capnweb_completion_fn completion,
    void *context) {
  const char *path[1];
  if (method == NULL) {
    return capnweb_session_call_path(
        session,
        capability,
        NULL,
        0U,
        arguments,
        arguments_length,
        completion,
        context);
  }
  path[0] = method;
  return capnweb_session_call_path(
      session,
      capability,
      path,
      1U,
      arguments,
      arguments_length,
      completion,
      context);
}

static void oneway_completion_never_called(
    void *context, const struct capnweb_result *result) {
  (void)context;
  (void)result;
}

enum capnweb_status capnweb_session_call_oneway_path(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *const *path,
    size_t path_count,
    const char *arguments,
    size_t arguments_length) {
  struct capnweb_import *import_entry;
  struct capnweb_writer writer;
  char target_text[32];
  char import_text[32];
  size_t target_length;
  size_t import_length;
  size_t index;
  enum capnweb_status status;

  if (session == NULL ||
      capability.id > 0 ||
      arguments == NULL ||
      !arguments_are_array(arguments, arguments_length) ||
      !path_is_valid(path, path_count)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (session->state != CAPNWEB_SESSION_OPEN) {
    return session->terminal_status;
  }
  if (session->sending) {
    return CAPNWEB_E_STATE;
  }
  if (!capnweb_format_id(
      capability.id, target_text, &target_length)) {
    return CAPNWEB_E_LIMIT;
  }
  /*
   * The import is allocated only to advance the strictly sequential id
   * counter the peer mirrors; its slot is freed before this function
   * returns, whatever the outcome, because no resolution will ever arrive.
   */
  import_entry = capnweb_session_allocate_import(
      session, oneway_completion_never_called, NULL);
  if (import_entry == NULL) {
    return CAPNWEB_E_LIMIT;
  }
  if (!capnweb_format_id(
      import_entry->id, import_text, &import_length)) {
    memset(import_entry, 0, sizeof(*import_entry));
    return CAPNWEB_E_LIMIT;
  }

  status = capnweb_session_start_message(session, &writer);
  if (status != CAPNWEB_OK) {
    memset(import_entry, 0, sizeof(*import_entry));
    return status;
  }
  capnweb_writer_write_c_string(&writer, "[\"push\",[\"pipeline\",");
  capnweb_writer_write(&writer, target_text, target_length);
  capnweb_writer_write_c_string(&writer, ",[");
  for (index = 0U; index < path_count; ++index) {
    if (index > 0U) {
      capnweb_writer_write(&writer, ",", 1U);
    }
    capnweb_writer_write_quoted(&writer, path[index]);
  }
  capnweb_writer_write_c_string(&writer, "],");
  capnweb_writer_write(&writer, arguments, arguments_length);
  capnweb_writer_write_c_string(&writer, "]]");
  status = capnweb_session_finish_message(session, &writer);
  if (status != CAPNWEB_OK) {
    memset(import_entry, 0, sizeof(*import_entry));
    return status;
  }

  status = capnweb_session_send_release(session, import_entry->id);
  memset(import_entry, 0, sizeof(*import_entry));
  return status;
}

enum capnweb_status capnweb_session_release_remote(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability) {
  if (session == NULL || capability.id >= 0) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (session->state != CAPNWEB_SESSION_OPEN) {
    return session->terminal_status;
  }
  return capnweb_session_send_release(session, capability.id);
}
