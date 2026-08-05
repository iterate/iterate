#ifndef ITERATE_KIT_CAPABILITIES_HEALTH_H
#define ITERATE_KIT_CAPABILITIES_HEALTH_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Ask the device how it is, on demand.
 *
 * The same numbers already ride the stream as ephemeral `dev-stats` every few
 * seconds, and that is the better instrument while a device is talking. This
 * exists for the case those cannot cover: the push has stopped, or nobody was
 * listening when it mattered. Every counter that explains a fault is in the
 * pushed telemetry precisely so the pull returns the same thing — the state
 * worth diagnosing is the one where the push has stopped, so the two are not
 * allowed to disagree.
 *
 * Without this the only way to interrogate a quiet board is its console, and
 * on these boards attaching the console REBOOTS them — which destroys the
 * state you attached to inspect, and once destroyed a live conversation with
 * it.
 */
struct iterate_kit_health_driver {
  void *context;
  /**
   * Render the device's health as a JSON object into `out`.
   *
   * Returns the byte count written, excluding any terminator, or 0 if the
   * document did not fit. MUST BE PURE: a renderer that also stamped a
   * liveness timestamp made the device renew its own lease twelve times a
   * minute, so a board that had stopped answering still looked reachable —
   * measured as seven minutes of unreachability with a watchdog armed and the
   * server holding no connections. Report state here; never change it.
   */
  size_t (*render)(void *context, char *out, size_t capacity);
};

/**
 * Caller-owned state, including the buffer the document is rendered into.
 *
 * The buffer is supplied rather than owned so its size is a device decision
 * next to the counters that fill it: a board that adds counters must widen it
 * in the same file, instead of discovering at run time that its telemetry has
 * gone quiet exactly because it was extended.
 */
struct iterate_kit_health {
  struct iterate_kit_health_driver driver;
  char *buffer;
  size_t capacity;
};

enum iterate_kit_status iterate_kit_health_init(
    struct iterate_kit_health *health,
    const struct iterate_kit_health_driver *driver,
    char *buffer,
    size_t capacity);
struct iterate_kit_module iterate_kit_health_module(
    struct iterate_kit_health *health);

#ifdef __cplusplus
}
#endif

#endif
