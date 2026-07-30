// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include <stddef.h>
#include <stdint.h>

enum {
  TOKEN_CAPACITY = 64,
  CALL_CAPACITY = 4,
  OUTPUT_SCRATCH_CAPACITY = 17,
};

struct fuzz_context {
  struct capnweb_responder deferred;
};

static enum capnweb_status inert_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  return capnweb_reply_set_null(reply);
}

static enum capnweb_status dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  static const char *const defer_path[] = {"defer"};
  static const char *const capability_path[] = {"capability"};
  static const uint8_t bytes[] = {0U, 1U, 255U};
  struct fuzz_context *fuzz_context = context;

  if (capnweb_call_path_equals(call, defer_path, 1U)) {
    fuzz_context->deferred = call->responder;
    return capnweb_reply_defer(reply);
  }
  if (capnweb_call_path_equals(call, capability_path, 1U)) {
    return capnweb_reply_set_capability(
        reply,
        (struct capnweb_capability){
          inert_dispatch,
          NULL,
          NULL,
        });
  }
  return capnweb_reply_set_bytes(
      reply, bytes, sizeof(bytes), NULL, NULL);
}

static enum capnweb_status discard_fragment(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  (void)context;
  if (kind == CAPNWEB_TEXT_DATA) {
    return data != NULL || length == 0U
        ? CAPNWEB_OK
        : CAPNWEB_E_TRANSPORT;
  }
  return data == NULL && length == 0U
      ? CAPNWEB_OK
      : CAPNWEB_E_TRANSPORT;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  struct capnweb_session session;
  struct fuzz_context context = {{NULL, 0}};
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  char output_scratch[OUTPUT_SCRATCH_CAPACITY];
  struct capnweb_session_options options = {
    {dispatch, &context, NULL},
    discard_fragment,
    NULL,
    pending_calls,
    CALL_CAPACITY,
    exports,
    CALL_CAPACITY,
    imports,
    CALL_CAPACITY,
    tokens,
    TOKEN_CAPACITY,
    output_scratch,
    sizeof(output_scratch),
  };

  if (capnweb_session_init(&session, &options) == CAPNWEB_OK) {
    size_t start = 0U;
    size_t index;
    for (index = 0U; index <= size; ++index) {
      if (index == size || data[index] == 0U || data[index] == '\n') {
        if (index > start) {
          (void)capnweb_session_receive(
              &session,
              (const char *)data + start,
              index - start);
        }
        start = index + 1U;
      }
    }
    if (context.deferred.session != NULL) {
      (void)capnweb_responder_set_int64(context.deferred, 1);
    }
    capnweb_session_close(&session);
  }
  return 0;
}
