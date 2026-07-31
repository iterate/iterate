#include "iterate/kit/itx_mount.h"

#include <string.h>

/*
 * Mounting is a small asynchronous ownership state machine:
 *
 *   bootstrap.authenticate(project-secret)
 *     -> authenticated session capability
 *     -> projects.get(projectId)
 *     -> project capability
 *     -> provideCapability(type=live, local capability)
 *     -> CapabilityProvision handle
 *
 * Only the provision handle remains remotely owned in READY. Every `has_*`
 * flag is an ownership ledger used by both success transitions and cleanup.
 * Collapsing the chain into nested generic helpers or retrying stages in place
 * was rejected: each rejection/result/protocol failure needs a stable,
 * diagnosable class, and retry belongs to a fresh outer connection generation.
 *
 * Callbacks and all mutations run on the Cap'n Web session owner task. Options
 * are borrowed for the mount lifetime; call-expression stack values need live
 * only until capnweb_session_call_expressions returns.
 */
static const char *const authenticate_path[] = {"authenticate"};
static const char *const project_path[] = {"projects", "get"};
static const char *const provide_path[] = {"provideCapability"};

static bool nonempty(const char *value) {
  return value != NULL && value[0] != '\0';
}

static bool valid_options(
    const struct iterate_kit_itx_mount_options *options) {
  size_t index;
  if (options == NULL ||
      options->session == NULL ||
      !nonempty(options->project_id) ||
      !nonempty(options->project_api_key) ||
      options->path == NULL ||
      options->path_count == 0U ||
      options->path_count > ITERATE_KIT_ITX_MOUNT_PATH_CAPACITY ||
      options->capability.dispatch == NULL) {
    return false;
  }
  for (index = 0U; index < options->path_count; ++index) {
    if (!nonempty(options->path[index])) {
      return false;
    }
  }
  return true;
}

static enum capnweb_status fail(
    struct iterate_kit_itx_mount *mount,
    enum iterate_kit_itx_mount_failure failure,
    enum capnweb_status status) {
  /*
   * Preserve both semantic stage and low-level Cap'n Web status. A rejection
   * legitimately has CAPNWEB_OK transport status, while malformed results and
   * send failures carry protocol/transport codes; neither dimension alone is
   * enough for recovery policy.
   */
  mount->state = ITERATE_KIT_ITX_MOUNT_FAILED;
  mount->failure = failure;
  mount->capnweb_status = status;
  return status;
}

static enum capnweb_status release_remote(
    struct iterate_kit_itx_mount *mount,
    struct capnweb_remote_capability *capability,
    bool *owned) {
  enum capnweb_status status;
  if (!*owned) {
    return CAPNWEB_OK;
  }
  /*
   * Clear ownership only after the release is accepted. On failure cleanup may
   * retry/close the whole session while the ledger still truthfully says this
   * mount owns the handle.
   */
  status = capnweb_session_release_remote(
      mount->options.session, *capability);
  if (status == CAPNWEB_OK) {
    *owned = false;
  }
  return status;
}

static enum capnweb_status release_local(
    struct iterate_kit_itx_mount *mount) {
  enum capnweb_status status;
  if (!mount->has_local_capability) {
    return CAPNWEB_OK;
  }
  status = capnweb_session_release_local_capability(
      mount->options.session, mount->local_capability);
  if (status == CAPNWEB_OK) {
    mount->has_local_capability = false;
  }
  return status;
}

static bool take_result_capability(
    const struct capnweb_result *result,
    struct capnweb_remote_capability *capability) {
  return result->kind == CAPNWEB_RESULT_VALUE &&
      result->status == CAPNWEB_OK &&
      capnweb_value_get_remote_capability(
          &result->value, capability);
}

static void provide_completed(
    void *context, const struct capnweb_result *result);

