#include "iterate/kit/itx_mount.h"

#include <string.h>

#include "iterate/kit/voice_device_profile.h"

/*
 * The three-call mount and its ownership ledger are documented in itx_mount.h.
 * Collapsing the chain into nested generic helpers or retrying stages in place
 * was rejected: each rejection/result/protocol failure needs a stable,
 * diagnosable class, and retry belongs to a fresh outer connection generation.
 *
 * Callbacks and all mutations run on the Cap'n Web session owner task. Options
 * are borrowed for the mount lifetime; call-expression stack values need live
 * only until capnweb_session_call_expressions returns.
 */
static const char *const authenticate_path[] = {"authenticate"};
static const char *const projects_get_path[] = {"projects", "get"};
static const char *const provide_path[] = {"provide"};
static const char *const whoami_path[] = {"whoami"};

static bool nonempty(const char *value) {
  return value != NULL && value[0] != '\0';
}

/*
 * A profile that forgot to spell its device name as an itx expression must fail
 * before authentication bytes leave the device, rather than become a reconnect
 * loop mislabeled as networking. Its only producer, voice_loop.c, already
 * sanitizes the name into identifier-safe segments, so this bounds the shape
 * and nothing more: rooted at "itx.", within the capacity, no empty
 * segment, and at least one segment past the root.
 */
static bool valid_capability_match(const char *match) {
  size_t index;
  bool at_segment_start = true;
  if (!nonempty(match)) return false;
  if (strncmp(match, "itx.", sizeof("itx.") - 1U) != 0) return false;
  for (index = sizeof("itx.") - 1U; match[index] != '\0'; ++index) {
    if (index >= ITERATE_KIT_ITX_MOUNT_CAPABILITY_MATCH_CAPACITY) return false;
    if (match[index] != '.') {
      at_segment_start = false;
      continue;
    }
    if (at_segment_start) return false;
    at_segment_start = true;
  }
  /* "itx." alone names the whole surface, and a trailing dot names nothing. */
  return !at_segment_start;
}

static bool valid_options(
    const struct iterate_kit_itx_mount_options *options) {
  return options != NULL &&
      options->session != NULL &&
      nonempty(options->project_id) &&
      nonempty(options->project_api_key) &&
      valid_capability_match(options->capability_match) &&
      options->capability.dispatch != NULL;
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
  struct capnweb_expression match;
  struct capnweb_expression capability;
  struct capnweb_expression arguments[2];
  enum capnweb_status status;

  /*
   * Export the device's capability BEFORE the call that carries it. `provide`
   * lends the stub the argument names; there is nothing else the call needs.
   */
  status = capnweb_session_export_capability(
      mount->options.session,
      mount->options.capability,
      &mount->local_capability);
  if (status != CAPNWEB_OK) {
    return fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_CALL, status);
  }
  mount->has_local_capability = true;

  match = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      mount->options.capability_match,
      strlen(mount->options.capability_match),
    }},
  };
  capability = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_CAPABILITY,
    {.capability = mount->local_capability},
  };
  arguments[0] = match;
  arguments[1] = capability;

  mount->state = ITERATE_KIT_ITX_MOUNT_PROVIDING;
  status = capnweb_session_call_expressions(
      mount->options.session,
      mount->project_capability,
      provide_path,
      sizeof(provide_path) / sizeof(provide_path[0]),
      arguments,
      2U,
      provide_completed,
      mount);
  if (status != CAPNWEB_OK) {
    return fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_CALL, status);
  }
  /*
   * The pending call now owns the exported capability reference. Release our
   * temporary local hold immediately instead of holding duplicate ownership
   * for the whole live provision; the RULE handle is what revokes it.
   */
  status = release_local(mount);
  if (status != CAPNWEB_OK) {
    return fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE, status);
  }
  return CAPNWEB_OK;
}

static void project_completed(
    void *context, const struct capnweb_result *result);

static enum capnweb_status begin_get_project(
    struct iterate_kit_itx_mount *mount) {
  struct capnweb_expression project_id;
  enum capnweb_status status;

  project_id = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      mount->options.project_id,
      strlen(mount->options.project_id),
    }},
  };
  mount->state = ITERATE_KIT_ITX_MOUNT_GETTING_PROJECT;
  status = capnweb_session_call_expressions(
      mount->options.session,
      mount->session_capability,
      projects_get_path,
      sizeof(projects_get_path) / sizeof(projects_get_path[0]),
      &project_id,
      1U,
      project_completed,
      mount);
  if (status != CAPNWEB_OK) {
    return fail(
        mount, ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_CALL, status);
  }
  return CAPNWEB_OK;
}

static void authenticated(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_itx_mount *mount = context;
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
  (void)begin_get_project(mount);
}

