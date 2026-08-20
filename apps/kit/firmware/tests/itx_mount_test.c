#include "iterate/kit/itx_mount.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  TOKEN_CAPACITY = 128,
  CALL_CAPACITY = 8,
  OUTPUT_CAPACITY = 64,
  CAPTURE_CAPACITY = 24,
  MESSAGE_CAPACITY = 2048,
};

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

struct fixture {
  struct capnweb_session session;
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  char captured[CAPTURE_CAPACITY][MESSAGE_CAPACITY];
  size_t captured_lengths[CAPTURE_CAPACITY];
  size_t captured_count;
  bool message_open;
  struct iterate_kit_itx_mount mount;
};

static enum capnweb_status capture_fragment(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct fixture *fixture = context;
  size_t *captured_length;
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (fixture->message_open ||
        fixture->captured_count >= CAPTURE_CAPACITY) {
      return CAPNWEB_E_STATE;
    }
    fixture->message_open = true;
    fixture->captured_lengths[fixture->captured_count] = 0U;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!fixture->message_open || data == NULL || length == 0U) {
      return CAPNWEB_E_STATE;
    }
    captured_length =
        &fixture->captured_lengths[fixture->captured_count];
    if (length >= MESSAGE_CAPACITY ||
        *captured_length >= MESSAGE_CAPACITY - length) {
      return CAPNWEB_E_LIMIT;
    }
    memcpy(
        fixture->captured[fixture->captured_count] + *captured_length,
        data,
        length);
    *captured_length += length;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_END) {
    if (!fixture->message_open) {
      return CAPNWEB_E_STATE;
    }
    captured_length =
        &fixture->captured_lengths[fixture->captured_count];
    fixture->captured[fixture->captured_count][*captured_length] = '\0';
    ++fixture->captured_count;
    fixture->message_open = false;
    return CAPNWEB_OK;
  }
  return CAPNWEB_E_INVALID_ARGUMENT;
}

static enum capnweb_status inert_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  return capnweb_reply_set_null(reply);
}

static void fixture_init(struct fixture *fixture) {
  struct capnweb_session_options options;
  memset(fixture, 0, sizeof(*fixture));
  options = (struct capnweb_session_options){
    {inert_dispatch, fixture, NULL},
    capture_fragment,
    fixture,
    fixture->pending_calls,
    CALL_CAPACITY,
    fixture->exports,
    CALL_CAPACITY,
    fixture->imports,
    CALL_CAPACITY,
    fixture->tokens,
    TOKEN_CAPACITY,
    fixture->output_buffer,
    OUTPUT_CAPACITY,
  };
  assert(capnweb_session_init(&fixture->session, &options) == CAPNWEB_OK);
}

static void start_mount(struct fixture *fixture) {
  const struct iterate_kit_itx_mount_options options = {
    &fixture->session,
    "prj_test",
    "itxk_secret-never-log",
    "/clients/m5stick-s3",
    {inert_dispatch, fixture, NULL},
    "M5StickS3 test device",
    "export interface M5StickS3 { ping(): Promise<void> }",
  };
  assert(
      iterate_kit_itx_mount_start(&fixture->mount, &options) ==
      CAPNWEB_OK);
}

static void receive(struct fixture *fixture, const char *message) {
  assert(
      capnweb_session_receive(
          &fixture->session, message, strlen(message)) ==
      CAPNWEB_OK);
}

/*
 * A production mount authenticates and then connects as a client. Retaining
 * every intermediate remote handle was rejected because fixed Cap'n Web tables
 * would slowly exhaust and obsolete authority would survive longer than
 * needed. This proves each temporary handle is released as ownership advances,
 * that READY retains only the project handle the live provision hangs off,
 * and that a clean close explicitly revokes that final live mount.
 */