static enum capnweb_status begin_provide(
    struct iterate_kit_itx_mount *mount) {
  static const struct capnweb_expression live = {
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"live", sizeof("live") - 1U}},
  };
  static const struct capnweb_expression flatten_nested_paths = {
    CAPNWEB_EXPRESSION_BOOLEAN,
    {.boolean = true},
  };
  struct capnweb_expression
      path_items[ITERATE_KIT_ITX_MOUNT_PATH_CAPACITY];
  struct capnweb_expression path;
  struct capnweb_expression capability;
  struct capnweb_expression instructions;
  struct capnweb_expression types;
  struct capnweb_object_field fields[6];
  struct capnweb_expression argument;
  size_t field_count = 0U;
  size_t index;
  enum capnweb_status status;

  memset(path_items, 0, sizeof(path_items));
  /*
   * The four-item fixed workspace is the reason paths are bounded in the
   * public API. A VLA/heap array would make a control-plane call consume
   * unreviewed stack/RAM based on profile data.
   */
  for (index = 0U; index < mount->options.path_count; ++index) {
    path_items[index] = (struct capnweb_expression){
      CAPNWEB_EXPRESSION_STRING,
      {.string = {
        mount->options.path[index],
        strlen(mount->options.path[index]),
      }},
    };
  }
  path = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_ARRAY,
    {.array = {path_items, mount->options.path_count}},
  };
  capability = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_CAPABILITY,
    {.capability = mount->local_capability},
  };
  fields[field_count++] = (struct capnweb_object_field){
    {"type", sizeof("type") - 1U},
    &live,
  };
  fields[field_count++] = (struct capnweb_object_field){
    {"path", sizeof("path") - 1U},
    &path,
  };
  fields[field_count++] = (struct capnweb_object_field){
    {"capability", sizeof("capability") - 1U},
    &capability,
  };
  /*
   * An exported Cap'n Web capability is a path-building proxy, not a material
   * JavaScript object tree. The capability host's ordinary nested replay
   * awaits each intermediate member; awaiting `pushToTalk` would therefore
   * issue an incomplete remote call before it ever reaches `start`. Ask the
   * host to preserve the complete dotted path as one invocation envelope. The
   * peer unwraps that envelope allocation-free into its existing static method
   * table, so this compatibility boundary adds no queue or realtime work.
   */
  fields[field_count++] = (struct capnweb_object_field){
    {"flattenNestedPaths", sizeof("flattenNestedPaths") - 1U},
    &flatten_nested_paths,
  };
  if (mount->options.instructions != NULL) {
    instructions = (struct capnweb_expression){
      CAPNWEB_EXPRESSION_STRING,
      {.string = {
        mount->options.instructions,
        strlen(mount->options.instructions),
      }},
    };
    fields[field_count++] = (struct capnweb_object_field){
      {"instructions", sizeof("instructions") - 1U},
      &instructions,
    };
  }
  if (mount->options.types != NULL) {
    types = (struct capnweb_expression){
      CAPNWEB_EXPRESSION_STRING,
      {.string = {
        mount->options.types,
        strlen(mount->options.types),
      }},
    };
    fields[field_count++] = (struct capnweb_object_field){
      {"types", sizeof("types") - 1U},
      &types,
    };
  }
  argument = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_OBJECT,
    {.object = {fields, field_count}},
  };

  mount->state = ITERATE_KIT_ITX_MOUNT_PROVIDING;
  status = capnweb_session_call_expressions(
      mount->options.session,
      mount->project_capability,
      provide_path,
      sizeof(provide_path) / sizeof(provide_path[0]),
      &argument,
      1U,
      provide_completed,
      mount);
  if (status != CAPNWEB_OK) {
    return fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_CALL, status);
  }
  /*
   * The pending call now owns the exported capability reference. Release our
   * temporary local export immediately instead of holding duplicate ownership
   * for the entire live provision. The returned provision capability is the
   * durable revocation handle.
   */
  status = release_local(mount);
  if (status != CAPNWEB_OK) {
    return fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE, status);
  }
  return CAPNWEB_OK;
}

