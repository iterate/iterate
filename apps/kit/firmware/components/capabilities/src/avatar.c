#include "iterate/kit/capabilities/avatar.h"

#include "rpc_internal.h"

#include <string.h>

static const char *const change_sprite_set_path[] = {"changeSpriteSet"};

static enum capnweb_status change_sprite_set(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_avatar *avatar = context;
  struct capnweb_value value = {0};
  struct capnweb_value unexpected = {0};
  size_t slug_length = 0U;
  enum iterate_kit_status status;
  if (call == NULL ||
      !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value) ||
      capnweb_value_array_at(&call->arguments, 1U, &unexpected) ||
      capnweb_value_copy_string(
          &value,
          avatar->slug_scratch,
          avatar->slug_scratch_size,
          &slug_length) != CAPNWEB_OK ||
      slug_length == 0U) {
    return capnweb_reply_set_error(
        reply,
        "TypeError",
        "expected exactly one bounded sprite-set slug");
  }
  status = avatar->driver.change_sprite_set(
      avatar->driver.context, avatar->slug_scratch, slug_length);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_boolean(reply, true);
}

enum iterate_kit_status iterate_kit_avatar_init(
    struct iterate_kit_avatar *avatar,
    const struct iterate_kit_avatar_driver *driver,
    char *slug_scratch,
    size_t slug_scratch_size) {
  if (avatar == NULL ||
      driver == NULL ||
      driver->change_sprite_set == NULL ||
      slug_scratch == NULL ||
      slug_scratch_size < 2U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(avatar, 0, sizeof(*avatar));
  avatar->driver = *driver;
  avatar->slug_scratch = slug_scratch;
  avatar->slug_scratch_size = slug_scratch_size;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_avatar_module(
    struct iterate_kit_avatar *avatar) {
  static const struct iterate_kit_method methods[] = {
    {change_sprite_set_path, 1U, change_sprite_set},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = avatar,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
