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
   * The project's id, which on os-next IS its DNS-safe slug ("prj-voice").
   * `projects.get` takes it as one bare string.
   */
  const char *project_id;
  /**
   * The blob's key field, spoken as the deployment admin secret on the
   * operator door. It is the deployment's ROOT credential and reaches every
   * project, so a board holding one is a bench board; a device-scoped grant
   * will replace it without changing this call's shape.
   */
  const char *project_api_key;
  /**
   * The itx expression this device's capability answers, e.g.
   * "itx.clients.home_assistant_voice_preview_edition".
   *
   * A MATCH, NOT A PATH. `projects.connect` took a stream path and mounted the
   * capability under a fixed member name; os-next has one front door instead —
   * `provide(match, stub)` makes every call that STARTS with `match` run
   * against the lent stub, so a caller reaches this board as
   * `root.clients.home_assistant_voice_preview_edition.health()` and the
   * remaining steps arrive as the Cap'n Web path this device already
   * dispatches.
   *
   * Every segment is a JavaScript identifier because the server spells the
   * call in JavaScript: a device slug's hyphens must be written as
   * underscores by whoever builds this string.
   */
  const char *capability_match;
  struct capnweb_capability capability;
};

/**
 * One live Cap'n Web session's addressing of an os-next project, plus the one
 * act that lends this device back to it.
 *
 * THREE CALLS:
 *
 *   authenticate({type: "admin-secret", secret})   -> the session capability
 *   projects.get("<project id>")                   -> the project's ROOT itx
 *   provide("<capability match>", <this device>)   -> a rewrite rule handle
 *
 * apps/os bundled all three into `projects.connect`, which addressed the
 * project AND provided the capability in one trip. os-next splits addressing
 * from lending: `projects.get` is pure addressing and takes one string, and
 * `provide` is the ONE front door for making a name mean this device.
 *
 * WHAT READY OWNS: the project import, and the rewrite-rule handle that IS the
 * live provision — releasing it un-does the rule and recalls the lent stub, so
 * the release order in close() is the rule first and the project second.
 * Dropping the rule handle instead of releasing it would leave the match
 * pointing at a stub this session no longer answers for.
 *
 * READY does not prove future network liveness. `probe_if_due` is what keeps
 * asking, because os-next closes a socket carrying no APPLICATION message at
 * about a hundred seconds.
 *
 * The state machine is single-owner and callback-driven. At each stage the
 * mount owns only the handles marked by `has_*`; these booleans are the cleanup
 * ledger, not redundant cache. No retry occurs inside the mount because auth
 * rejection, protocol corruption, and transport loss require different outer
 * recovery policy and diagnostics.
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
 * THE SESSION'S OWN LIVENESS, WHICH A WEBSOCKET PING DOES NOT PROVE.
 *
 * os-next closes an idle socket at roughly a hundred seconds and counts
 * APPLICATION messages doing it — its own pager answers that with a thirty
 * second keepalive MESSAGE, not a ping. The transport's quiet-hop PING still
 * runs and still answers a different question (is this TCP hop half-open), and
 * its PONG is what the liveness watchdog keys on, so both stay: on a mounted
 * board this call is what keeps the socket, and the ping is what covers the
 * window before a mount exists.
 *
 * `whoami()` on the project root is the cheapest thing that is a real call: no
 * argument, no storage touched, and `{projectId, path}` back.
 *
 * Unconditional once due rather than only after silence: one call a minute
 * costs less than the state needed to decide it was unnecessary, and a board
 * in a call already sends twenty appends a second.
 */
enum capnweb_status iterate_kit_itx_mount_probe_if_due(
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
