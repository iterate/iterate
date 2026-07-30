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
   * Capability paths are tiny semantic names, not arbitrary remote input.
   * A fixed four-element stack workspace keeps provideCapability allocation
   * free; profiles needing deeper trees should mount a subtree capability.
   */
  ITERATE_KIT_ITX_MOUNT_PATH_CAPACITY = 4,
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
  const char *project_id;
  const char *project_api_key;
  const char *const *path;
  size_t path_count;
  struct capnweb_capability capability;
  const char *instructions;
  const char *types;
};

/**
 * One production-shaped live capability mount over an already-open Cap'n Web
 * session. All strings, path entries, the session, and the capability are
 * borrowed for the mount lifetime.
 *
 * The mount performs authenticate(project-secret), projects.get(projectId),
 * and provideCapability(type=live) sequentially. It retains only the returned
 * CapabilityProvision handle while READY; closing or losing the session
 * revokes the live mount.
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
  struct capnweb_remote_capability provision_capability;
  struct capnweb_local_capability local_capability;
  bool has_session_capability;
  bool has_project_capability;
  bool has_provision_capability;
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