static void project_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_itx_mount *mount = context;
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
   * THE SESSION IMPORT IS KEPT. It used to be shed here to keep the import
   * table small, but it is what the liveness probe asks: the session's
   * `whoami()` is answered at the edge from the admission gate, whereas the
   * project root's is a call into the project's Durable Object — one that woke
   * it every minute and appended a wake record each time. One more import for
   * the mount's lifetime, released last in close().
   */
  (void)begin_provide(mount);
}

static void provide_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_itx_mount *mount = context;
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
  if (!take_result_capability(result, &mount->rule_capability)) {
    (void)fail(
        mount,
        ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  mount->has_rule_capability = true;
  mount->state = ITERATE_KIT_ITX_MOUNT_READY;
  /*
   * READY means the server returned and we retain the rule handle that owns
   * the live provision; it does not prove future network liveness. The
   * enclosing connection/session must still demote READY immediately on
   * terminal transport state, and `probe_if_due` keeps asking.
   */
  mount->failure = ITERATE_KIT_ITX_MOUNT_FAILURE_NONE;
  mount->capnweb_status = CAPNWEB_OK;
}

enum capnweb_status iterate_kit_itx_mount_start(
    struct iterate_kit_itx_mount *mount,
    const struct iterate_kit_itx_mount_options *options) {
  static const struct capnweb_expression bearer = {
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      "bearer",
      sizeof("bearer") - 1U,
    }},
  };
  struct capnweb_object_field auth_fields[1];
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
   * THE CREDENTIAL ALREADY RODE THE UPGRADE. The blob's key is a personal
   * access token the Kit page minted for the person who set this device up,
   * scoped to this project; the transport sends it as `Authorization: Bearer`
   * and the OS's OAuth gate resolves it before the first frame. This call
   * only asks the session for what that gate resolved, so it carries no
   * secret: `{type: "bearer"}` and nothing else.
   */
  auth_fields[0] = (struct capnweb_object_field){
    {"type", sizeof("type") - 1U},
    &bearer,
  };
  auth = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_OBJECT,
    {.object = {auth_fields, 1U}},
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

static void probe_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_itx_mount *mount = context;
  if (mount == NULL || !mount->probe_pending) {
    return;
  }
  mount->probe_pending = false;
  /*
   * A PROBE IS EVIDENCE, NOT POLICY. An answer proves the session and feeds the
   * liveness watchdog (voice_loop.c); a rejection or a lost session is already
   * the business of the stage that owns recovery, and demoting READY from here
   * would turn one unlucky round trip into a remount.
   */
  if (result->kind == CAPNWEB_RESULT_VALUE &&
      result->status == CAPNWEB_OK &&
      mount->probes_answered < UINT32_MAX) {
    ++mount->probes_answered;
  }
}

bool iterate_kit_itx_mount_probe_if_due(
    struct iterate_kit_itx_mount *mount, uint64_t now_ms) {
  static const char no_arguments[] = "[]";
  enum capnweb_status status;
  if (mount == NULL ||
      mount->state != ITERATE_KIT_ITX_MOUNT_READY ||
      !mount->has_session_capability ||
      mount->probe_pending) {
    return false;
  }
  if (mount->last_probe_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now_ms, mount->last_probe_ms) <
          ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS) {
    return false;
  }
  status = capnweb_session_call_path(
      mount->options.session,
      mount->session_capability,
      whoami_path,
      sizeof(whoami_path) / sizeof(whoami_path[0]),
      no_arguments,
      sizeof(no_arguments) - 1U,
      probe_completed,
      mount);
  /*
   * Stamp the attempt whether or not the call was accepted. A session with no
   * room for one more pending call must not be asked again on the very next
   * tick; the period is the bound on how hard this tries.
   */
  mount->last_probe_ms = now_ms == 0U ? 1U : now_ms;
  if (status != CAPNWEB_OK) return false;
  mount->probe_pending = true;
  if (mount->probes_sent < UINT32_MAX) ++mount->probes_sent;
  return true;
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
  /*
   * The rule handle goes first because it IS the live provision: releasing it
   * un-does the match and recalls the lent stub, which lets the now-empty
   * registry journal the disconnect. Dropping it instead would leave a match
   * naming a stub this session no longer answers for.
   */
  status = release_remote(
      mount,
      &mount->rule_capability,
      &mount->has_rule_capability);
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
      return "project get call failed";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_REJECTED:
      return "project get rejected";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_RESULT:
      return "invalid project get result";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_CALL:
      return "capability provide call failed";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_REJECTED:
      return "capability provide rejected";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_RESULT:
      return "invalid capability provide result";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_RELEASE:
      return "capability release failed";
    case ITERATE_KIT_ITX_MOUNT_FAILURE_SESSION_ENDED:
      return "session ended";
  }
  return "unknown";
}
