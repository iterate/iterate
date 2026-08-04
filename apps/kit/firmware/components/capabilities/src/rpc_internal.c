#include "rpc_internal.h"

/*
 * Keep the public error vocabulary small while preserving whether the caller
 * supplied a bad command, exceeded a fixed resource, or hit device state/I/O.
 * ITERATE_KIT_OK reaching this function is itself a programming error; turning
 * it into a rejected RPC makes that contradiction visible instead of sending a
 * false success.
 */
enum capnweb_status iterate_kit_reply_status(
    struct capnweb_reply *reply, enum iterate_kit_status status) {
  switch (status) {
    case ITERATE_KIT_INVALID_ARGUMENT:
      return capnweb_reply_set_error(
          reply, "RangeError", "hardware rejected the arguments");
    case ITERATE_KIT_UNAVAILABLE:
      return capnweb_reply_set_error(
          reply, "Error", "hardware capability unavailable");
    case ITERATE_KIT_IO_ERROR:
      return capnweb_reply_set_error(
          reply, "Error", "hardware I/O failed");
    case ITERATE_KIT_LIMIT:
      return capnweb_reply_set_error(
          reply, "RangeError", "hardware resource limit reached");
    case ITERATE_KIT_BACKPRESSURE:
      return capnweb_reply_set_error(
          reply, "Error", "hardware is busy");
    case ITERATE_KIT_STATE_ERROR:
      return capnweb_reply_set_error(
          reply, "Error", "hardware is in the wrong state");
    case ITERATE_KIT_OK:
      return capnweb_reply_set_error(
          reply, "Error", "hardware returned an invalid success status");
  }
  return capnweb_reply_set_error(
      reply, "Error", "hardware returned an unknown status");
}
