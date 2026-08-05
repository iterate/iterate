#ifndef ITERATE_KIT_CAPABILITIES_RPC_INTERNAL_H
#define ITERATE_KIT_CAPABILITIES_RPC_INTERNAL_H

#include "iterate/kit/status.h"

#include "capnweb/capnweb.h"

#include <stdbool.h>
#include <stdint.h>

/* Hardware status maps to one shared, small RPC error vocabulary. */
enum capnweb_status iterate_kit_reply_status(
    struct capnweb_reply *reply, enum iterate_kit_status status);

/*
 * Strict wire-argument helpers shared by capability modules, so hardware
 * status and malformed JSON do not drift into device-specific conventions.
 * They borrow Cap'n Web values only for the duration of dispatch.
 */
bool iterate_kit_read_object_argument(
    const struct capnweb_call *call, struct capnweb_value *object);
bool iterate_kit_read_int_field(
    const struct capnweb_value *object,
    const char *name,
    int64_t *result);

#endif
