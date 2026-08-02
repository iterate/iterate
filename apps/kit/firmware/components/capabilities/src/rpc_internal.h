#ifndef ITERATE_KIT_CAPABILITIES_RPC_INTERNAL_H
#define ITERATE_KIT_CAPABILITIES_RPC_INTERNAL_H

#include "iterate/kit/status.h"
#include "iterate/kit/capabilities/subscription.h"

#include "capnweb/capnweb.h"

#include <stdbool.h>
#include <stdint.h>

/*
 * Capability modules share this strict wire boundary so hardware status and
 * malformed JSON do not drift into device-specific ad-hoc conventions. These
 * helpers borrow Cap'n Web values only for the duration of dispatch and
 * allocate nothing.
 */
enum capnweb_status iterate_kit_reply_status(
    struct capnweb_reply *reply, enum iterate_kit_status status);
bool iterate_kit_read_object_argument(
    const struct capnweb_call *call, struct capnweb_value *object);
bool iterate_kit_read_int_field(
    const struct capnweb_value *object,
    const char *name,
    int64_t *result);

/*
 * Reads `subscribe(callback, ownerKey?)` and takes ownership of the imported
 * callback only when `valid` is true. On a malformed optional key the helper
 * first releases that import, then writes a normal RPC rejection. This keeps
 * every callback-producing capability aligned on the same bounded wire rule.
 */
enum capnweb_status iterate_kit_read_subscription_arguments(
    struct capnweb_session *session,
    const struct capnweb_call *call,
    struct capnweb_reply *reply,
    const char *callback_error_message,
    struct capnweb_remote_capability *callback,
    struct iterate_kit_subscription_owner_key *owner_key,
    bool *valid);

bool iterate_kit_subscription_owner_keys_equal(
    const struct iterate_kit_subscription_owner_key *left,
    const struct iterate_kit_subscription_owner_key *right);

#endif