static void project_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_itx_mount *mount = context;
  enum capnweb_status status;
  if (mount->state == ITERATE_KIT_ITX_MOUNT_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_REJECTED,
        CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(
          result, &mount->project_capability)) {
    /*
     * A successful-looking reply of the wrong shape is protocol corruption,
     * not an absent project. Do not coerce it to a generic rejection or
     * continue with an invalid zero capability.
     */
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  mount->has_project_capability = true;
  /*
   * Each transition sheds the prior remote handle before acquiring more state.
   * Keeping session and project imports until final READY would raise bounded
   * import requirements and complicate cleanup without adding capability.
   */
  status = release_remote(
      mount,
      &mount->session_capability,
      &mount->has_session_capability);
  if (status != CAPNWEB_OK) {
    (void)fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE, status);
    return;
  }
  status = capnweb_session_export_capability(
      mount->options.session,
      mount->options.capability,
      &mount->local_capability);
  if (status != CAPNWEB_OK) {
    (void)fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_CALL, status);
    return;
  }
  mount->has_local_capability = true;
  (void)begin_provide(mount);
}

static void authenticated(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_itx_mount *mount = context;
  struct capnweb_expression project_id;
  enum capnweb_status status;
  if (mount->state == ITERATE_KIT_ITX_MOUNT_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_REJECTED,
        CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(
          result, &mount->session_capability)) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  mount->has_session_capability = true;
  project_id = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      mount->options.project_id,
      strlen(mount->options.project_id),
    }},
  };
  mount->state = ITERATE_KIT_ITX_MOUNT_GETTING_PROJECT;
  /*
   * Requests are sequential by design. Pipelining project lookup/provision
   * cannot begin without prior handles and would make stage-specific failures
   * and ownership much harder to prove for no latency benefit at boot scale.
   */
  status = capnweb_session_call_expressions(
      mount->options.session,
      mount->session_capability,
      project_path,
      sizeof(project_path) / sizeof(project_path[0]),
      &project_id,
      1U,
      project_completed,
      mount);
  if (status != CAPNWEB_OK) {
    (void)fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_CALL, status);
  }
}

static void provide_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_itx_mount *mount = context;
  enum capnweb_status status;
  if (mount->state == ITERATE_KIT_ITX_MOUNT_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_REJECTED,
        CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(
          result, &mount->provision_capability)) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  mount->has_provision_capability = true;
  status = release_remote(
      mount,
      &mount->project_capability,
      &mount->has_project_capability);
  if (status != CAPNWEB_OK) {
    (void)fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE, status);
    return;
  }
  mount->state = ITERATE_KIT_ITX_MOUNT_READY;
  /*
   * READY means the server returned and we retain a provision capability; it
   * does not prove future network liveness. The enclosing connection/session
   * must still demote READY immediately on terminal transport state.
   */
  mount->failure = ITERATE_KIT_ITX_MOUNT_FAILURE_NONE;
  mount->capnweb_status = CAPNWEB_OK;
}

enum capnweb_status iterate_kit_itx_mount_start(
    struct iterate_kit_itx_mount *mount,
    const struct iterate_kit_itx_mount_options *options) {
  static const struct capnweb_expression project_secret = {
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      "project-secret",
      sizeof("project-secret") - 1U,
    }},
  };
  struct capnweb_expression project_id;
  struct capnweb_expression secret;
  struct capnweb_object_field auth_fields[3];
  struct capnweb_expression auth;
  enum capnweb_status status;

  if (mount == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(mount, 0, sizeof(*mount));
  if (!valid_options(options)) {
    mount->state = ITERATE_KIT_ITX_MOUNT_FAILED;
    mount->failure =
        ITERATE_KIT_ITX_MOUNT_FAILURE_INVALID_OPTIONS;
    mount->capnweb_status = CAPNWEB_E_INVALID_ARGUMENT;
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  mount->options = *options;
  mount->state = ITERATE_KIT_ITX_MOUNT_AUTHENTICATING;
  /*
   * Project-secret auth is the agreed MVP bootstrap contract. Keeping the auth
   * object construction isolated here makes the future device-scoped OAuth
   * substitution explicit; it must not be mistaken for a permanent credential
   * or silently fall back to another auth mechanism.
   */
  project_id = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {options->project_id, strlen(options->project_id)}},
  };
  secret = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      options->project_api_key,
      strlen(options->project_api_key),
    }},
  };
  auth_fields[0] = (struct capnweb_object_field){
    {"type", sizeof("type") - 1U},
    &project_secret,
  };
  auth_fields[1] = (struct capnweb_object_field){
    {"projectId", sizeof("projectId") - 1U},
    &project_id,
  };
  auth_fields[2] = (struct capnweb_object_field){
    {"secret", sizeof("secret") - 1U},
    &secret,
  };
  auth = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_OBJECT,
    {.object = {auth_fields, 3U}},
  };
  status = capnweb_session_call_expressions(
      options->session,
      (struct capnweb_remote_capability){0},
      authenticate_path,
      sizeof(authenticate_path) / sizeof(authenticate_path[0]),
      &auth,
      1U,
      authenticated,
      mount);
  if (status != CAPNWEB_OK) {
    return fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_CALL, status);
  }
  return CAPNWEB_OK;
}