static void mounts_and_retains_only_the_project_handle(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_mount(&fixture);

  assert(
      fixture.mount.state ==
      ITERATE_KIT_ITX_MOUNT_AUTHENTICATING);
  assert(fixture.captured_count == 2U);
  assert(strcmp(
      fixture.captured[0],
      "[\"push\",[\"pipeline\",0,[\"authenticate\"],"
      "[{\"type\":\"project-secret\",\"projectId\":\"prj_test\","
      "\"secret\":\"itxk_secret-never-log\"}]]]") == 0);
  assert(strcmp(fixture.captured[1], "[\"pull\",1]") == 0);

  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  /*
   * ONE CALL DOES BOTH. The old chain spent a whole round trip on
   * projects.get before it could provide anything; connecting as a client
   * addresses the project AND provides the capability, so the device is
   * mounted a full trip sooner on every boot and every reconnect.
   */
  assert(
      fixture.mount.state ==
      ITERATE_KIT_ITX_MOUNT_CONNECTING);
  assert(fixture.captured_count == 5U);
  assert(strcmp(fixture.captured[2], "[\"release\",1,1]") == 0);
  assert(strstr(
      fixture.captured[3],
      "[\"push\",[\"pipeline\",-10,[\"projects\",\"connect\"],"
      "[\"prj_test\",{") != NULL);
  /*
   * The client path is a STREAM path, not a capability name: connect mounts
   * the capability at the fixed name `capabilities` on that scope.
   */
  assert(strstr(
      fixture.captured[3],
      "\"path\":\"/clients/m5stick-s3\"") != NULL);
  assert(strstr(
      fixture.captured[3],
      "\"description\":\"M5StickS3 test device\"") != NULL);
  assert(strstr(
      fixture.captured[3],
      "\"capabilities\":[\"export\",-1]") != NULL);
  /*
   * The production capability host cannot replay a nested Cap'n Web proxy as
   * though it were an ordinary JavaScript object: awaiting the intermediate
   * `pushToTalk` member prematurely invokes that incomplete path. The device
   * therefore opts into the host's one-call flattened boundary. Omitting this
   * field previously left top-level diagnostics working while every nested
   * capability failed only after a real production mount.
   */
  assert(strstr(
      fixture.captured[3],
      "\"flattenNestedPaths\":true") != NULL);
  assert(strstr(
      fixture.captured[3],
      "\"types\":\"export interface M5StickS3") != NULL);
  assert(strcmp(fixture.captured[4], "[\"pull\",2]") == 0);

  receive(&fixture, "[\"resolve\",2,[\"export\",-11]]");
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_READY);
  assert(fixture.mount.failure == ITERATE_KIT_ITX_MOUNT_FAILURE_NONE);
  /*
   * READY owns the PROJECT handle now, because connect hangs the provision
   * off it. That inverts the old flow, which kept a provision handle and shed
   * the project — and it is why close must release this one.
   */
  assert(fixture.mount.has_project_capability);
  assert(!fixture.mount.has_session_capability);
  assert(!fixture.mount.has_local_capability);
  assert(fixture.captured_count == 7U);
  assert(strcmp(fixture.captured[5], "[\"release\",2,1]") == 0);
  assert(strcmp(fixture.captured[6], "[\"release\",-10,1]") == 0);

  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_CLOSED);
  assert(fixture.captured_count == 8U);
  assert(strcmp(fixture.captured[7], "[\"release\",-11,1]") == 0);
  capnweb_session_close(&fixture.session);
}

/*
 * A rotated or mistyped project secret cannot heal while the same firmware
 * session keeps retrying it. Automatic mount-level retry was rejected because
 * it would create an authentication storm and obscure a provisioning fault.
 * Rejection is terminal and precisely classified; the outer connection owner
 * alone may later establish a new session with changed credentials.
 */
static void authentication_rejection_is_terminal_and_not_retried(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_mount(&fixture);
  receive(
      &fixture,
      "[\"reject\",1,[\"error\",\"Error\",\"invalid auth\"]]");
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_FAILED);
  assert(
      fixture.mount.failure ==
      ITERATE_KIT_ITX_MOUNT_FAILURE_AUTH_REJECTED);
  assert(fixture.captured_count == 3U);
  assert(strcmp(fixture.captured[2], "[\"release\",1,1]") == 0);
  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  capnweb_session_close(&fixture.session);
}

/*
 * A server or compatibility bug may resolve projects.connect with a
 * non-capability value even though authentication succeeded. Treating the
 * device as mounted was rejected because authority was never established,
 * while abandoning the still-owned session handle would leak an import. The
 * mount records the contract failure and explicit close remains responsible
 * for its release.
 */
static void invalid_connect_result_is_classified_and_releases_session(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_mount(&fixture);
  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(&fixture, "[\"resolve\",2,null]");
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_FAILED);
  assert(
      fixture.mount.failure ==
      ITERATE_KIT_ITX_MOUNT_FAILURE_CONNECT_RESULT);
  assert(fixture.mount.has_session_capability);
  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  assert(strcmp(
      fixture.captured[fixture.captured_count - 1U],
      "[\"release\",-10,1]") == 0);
  capnweb_session_close(&fixture.session);
}

