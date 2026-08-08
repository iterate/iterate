#ifndef ITERATE_KIT_CAPABILITIES_ARGUMENTS_H
#define ITERATE_KIT_CAPABILITIES_ARGUMENTS_H

#include "iterate/kit/status.h"

#include "capnweb/capnweb.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Reading a method's arguments, shared so that hardware status and malformed
 * JSON do not drift into per-device conventions.
 *
 * These were private to this component until a board needed a method of its
 * own — the HA Voice PE's handle on its XMOS taps, which is not portable and
 * should not pretend to be. A device that has one genuinely board-specific
 * method should be able to mount it without either copying an argument parser
 * or inventing a fake capability to hang it on.
 *
 * Values are BORROWED for the duration of dispatch only.
 */

/** Hardware status maps to one shared, small RPC error vocabulary. */
enum capnweb_status iterate_kit_reply_status(
    struct capnweb_reply *reply, enum iterate_kit_status status);

/** The single object argument a method was called with, or false. */
bool iterate_kit_read_object_argument(
    const struct capnweb_call *call, struct capnweb_value *object);

/** One integer field of that object, or false if it is absent or not one. */
bool iterate_kit_read_int_field(
    const struct capnweb_value *object,
    const char *name,
    int64_t *result);

#ifdef __cplusplus
}
#endif

#endif
