#include "iterate/kit/capabilities/conversation.h"

static const char *const start_path[] = {"conversation", "start"};
static const char *const end_path[] = {"conversation", "end"};

static enum capnweb_status start(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_conversation_control *conversation = context;
  (void)call;
  conversation->start_call = true;
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status end(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_conversation_control *conversation = context;
  (void)call;
  conversation->end_call = true;
  return capnweb_reply_set_boolean(reply, true);
}

struct iterate_kit_module iterate_kit_conversation_control_module(
    struct iterate_kit_conversation_control *conversation) {
  static const struct iterate_kit_method methods[] = {
    {start_path, 2U, start},
    {end_path, 2U, end},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = conversation,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
