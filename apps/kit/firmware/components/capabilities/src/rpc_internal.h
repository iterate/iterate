#ifndef ITERATE_KIT_CAPABILITIES_RPC_INTERNAL_H
#define ITERATE_KIT_CAPABILITIES_RPC_INTERNAL_H

#include "iterate/kit/status.h"

#include "capnweb/capnweb.h"

/* Hardware status maps to one shared, small RPC error vocabulary. */
enum capnweb_status iterate_kit_reply_status(
    struct capnweb_reply *reply, enum iterate_kit_status status);

#endif
