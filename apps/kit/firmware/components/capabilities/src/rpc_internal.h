#ifndef ITERATE_KIT_CAPABILITIES_RPC_INTERNAL_H
#define ITERATE_KIT_CAPABILITIES_RPC_INTERNAL_H

#include "iterate/kit/status.h"

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

#endif