/*
 * The socket can vanish while any asynchronous mount call is outstanding.
 * Retrying inside the mount was rejected because only the outer transport knows
 * whether a fresh WebSocket exists and which generation it belongs to. Session
 * closure must therefore settle the mount as SESSION_ENDED with the original
 * Cap'n Web status and perform no hidden network work.
 */
static void session_end_is_reported_without_retry(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_mount(&fixture);
  capnweb_session_close(&fixture.session);
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_FAILED);
  assert(
      fixture.mount.failure ==
      ITERATE_KIT_ITX_MOUNT_FAILURE_SESSION_ENDED);
  assert(fixture.mount.capnweb_status == CAPNWEB_E_CLOSED);
}

static enum capnweb_status start_with_client_path(
    struct fixture *fixture, const char *client_path) {
  const struct iterate_kit_itx_mount_options options = {
    &fixture->session,
    "prj_test",
    "itxk_secret-never-log",
    client_path,
    {inert_dispatch, fixture, NULL},
    "HAVPE test device",
    NULL,
  };
  fixture_init(fixture);
  return iterate_kit_itx_mount_start(&fixture->mount, &options);
}

/*
 * THE HYPHEN USED TO BE THE BUG, and now it is the point.
 *
 * Capability paths were resolved as JavaScript member names, so a product slug
 * with hyphens survived every local check and then made production reject
 * provideCapability after authentication. A client path is a stream path, and
 * hyphenated device slugs are exactly what belongs in one — this pins that the
 * old guard is gone rather than merely unused, because a stray identifier
 * check here would take the whole HAVPE board off the network again.
 */
static void accepts_a_hyphenated_device_slug(void) {
  struct fixture fixture;
  assert(
      start_with_client_path(
          &fixture, "/clients/home-assistant-voice-preview-edition") ==
      CAPNWEB_OK);
  assert(
      fixture.mount.state ==
      ITERATE_KIT_ITX_MOUNT_AUTHENTICATING);
  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  capnweb_session_close(&fixture.session);
}

/*
 * What IS still refused is refused before any secret-bearing authentication
 * frame leaves the device: `connect` canonicalizes the path and rejects the
 * project root, and the stream layer rejects traversal. A target then fails
 * deterministically during bring-up instead of reconnecting forever to an
 * error that neither Wi-Fi nor retries can heal.
 */
static void rejects_unusable_client_paths_before_network_io(void) {
  static const char *const refused[] = {
    "",                      /* absent */
    "kit/stackchan",         /* not absolute */
    "/",                     /* the project root, which connect refuses */
    "/clients/",             /* empty trailing segment */
    "/clients//stackchan",   /* empty interior segment */
    "/clients/../secrets",   /* traversal, canonicalized away server-side */
    "/clients/stack chan",   /* a label, not a path */
  };
  size_t index;
  for (index = 0U; index < sizeof(refused) / sizeof(refused[0]); ++index) {
    struct fixture fixture;
    assert(
        start_with_client_path(&fixture, refused[index]) ==
        CAPNWEB_E_INVALID_ARGUMENT);
    assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_FAILED);
    assert(
        fixture.mount.failure ==
        ITERATE_KIT_ITX_MOUNT_FAILURE_INVALID_OPTIONS);
    assert(fixture.captured_count == 0U);
    capnweb_session_close(&fixture.session);
  }
}

/* `connect` rejects an empty description, so the device must not send one. */
static void rejects_a_missing_description_before_network_io(void) {
  struct fixture fixture;
  const struct iterate_kit_itx_mount_options options = {
    &fixture.session,
    "prj_test",
    "itxk_secret-never-log",
    "/clients/stackchan",
    {inert_dispatch, &fixture, NULL},
    NULL,
    NULL,
  };
  fixture_init(&fixture);
  assert(
      iterate_kit_itx_mount_start(&fixture.mount, &options) ==
      CAPNWEB_E_INVALID_ARGUMENT);
  assert(
      fixture.mount.failure ==
      ITERATE_KIT_ITX_MOUNT_FAILURE_INVALID_OPTIONS);
  assert(fixture.captured_count == 0U);
  capnweb_session_close(&fixture.session);
}

int main(void) {
  mounts_and_retains_only_the_project_handle();
  authentication_rejection_is_terminal_and_not_retried();
  invalid_connect_result_is_classified_and_releases_session();
  session_end_is_reported_without_retry();
  accepts_a_hyphenated_device_slug();
  rejects_unusable_client_paths_before_network_io();
  rejects_a_missing_description_before_network_io();
  return 0;
}
