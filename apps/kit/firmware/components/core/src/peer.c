#include "iterate/kit/peer.h"

#include <string.h>

/*
 * A device profile is a static composition of small capability modules, not a
 * dynamic object tree. The peer borrows method tables and one generated
 * description expression, then dispatches Cap'n Web paths without allocation.
 * This keeps the C integration ordinary for M5Unified and other native
 * targets, while code generation can still give TypeScript callers a typed
 * `itx.kit.<device>` surface.
 *
 * Duplicate paths are rejected at initialization instead of resolved by module
 * order. “First one wins” looked convenient for composition, but a build-order
 * change could silently route a physical command to the wrong driver. The
 * reserved __describe path is handled centrally so every device reports the
 * exact schema used to generate its firmware-side tables.
 *
 * Polling is cooperative and single-owner. Modules may expose asynchronous
 * capabilities or subscriptions, but they must advance bounded work and return
 * a classified result; the peer adds no queue, mutex, retry, or hidden
 * fallback. Session end releases remote handles without closing persistent
 * hardware modules, while close is the explicit physical lifecycle boundary.
 */

static const char *const describe_path[] = {"__describe"};
static const char *const invoke_capability_path[] = {"invokeCapability"};

static bool same_path(
    const struct iterate_kit_method *left,
    const struct iterate_kit_method *right) {
  size_t index;
  if (left->path_count != right->path_count) {
    return false;
  }
  for (index = 0U; index < left->path_count; ++index) {
    if (strcmp(left->path[index], right->path[index]) != 0) {
      return false;
    }
  }
  return true;
}

static bool valid_method(const struct iterate_kit_method *method) {
  size_t index;
  if (method == NULL ||
      method->path == NULL ||
      method->path_count == 0U ||
      method->dispatch == NULL) {
    return false;
  }
  for (index = 0U; index < method->path_count; ++index) {
    if (method->path[index] == NULL || method->path[index][0] == '\0') {
      return false;
    }
  }
  return true;
}

