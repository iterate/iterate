#ifndef ITERATE_KIT_ITX_MOUNT_H
#define ITERATE_KIT_ITX_MOUNT_H

#include <stdbool.h>
#include <stddef.h>

#include "capnweb/capnweb.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * A client path is remote-facing configuration, not arbitrary input: it
   * names one device in one project. Bounding it here keeps validation and
   * the call expression allocation free, and rejects a runaway profile string
   * before it can become a reconnect loop.
   */
  ITERATE_KIT_ITX_MOUNT_CLIENT_PATH_CAPACITY = 96,
};

enum iterate_kit_itx_mount_state {
  ITERATE_KIT_ITX_MOUNT_IDLE = 0,
  ITERATE_KIT_ITX_MOUNT_AUTHENTICATING,
  ITERATE_KIT_ITX_MOUNT_CONNECTING,
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
  ITERATE_KIT_ITX_MOUNT_FAILURE_CONNECT_CALL,
  ITERATE_KIT_ITX_MOUNT_FAILURE_CONNECT_REJECTED,
  ITERATE_KIT_ITX_MOUNT_FAILURE_CONNECT_RESULT,
  ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE,
  ITERATE_KIT_ITX_MOUNT_FAILURE_SESSION_ENDED,
};

struct iterate_kit_itx_mount_options {
  struct capnweb_session *session;
  const char *project_id;
  const char *project_api_key;
  /**
   * This device's identity as a project CLIENT: an absolute stream path, e.g.
   * "/clients/stackchan".
   *
   * Not a capability name. `projects.connect` mounts the capability at the
   * fixed name `capabilities` on this scope, so callers reach the device as
   * `itx.clients.get("/clients/stackchan").capabilities.servos.move(...)`.
   * Encode anything that distinguishes two boards of the same model — a
   * serial, a room — in the path.
   */
  const char *client_path;
  struct capnweb_capability capability;
  /** Human label for this client; journals as the provision's instructions. */
  const char *description;
  const char *types;
};

/**
 * One production-shaped live capability mount over an already-open Cap'n Web
 * session. All strings, the session, and the capability are borrowed for the
 * mount lifetime.
 *
 * The mount performs authenticate(project-secret) then
 * projects.connect(projectId, {path, description, capabilities}) — TWO round
 * trips, not three. Connecting as a client is what provides the capability, so
 * there is no separate provideCapability stage to wait for; the saved trip is
 * on the boot and reconnect path of every board.
 *
 * WHAT READY OWNS CHANGED WITH IT. `connect` hands back the project itx and
 * hangs the provision off it as an owned disposable, so the PROJECT capability
 * is now the live mount's lifetime — releasing it revokes the mount, and
 * dropping it instead of releasing it would strand the mount as a zombie. That
 * is the inverse of the old flow, which kept a provision handle and shed the
 * project.
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
  struct capnweb_local_capability local_capability;
  bool has_session_capability;
  bool has_project_capability;
  bool has_local_capability;
};

enum capnweb_status iterate_kit_itx_mount_start(
    struct iterate_kit_itx_mount *mount,
    const struct iterate_kit_itx_mount_options *options);

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
