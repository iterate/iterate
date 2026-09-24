#ifndef ITERATE_KIT_ITX_MOUNT_H
#define ITERATE_KIT_ITX_MOUNT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "capnweb/capnweb.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * The rewrite match this device's capability answers is remote-facing
   * configuration, not arbitrary input: it names one device in one project.
   * Bounding it here keeps validation and the call expression allocation free,
   * and rejects a runaway profile string before it can become a reconnect loop.
   */
  ITERATE_KIT_ITX_MOUNT_CAPABILITY_MATCH_CAPACITY = 96,
};

enum iterate_kit_itx_mount_state {
  ITERATE_KIT_ITX_MOUNT_IDLE = 0,
  ITERATE_KIT_ITX_MOUNT_AUTHENTICATING,
  ITERATE_KIT_ITX_MOUNT_GETTING_PROJECT,
  ITERATE_KIT_ITX_MOUNT_PROVIDING,
  ITERATE_KIT_ITX_MOUNT_READY,
  ITERATE_KIT_ITX_MOUNT_FAILED,
  ITERATE_KIT_ITX_MOUNT_CLOSED,
};

enum iterate_kit_itx_mount_failure {
  ITERATE_KIT_ITX_MOUNT_FAILURE_NONE = 0,
  ITERATE_KIT_ITX_MOUNT_FAILURE_INVALID_OPTIONS,
  ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_CALL,
  ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_REJECTED,
  ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_RESULT,
  ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_CALL,
  ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_REJECTED,
  ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_RESULT,
  ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_CALL,
  ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_REJECTED,
  ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_RESULT,
  ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE,
  ITERATE_KIT_ITX_MOUNT_FAILURE_SESSION_ENDED,
};

struct iterate_kit_itx_mount_options {
  struct capnweb_session *session;
  /**
   * The project's id (`prj_<hex>`); `projects.get` takes it — or the project's
   * slug — as one bare string.
   */
  const char *project_id;
  /**
   * The blob's key field: a personal access token the Kit page minted for the
   * person who set this device up, scoped to this project. The transport
   * presents it as `Authorization: Bearer` on the upgrade; it is revoked from
   * that person's sessions list.
   */
  const char *project_api_key;
  /**
   * The itx expression this device's capability answers, e.g.
   * "itx.clients.home_assistant_voice_preview_edition".
   *
   * A MATCH, NOT A PATH: `provide(match, stub)` makes every call that STARTS
   * with `match` run against the lent stub, so a caller reaches this board as
   * `root.clients.home_assistant_voice_preview_edition.health()` and the
   * remaining steps arrive as the Cap'n Web path this device already
   * dispatches. Every segment is a JavaScript identifier because the server
   * spells the call in JavaScript: a device slug's hyphens must be written as
   * underscores by whoever builds this string.
   */
  const char *capability_match;
  struct capnweb_capability capability;
};

/**
 * One live Cap'n Web session's addressing of an OS project, plus the one
 * act that lends this device back to it.
 *
 * THREE CALLS:
 *
 *   authenticate({type: "bearer"})                 -> the session the upgrade resolved
 *   projects.get("<project id>")                   -> the project's ROOT itx
 *   provide("<capability match>", <this device>)   -> a rewrite rule handle
 *
 * `projects.get` is pure addressing and takes one string; `provide` is the ONE
 * entry point for making a name mean this device.
 *
 * WHAT READY OWNS: the session import (what the liveness probe asks), the
 * project import, and the rewrite-rule handle that IS the live provision —
 * releasing it un-does the rule and recalls the lent stub, so the release order
 * in close() is the rule first, the project second, the session last. Dropping
 * the rule handle instead of releasing it would leave the match pointing at a
 * stub this session no longer answers for.
 *
 * The state machine is single-owner and callback-driven. At each stage the
 * mount owns only the handles marked by `has_*`; these booleans are the cleanup
 * ledger, not redundant cache. No retry occurs inside the mount because auth
 * rejection, protocol corruption, and transport loss require different outer
 * recovery policy and diagnostics. READY does not prove future liveness;
 * `probe_if_due` is what keeps asking.
 */
struct iterate_kit_itx_mount {
  struct iterate_kit_itx_mount_options options;
  enum iterate_kit_itx_mount_state state;
  enum iterate_kit_itx_mount_failure failure;
  enum capnweb_status capnweb_status;
  struct capnweb_remote_capability session_capability;
  struct capnweb_remote_capability project_capability;
  /** `provide`'s answer: disposing it un-does the rule and recalls the stub. */
  struct capnweb_remote_capability rule_capability;
  struct capnweb_local_capability local_capability;
  bool has_session_capability;
  bool has_project_capability;
  bool has_rule_capability;
  bool has_local_capability;
  /** Milliseconds at the last probe attempt; 0 until one is sent. */
  uint64_t last_probe_ms;
  /** One probe in flight at a time; a second would prove nothing new. */
  bool probe_pending;
  uint32_t probes_sent;
  uint32_t probes_answered;
};

enum capnweb_status iterate_kit_itx_mount_start(
    struct iterate_kit_itx_mount *mount,
    const struct iterate_kit_itx_mount_options *options);

/**
 * Sends `whoami()` on the SESSION once a period, because the OS's idle close
 * counts APPLICATION messages and a PING is not one; the timing and the ping's
 * division of labour are in voice_device_profile.h. The session's `whoami()` is
 * the cheapest real call there is: the edge answers it from the admission gate
 * and no Durable Object is touched. (The project root's `whoami()` is NOT that
 * call: it wakes the project's context, and a device parked on it woke it once
 * a minute, appending a wake record to the project's log each time.) Returns
 * whether a probe left the device — false covers not mounted, one already
 * pending, not yet due, and a session with no room, none of which a caller acts
 * on differently.
 */
bool iterate_kit_itx_mount_probe_if_due(
    struct iterate_kit_itx_mount *mount, uint64_t now_ms);

/**
 * Releases every capability handle currently owned by the mount. If a call is
 * still outstanding, the caller must close the Cap'n Web session immediately
 * afterwards so its completion is settled as SESSION_ENDED.
 *
 * Cleanup attempts all handles and returns the first error. Stopping at the
 * first release failure would strand later imports/exports and obscure the
 * actual ownership state.
 */
enum capnweb_status iterate_kit_itx_mount_close(
    struct iterate_kit_itx_mount *mount);

const char *iterate_kit_itx_mount_state_name(
    enum iterate_kit_itx_mount_state state);
const char *iterate_kit_itx_mount_failure_name(
    enum iterate_kit_itx_mount_failure failure);

#ifdef __cplusplus
}
#endif

#endif
