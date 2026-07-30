// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include "session_internal.h"

#include <string.h>

enum {
  CAPNWEB_EXPRESSION_MAX_DEPTH = 16,
};

struct expression_arguments {
  const struct capnweb_expression *values;
  size_t count;
  size_t capability_count;
};

static bool span_is_valid(const struct capnweb_string *span) {
  return span->data != NULL || span->length == 0U;
}

static enum capnweb_status validate_expression(
    struct capnweb_session *session,
    const struct capnweb_expression *expression,
    size_t depth,
    size_t *capability_count) {
  size_t index;

  if (expression == NULL || capability_count == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (depth > CAPNWEB_EXPRESSION_MAX_DEPTH) {
    return CAPNWEB_E_LIMIT;
  }

  switch (expression->kind) {
    case CAPNWEB_EXPRESSION_NULL:
    case CAPNWEB_EXPRESSION_BOOLEAN:
    case CAPNWEB_EXPRESSION_INT64:
      return CAPNWEB_OK;
    case CAPNWEB_EXPRESSION_STRING:
      return span_is_valid(&expression->value.string)
          ? CAPNWEB_OK
          : CAPNWEB_E_INVALID_ARGUMENT;
    case CAPNWEB_EXPRESSION_ARRAY:
      if ((expression->value.array.values == NULL &&
           expression->value.array.count > 0U) ||
          expression->value.array.count >
              SIZE_MAX / sizeof(*expression->value.array.values)) {
        return CAPNWEB_E_INVALID_ARGUMENT;
      }
      for (index = 0U;
           index < expression->value.array.count;
           ++index) {
        enum capnweb_status status = validate_expression(
            session,
            &expression->value.array.values[index],
            depth + 1U,
            capability_count);
        if (status != CAPNWEB_OK) {
          return status;
        }
      }
      return CAPNWEB_OK;
    case CAPNWEB_EXPRESSION_OBJECT:
      if ((expression->value.object.fields == NULL &&
           expression->value.object.count > 0U) ||
          expression->value.object.count >
              SIZE_MAX / sizeof(*expression->value.object.fields)) {
        return CAPNWEB_E_INVALID_ARGUMENT;
      }
      for (index = 0U;
           index < expression->value.object.count;
           ++index) {
        const struct capnweb_object_field *field =
            &expression->value.object.fields[index];
        enum capnweb_status status;
        if (!span_is_valid(&field->key) || field->value == NULL) {
          return CAPNWEB_E_INVALID_ARGUMENT;
        }
        status = validate_expression(
            session,
            field->value,
            depth + 1U,
            capability_count);
        if (status != CAPNWEB_OK) {
          return status;
        }
      }
      return CAPNWEB_OK;
    case CAPNWEB_EXPRESSION_CAPABILITY: {
      const struct capnweb_local_capability *capability =
          &expression->value.capability;
      struct capnweb_export *export_entry;
      if (capability->session != session || capability->id >= 0) {
        return CAPNWEB_E_INVALID_ARGUMENT;
      }
      export_entry = capnweb_session_find_export(
          session, capability->id);
      if (export_entry == NULL || export_entry->local_refcount == 0U) {
        return CAPNWEB_E_STATE;
      }
      if (*capability_count == SIZE_MAX) {
        return CAPNWEB_E_LIMIT;
      }
      ++*capability_count;
      return CAPNWEB_OK;
    }
    default:
      return CAPNWEB_E_INVALID_ARGUMENT;
  }
}

static enum capnweb_status validate_refcounts(
    struct capnweb_session *session,
    const struct capnweb_expression *expression,
    size_t capability_count) {
  size_t index;

  switch (expression->kind) {
    case CAPNWEB_EXPRESSION_ARRAY:
      for (index = 0U;
           index < expression->value.array.count;
           ++index) {
        enum capnweb_status status = validate_refcounts(
            session,
            &expression->value.array.values[index],
            capability_count);
        if (status != CAPNWEB_OK) {
          return status;
        }
      }
      return CAPNWEB_OK;
    case CAPNWEB_EXPRESSION_OBJECT:
      for (index = 0U;
           index < expression->value.object.count;
           ++index) {
        enum capnweb_status status = validate_refcounts(
            session,
            expression->value.object.fields[index].value,
            capability_count);
        if (status != CAPNWEB_OK) {
          return status;
        }
      }
      return CAPNWEB_OK;
    case CAPNWEB_EXPRESSION_CAPABILITY: {
      struct capnweb_export *export_entry =
          capnweb_session_find_export(
              session, expression->value.capability.id);
      return export_entry != NULL &&
          export_entry->refcount <= SIZE_MAX - capability_count
          ? CAPNWEB_OK
          : CAPNWEB_E_LIMIT;
    }
    default:
      return CAPNWEB_OK;
  }
}

static void reserve_expression_capabilities(
    struct capnweb_session *session,
    const struct capnweb_expression *expression) {
  size_t index;

  switch (expression->kind) {
    case CAPNWEB_EXPRESSION_ARRAY:
      for (index = 0U;
           index < expression->value.array.count;
           ++index) {
        reserve_expression_capabilities(
            session, &expression->value.array.values[index]);
      }
      break;
    case CAPNWEB_EXPRESSION_OBJECT:
      for (index = 0U;
           index < expression->value.object.count;
           ++index) {
        reserve_expression_capabilities(
            session, expression->value.object.fields[index].value);
      }
      break;
    case CAPNWEB_EXPRESSION_CAPABILITY: {
      struct capnweb_export *export_entry =
          capnweb_session_find_export(
              session, expression->value.capability.id);
      ++export_entry->refcount;
      break;
    }
    default:
      break;
  }
}

static void write_expression(
    struct capnweb_writer *writer,
    const struct capnweb_expression *expression) {
  char integer[32];
  size_t integer_length;
  size_t index;

  switch (expression->kind) {
    case CAPNWEB_EXPRESSION_NULL:
      capnweb_writer_write_c_string(writer, "null");
      break;
    case CAPNWEB_EXPRESSION_BOOLEAN:
      capnweb_writer_write_c_string(
          writer, expression->value.boolean ? "true" : "false");
      break;
    case CAPNWEB_EXPRESSION_INT64:
      (void)capnweb_format_id(
          expression->value.integer, integer, &integer_length);
      capnweb_writer_write(writer, integer, integer_length);
      break;
    case CAPNWEB_EXPRESSION_STRING:
      capnweb_writer_write_quoted_span(
          writer,
          expression->value.string.data,
          expression->value.string.length);
      break;
    case CAPNWEB_EXPRESSION_ARRAY:
      capnweb_writer_write_c_string(writer, "[[");
      for (index = 0U;
           index < expression->value.array.count;
           ++index) {
        if (index > 0U) {
          capnweb_writer_write(writer, ",", 1U);
        }
        write_expression(
            writer, &expression->value.array.values[index]);
      }
      capnweb_writer_write_c_string(writer, "]]");
      break;
    case CAPNWEB_EXPRESSION_OBJECT:
      capnweb_writer_write(writer, "{", 1U);
      for (index = 0U;
           index < expression->value.object.count;
           ++index) {
        const struct capnweb_object_field *field =
            &expression->value.object.fields[index];
        if (index > 0U) {
          capnweb_writer_write(writer, ",", 1U);
        }
        capnweb_writer_write_quoted_span(
            writer, field->key.data, field->key.length);
        capnweb_writer_write(writer, ":", 1U);
        write_expression(writer, field->value);
      }
      capnweb_writer_write(writer, "}", 1U);
      break;
    case CAPNWEB_EXPRESSION_CAPABILITY:
      (void)capnweb_format_id(
          expression->value.capability.id,
          integer,
          &integer_length);
      capnweb_writer_write_c_string(writer, "[\"export\",");
      capnweb_writer_write(writer, integer, integer_length);
      capnweb_writer_write(writer, "]", 1U);
      break;
    default:
      break;
  }
}

static void reserve_argument_capabilities(
    struct capnweb_session *session, void *context) {
  const struct expression_arguments *arguments = context;
  size_t index;
  for (index = 0U; index < arguments->count; ++index) {
    reserve_expression_capabilities(session, &arguments->values[index]);
  }
}

static void write_expression_arguments(
    struct capnweb_writer *writer, void *context) {
  const struct expression_arguments *arguments = context;
  size_t index;
  capnweb_writer_write(writer, "[", 1U);
  for (index = 0U; index < arguments->count; ++index) {
    if (index > 0U) {
      capnweb_writer_write(writer, ",", 1U);
    }
    write_expression(writer, &arguments->values[index]);
  }
  capnweb_writer_write(writer, "]", 1U);
}

enum capnweb_status capnweb_session_call_expressions(
    struct capnweb_session *session,
    struct capnweb_remote_capability capability,
    const char *const *path,
    size_t path_count,
    const struct capnweb_expression *arguments,
    size_t argument_count,
    capnweb_completion_fn completion,
    void *context) {
  struct expression_arguments expression_arguments;
  size_t capability_count = 0U;
  size_t index;

  if (session == NULL ||
      (arguments == NULL && argument_count > 0U) ||
      argument_count > SIZE_MAX / sizeof(*arguments)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (session->state != CAPNWEB_SESSION_OPEN) {
    return session->terminal_status;
  }
  if (session->sending) {
    return CAPNWEB_E_STATE;
  }
  for (index = 0U; index < argument_count; ++index) {
    enum capnweb_status status = validate_expression(
        session, &arguments[index], 0U, &capability_count);
    if (status != CAPNWEB_OK) {
      return status;
    }
  }
  for (index = 0U; index < argument_count; ++index) {
    enum capnweb_status status = validate_refcounts(
        session, &arguments[index], capability_count);
    if (status != CAPNWEB_OK) {
      return status;
    }
  }

  expression_arguments = (struct expression_arguments){
    arguments,
    argument_count,
    capability_count,
  };
  return capnweb_session_call_encoded(
      session,
      capability,
      path,
      path_count,
      completion,
      context,
      reserve_argument_capabilities,
      write_expression_arguments,
      &expression_arguments);
}
