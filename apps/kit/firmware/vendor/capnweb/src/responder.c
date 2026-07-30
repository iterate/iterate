// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include "session_internal.h"

static enum capnweb_status get_deferred_pending(
    struct capnweb_responder responder,
    struct capnweb_pending_call **result) {
  struct capnweb_pending_call *pending;
  if (responder.session == NULL || result == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (responder.session->state != CAPNWEB_SESSION_OPEN) {
    return responder.session->terminal_status;
  }
  pending = capnweb_session_find_pending(
      responder.session, responder.id);
  if (pending == NULL) {
    return responder.id > 0 &&
        responder.id < responder.session->next_incoming_call_id
        ? CAPNWEB_E_CANCELED
        : CAPNWEB_E_STATE;
  }
  if (pending->reply.kind != CAPNWEB_REPLY_DEFERRED) {
    return CAPNWEB_E_STATE;
  }
  *result = pending;
  return CAPNWEB_OK;
}

static enum capnweb_status finish_responder(
    struct capnweb_responder responder,
    struct capnweb_pending_call *pending,
    enum capnweb_status setter_status) {
  enum capnweb_status status;
  if (setter_status != CAPNWEB_OK) {
    return setter_status;
  }
  status = capnweb_session_adopt_reply(responder.session, pending);
  if (status != CAPNWEB_OK || !pending->pulled) {
    return status;
  }
  return capnweb_session_send_pending_resolution(
      responder.session, pending);
}

enum capnweb_status capnweb_responder_set_null(
    struct capnweb_responder responder) {
  struct capnweb_pending_call *pending;
  enum capnweb_status status = get_deferred_pending(responder, &pending);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return finish_responder(
      responder, pending, capnweb_reply_set_null(&pending->reply));
}

enum capnweb_status capnweb_responder_set_boolean(
    struct capnweb_responder responder, bool value) {
  struct capnweb_pending_call *pending;
  enum capnweb_status status = get_deferred_pending(responder, &pending);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return finish_responder(
      responder,
      pending,
      capnweb_reply_set_boolean(&pending->reply, value));
}

enum capnweb_status capnweb_responder_set_int64(
    struct capnweb_responder responder, int64_t value) {
  struct capnweb_pending_call *pending;
  enum capnweb_status status = get_deferred_pending(responder, &pending);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return finish_responder(
      responder,
      pending,
      capnweb_reply_set_int64(&pending->reply, value));
}

enum capnweb_status capnweb_responder_set_borrowed_expression(
    struct capnweb_responder responder,
    const char *expression,
    size_t length,
    capnweb_release_fn release,
    void *context) {
  struct capnweb_pending_call *pending;
  enum capnweb_status status = get_deferred_pending(responder, &pending);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return finish_responder(
      responder,
      pending,
      capnweb_reply_set_borrowed_expression(
          &pending->reply, expression, length, release, context));
}

enum capnweb_status capnweb_responder_set_capability(
    struct capnweb_responder responder,
    struct capnweb_capability capability) {
  struct capnweb_pending_call *pending;
  enum capnweb_status status = get_deferred_pending(responder, &pending);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return finish_responder(
      responder,
      pending,
      capnweb_reply_set_capability(&pending->reply, capability));
}

enum capnweb_status capnweb_responder_set_bytes(
    struct capnweb_responder responder,
    const uint8_t *data,
    size_t length,
    capnweb_release_fn release,
    void *context) {
  struct capnweb_pending_call *pending;
  enum capnweb_status status = get_deferred_pending(responder, &pending);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return finish_responder(
      responder,
      pending,
      capnweb_reply_set_bytes(
          &pending->reply, data, length, release, context));
}

enum capnweb_status capnweb_responder_set_error(
    struct capnweb_responder responder,
    const char *type,
    const char *message) {
  struct capnweb_pending_call *pending;
  enum capnweb_status status = get_deferred_pending(responder, &pending);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return finish_responder(
      responder,
      pending,
      capnweb_reply_set_error(&pending->reply, type, message));
}
