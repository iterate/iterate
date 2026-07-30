// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include <string.h>

static enum capnweb_status prepare_reply(
    struct capnweb_reply *reply, enum capnweb_reply_kind kind) {
  if (reply == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (reply->kind != CAPNWEB_REPLY_UNSET &&
      reply->kind != CAPNWEB_REPLY_DEFERRED) {
    return CAPNWEB_E_STATE;
  }
  memset(&reply->value, 0, sizeof(reply->value));
  reply->kind = kind;
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_reply_set_null(struct capnweb_reply *reply) {
  return prepare_reply(reply, CAPNWEB_REPLY_NULL);
}

enum capnweb_status capnweb_reply_set_boolean(
    struct capnweb_reply *reply, bool value) {
  enum capnweb_status status = prepare_reply(
      reply, CAPNWEB_REPLY_BOOLEAN);
  if (status == CAPNWEB_OK) {
    reply->value.boolean = value;
  }
  return status;
}

enum capnweb_status capnweb_reply_set_int64(
    struct capnweb_reply *reply, int64_t value) {
  enum capnweb_status status = prepare_reply(reply, CAPNWEB_REPLY_INT64);
  if (status == CAPNWEB_OK) {
    reply->value.integer = value;
  }
  return status;
}

enum capnweb_status capnweb_reply_set_borrowed_expression(
    struct capnweb_reply *reply,
    const char *expression,
    size_t length,
    capnweb_release_fn release,
    void *context) {
  enum capnweb_status status;
  if (expression == NULL || length == 0U) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  status = prepare_reply(reply, CAPNWEB_REPLY_EXPRESSION);
  if (status == CAPNWEB_OK) {
    reply->value.borrowed = (struct capnweb_borrowed_data){
      expression,
      length,
      release,
      context,
    };
  }
  return status;
}

enum capnweb_status capnweb_reply_set_capability(
    struct capnweb_reply *reply, struct capnweb_capability capability) {
  enum capnweb_status status;
  if (capability.dispatch == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  status = prepare_reply(reply, CAPNWEB_REPLY_CAPABILITY);
  if (status == CAPNWEB_OK) {
    reply->value.capability = capability;
  }
  return status;
}

enum capnweb_status capnweb_reply_set_bytes(
    struct capnweb_reply *reply,
    const uint8_t *data,
    size_t length,
    capnweb_release_fn release,
    void *context) {
  enum capnweb_status status;
  if (data == NULL && length > 0U) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  status = prepare_reply(reply, CAPNWEB_REPLY_BYTES);
  if (status == CAPNWEB_OK) {
    reply->value.borrowed = (struct capnweb_borrowed_data){
      data,
      length,
      release,
      context,
    };
  }
  return status;
}

enum capnweb_status capnweb_reply_defer(struct capnweb_reply *reply) {
  if (reply == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (reply->kind != CAPNWEB_REPLY_UNSET) {
    return CAPNWEB_E_STATE;
  }
  reply->kind = CAPNWEB_REPLY_DEFERRED;
  return CAPNWEB_OK;
}

enum capnweb_status capnweb_reply_set_error(
    struct capnweb_reply *reply, const char *type, const char *message) {
  enum capnweb_status status;
  if (type == NULL || message == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  status = prepare_reply(reply, CAPNWEB_REPLY_ERROR);
  if (status == CAPNWEB_OK) {
    reply->value.error = (struct capnweb_error){
      type,
      message,
    };
  }
  return status;
}