static bool valid_modules(
    const struct iterate_kit_module *modules, size_t module_count) {
  size_t module_index;
  size_t method_index;
  size_t other_module_index;
  size_t other_method_index;
  if (modules == NULL && module_count > 0U) {
    return false;
  }
  /*
   * This O(methods²) duplicate check runs once at startup over a tiny generated
   * table. Storing a hash table would permanently spend RAM merely to optimize
   * configuration validation that never touches the realtime path.
   */
  for (module_index = 0U; module_index < module_count; ++module_index) {
    const struct iterate_kit_module *module = &modules[module_index];
    if (module->methods == NULL && module->method_count > 0U) {
      return false;
    }
    for (method_index = 0U;
         method_index < module->method_count;
         ++method_index) {
      const struct iterate_kit_method *method =
          &module->methods[method_index];
      if (!valid_method(method)) {
        return false;
      }
      for (other_module_index = 0U;
           other_module_index <= module_index;
           ++other_module_index) {
        const struct iterate_kit_module *other_module =
            &modules[other_module_index];
        const size_t other_method_count =
            other_module_index == module_index
                ? method_index
                : other_module->method_count;
        for (other_method_index = 0U;
             other_method_index < other_method_count;
             ++other_method_index) {
          if (same_path(
                  method,
                  &other_module->methods[other_method_index])) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

static enum capnweb_status dispatch_static_path(
    struct iterate_kit_peer *peer,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  size_t module_index;
  size_t method_index;
  if (capnweb_call_path_equals(call, describe_path, 1U)) {
    return capnweb_reply_set_borrowed_expression(
        reply,
        peer->options.description_expression,
        peer->options.description_expression_length,
        NULL,
        NULL);
  }

  for (module_index = 0U;
       module_index < peer->options.module_count;
       ++module_index) {
    const struct iterate_kit_module *module =
        &peer->options.modules[module_index];
    for (method_index = 0U;
         method_index < module->method_count;
         ++method_index) {
      const struct iterate_kit_method *method =
          &module->methods[method_index];
      if (capnweb_call_path_equals(
              call, method->path, method->path_count)) {
        return method->dispatch(module->context, call, reply);
      }
    }
  }
  return capnweb_reply_set_error(
      reply, "TypeError", "unknown device capability");
}

/*
 * A flattened OS live mount crosses one generic JavaScript capability host
 * before it reaches this peer. That host preserves the complete nested method
 * route as data:
 *
 *   invokeCapability({ path: ["pushToTalk", "start"], args: [] })
 *
 * Reconstructing a borrowed capnweb_call view lets the normal generated method
 * table remain the only dispatcher. Copying strings into a second routing
 * format or materializing a fake object tree was rejected: both add memory and
 * can drift from direct Cap'n Web calls. All views below point into the current
 * immutable receive message and cannot escape this synchronous dispatch.
 */
static enum capnweb_status dispatch_flattened(
    struct iterate_kit_peer *peer,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value envelope;
  struct capnweb_value path;
  struct capnweb_value arguments;
  struct capnweb_value flatten_nested_path;
  bool flatten = false;
  struct capnweb_call nested_call;

  if (!call->has_arguments ||
      capnweb_value_array_size(&call->arguments) != 1U ||
      !capnweb_value_array_at(&call->arguments, 0U, &envelope) ||
      capnweb_value_get_type(&envelope) != CAPNWEB_JSON_OBJECT ||
      !capnweb_value_object_get(&envelope, "path", &path) ||
      !capnweb_value_get_expression_array(&path, &path) ||
      capnweb_value_array_size(&path) == 0U ||
      !capnweb_value_object_get(&envelope, "args", &arguments) ||
      !capnweb_value_get_expression_array(
          &arguments, &arguments)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "invalid invokeCapability envelope");
  }
  /*
   * The flag is optional in the public host type, but if present it must state
   * the semantics this adapter implements. Silently accepting false or a
   * malformed value would make a caller believe member replay occurred.
   */
  if (capnweb_value_object_get(
          &envelope, "flattenNestedPath", &flatten_nested_path) &&
      (!capnweb_value_get_boolean(&flatten_nested_path, &flatten) ||
       !flatten)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "invalid invokeCapability flattenNestedPath");
  }

  nested_call = (struct capnweb_call){
    .path = path,
    .arguments = arguments,
    .has_arguments = true,
    .responder = call->responder,
  };
  /*
   * Call the static router rather than the outer adapter so a hostile nested
   * `["invokeCapability"]` route cannot recursively unwrap envelopes.
   */
  return dispatch_static_path(peer, &nested_call, reply);
}

static enum capnweb_status dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_peer *peer = context;
  if (peer == NULL ||
      !peer->initialized ||
      call == NULL ||
      reply == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  /*
   * Count arrival, not successful business outcome. An unknown method or a
   * driver-level error still proves the server found this live provider and
   * delivered an RPC through its mount. Conversely, WebSocket/Cap'n Web ping
   * traffic never enters capability dispatch and therefore cannot disguise a
   * server-side mount that has gone offline.
   */
  if (peer->served_dispatches < UINT32_MAX) {
    ++peer->served_dispatches;
  }
  if (capnweb_call_path_equals(
          call, invoke_capability_path, 1U)) {
    return dispatch_flattened(peer, call, reply);
  }
  return dispatch_static_path(peer, call, reply);
}

enum capnweb_status iterate_kit_peer_init(
    struct iterate_kit_peer *peer,
    const struct iterate_kit_peer_options *options) {
  if (peer == NULL || options == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (peer->initialized) {
    return CAPNWEB_E_STATE;
  }
  if (options->description_expression == NULL ||
      options->description_expression_length == 0U ||
      !valid_modules(options->modules, options->module_count)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  peer->options = *options;
  peer->served_dispatches = 0U;
  peer->initialized = true;
  return CAPNWEB_OK;
}

struct capnweb_capability iterate_kit_peer_capability(
    struct iterate_kit_peer *peer) {
  const struct capnweb_capability capability = {
    dispatch,
    peer,
    NULL,
  };
  return capability;
}

uint32_t iterate_kit_peer_served_dispatches(
    const struct iterate_kit_peer *peer) {
  if (peer == NULL || !peer->initialized) {
    return 0U;
  }
  return peer->served_dispatches;
}

void iterate_kit_peer_session_ended(struct iterate_kit_peer *peer) {
  size_t index;
  if (peer == NULL || !peer->initialized) {
    return;
  }
  for (index = 0U; index < peer->options.module_count; ++index) {
    const struct iterate_kit_module *module = &peer->options.modules[index];
    if (module->session_ended != NULL) {
      module->session_ended(module->context);
    }
  }
}

struct iterate_kit_poll_result iterate_kit_peer_close(
    struct iterate_kit_peer *peer) {
  size_t index;
  struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
  if (peer == NULL || !peer->initialized) {
    result.status = ITERATE_KIT_POLL_CAPNWEB_ERROR;
    result.capnweb_status = CAPNWEB_E_STATE;
    return result;
  }
  for (index = peer->options.module_count; index > 0U; --index) {
    const struct iterate_kit_module *module =
        &peer->options.modules[index - 1U];
    if (module->close != NULL) {
      const struct iterate_kit_poll_result close_result =
          module->close(module->context);
      if (result.status == ITERATE_KIT_POLL_OK &&
          close_result.status != ITERATE_KIT_POLL_OK) {
        result = close_result;
      }
    }
  }
  peer->initialized = false;
  return result;
}
