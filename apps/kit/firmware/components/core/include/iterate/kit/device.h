#ifndef ITERATE_KIT_DEVICE_H
#define ITERATE_KIT_DEVICE_H

#include "iterate/kit/audio.h"
#include "iterate/kit/peer.h"

#ifdef __cplusplus
extern "C" {
#endif

struct iterate_kit_device_manifest {
  const char *slug;
  const char *display_name;
  enum iterate_kit_audio_mode audio_mode;
};

typedef struct iterate_kit_poll_result (*iterate_kit_device_poll_fn)(
    void *context, uint64_t now_ms);
typedef struct iterate_kit_poll_result (*iterate_kit_device_close_fn)(
    void *context);

/**
 * Type-erased device profile used by transports and host simulators. Platform
 * drivers remain in the concrete profile's caller-owned context.
 */
struct iterate_kit_device {
  const struct iterate_kit_device_manifest *manifest;
  struct capnweb_capability capability;
  void *context;
  iterate_kit_device_poll_fn poll;
  iterate_kit_device_close_fn close;
};

#ifdef __cplusplus
}
#endif

#endif