enum capnweb_status iterate_kit_itx_mount_close(
    struct iterate_kit_itx_mount *mount) {
  enum capnweb_status first_error = CAPNWEB_OK;
  enum capnweb_status status;
  if (mount == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (mount->state == ITERATE_KIT_ITX_MOUNT_CLOSED) {
    return CAPNWEB_OK;
  }
  /*
   * Attempt every owned release even after one fails. `first_error` preserves
   * the causal result for diagnostics while later attempts minimize leaked
   * handles before the enclosing session is unconditionally closed.
   */
  status = release_remote(
      mount,
      &mount->provision_capability,
      &mount->has_provision_capability);
  if (status != CAPNWEB_OK) {
    first_error = status;
  }
  status = release_remote(
      mount,
      &mount->project_capability,
      &mount->has_project_capability);
  if (first_error == CAPNWEB_OK && status != CAPNWEB_OK) {
    first_error = status;
  }
  status = release_remote(
      mount,
      &mount->session_capability,
      &mount->has_session_capability);
  if (first_error == CAPNWEB_OK && status != CAPNWEB_OK) {
    first_error = status;
  }
  status = release_local(mount);
  if (first_error == CAPNWEB_OK && status != CAPNWEB_OK) {
    first_error = status;
  }
  mount->state = ITERATE_KIT_ITX_MOUNT_CLOSED;
  if (first_error != CAPNWEB_OK) {
    mount->failure = ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE;
    mount->capnweb_status = first_error;
  }
  return first_error;
}

const char *iterate_kit_itx_mount_state_name(
    enum iterate_kit_itx_mount_state state) {
  switch (state) {
    case ITERATE_KIT_ITX_MOUNT_IDLE:
      return "idle";
    case ITERATE_KIT_ITX_MOUNT_AUTHENTICATING:
      return "authenticating";
    case ITERATE_KIT_ITX_MOUNT_GETTING_PROJECT:
      return "getting project";
    case ITERATE_KIT_ITX_MOUNT_PROVIDING:
      return "providing capability";
    case ITERATE_KIT_ITX_MOUNT_READY:
      return "ready";
    case ITERATE_KIT_ITX_MOUNT_FAILED:
      return "failed";
    case ITERATE_KIT_ITX_MOUNT_CLOSED:
      return "closed";
  }
  return "unknown";
}

const char *iterate_kit_itx_mount_failure_name(
    enum iterate_kit_itx_mount_failure failure) {
  switch (failure) {
    case ITERATE_KIT_ITX_MOUNT_FAILURE_NONE:
      return "none";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_INVALID_OPTIONS:
      return "invalid options";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_CALL:
      return "authentication call failed";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_REJECTED:
      return "authentication rejected";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_RESULT:
      return "invalid authentication result";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_CALL:
      return "project lookup call failed";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_REJECTED:
      return "project lookup rejected";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_RESULT:
      return "invalid project lookup result";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_CALL:
      return "capability provision call failed";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_REJECTED:
      return "capability provision rejected";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_RESULT:
      return "invalid capability provision result";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE:
      return "capability release failed";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_SESSION_ENDED:
      return "session ended";
  }
  return "unknown";
}
