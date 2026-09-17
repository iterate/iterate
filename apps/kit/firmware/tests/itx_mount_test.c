#include "iterate/kit/itx_mount.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "iterate/kit/voice_device_profile.h"

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
    /* A BARE SLUG. os-next project ids have no `prj_` prefix. */
    "prj-voice",
    "operator-secret-never-log",
    "itx.clients.m5stick_s3",
    {inert_dispatch, fixture, NULL},
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

/* Drive the whole handshake and leave the mount READY. */
static void mount_to_ready(struct fixture *fixture) {
  fixture_init(fixture);
  start_mount(fixture);
  receive(fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(fixture, "[\"resolve\",2,[\"export\",-11]]");
  receive(fixture, "[\"resolve\",3,[\"export\",-12]]");
  assert(fixture->mount.state == ITERATE_KIT_ITX_MOUNT_READY);
}

/*
 * THE WHOLE HANDSHAKE, LITERALLY. os-next splits what apps/os did in two calls
 * into three, and every one of them changed shape: `authenticate` asks for the
 * session the bearer on the upgrade resolved and carries no secret, `projects.get`
 * is pure addressing with one bare string argument, and lending this device
 * back is `provide(match, stub)` — one front door instead of a `capabilities`
 * field inside `connect`.
 *
 * Retaining every intermediate remote handle was rejected because fixed Cap'n
 * Web tables would slowly exhaust and obsolete authority would survive longer
 * than needed. This proves each temporary PROMISE is released as ownership
 * advances, that READY retains the SESSION (what the liveness probe asks — a
 * `whoami()` the edge answers without waking the project's context), the
 * project root AND the rule handle that is the live provision, and that a
 * clean close revokes the rule, then the project, then the session.
 */
static void mounts_and_retains_the_project_and_the_rule(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_mount(&fixture);

  assert(
      fixture.mount.state ==
      ITERATE_KIT_ITX_MOUNT_AUTHENTICATING);
  assert(fixture.captured_count == 2U);
  /*
   * ONE FIELD AND NO SECRET. The token rode the upgrade as `Authorization:
   * Bearer` and os-next's gate resolved it; this call asks for that session.
   */
  assert(strcmp(
      fixture.captured[0],
      "[\"push\",[\"pipeline\",0,[\"authenticate\"],"
      "[{\"type\":\"bearer\"}]]]") == 0);
  assert(strcmp(fixture.captured[1], "[\"pull\",1]") == 0);

  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  assert(
      fixture.mount.state ==
      ITERATE_KIT_ITX_MOUNT_GETTING_PROJECT);
  assert(fixture.captured_count == 5U);
  assert(strcmp(fixture.captured[2], "[\"release\",1,1]") == 0);
  /* ONE BARE STRING. There is no options object and no `connect`. */
  assert(strcmp(
      fixture.captured[3],
      "[\"push\",[\"pipeline\",-10,[\"projects\",\"get\"],"
      "[\"prj-voice\"]]]") == 0);
  assert(strcmp(fixture.captured[4], "[\"pull\",2]") == 0);

  receive(&fixture, "[\"resolve\",2,[\"export\",-11]]");
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_PROVIDING);
  assert(fixture.mount.has_project_capability);
  assert(fixture.mount.has_session_capability); /* kept: the probe's target */
  assert(fixture.captured_count == 8U);
  assert(strcmp(fixture.captured[5], "[\"release\",2,1]") == 0);
  /*
   * The match and the stub, positionally — and the match is a DOTTED
   * IDENTIFIER expression, which is why a device slug's hyphens are
   * underscores by the time they reach here: the caller writes this name out
   * in JavaScript as `root.clients.m5stick_s3.health()`.
   */
  assert(strcmp(
      fixture.captured[6],
      "[\"push\",[\"pipeline\",-11,[\"provide\"],"
      "[\"itx.clients.m5stick_s3\",[\"export\",-1]]]]") == 0);
  assert(strcmp(fixture.captured[7], "[\"pull\",3]") == 0);

  receive(&fixture, "[\"resolve\",3,[\"export\",-12]]");
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_READY);
  assert(fixture.mount.failure == ITERATE_KIT_ITX_MOUNT_FAILURE_NONE);
  /*
   * READY owns the SESSION (the probe's target), the project root, which
   * everything else is addressed from, and the RULE handle, which is the
   * revocable thing. The local export is already gone: the outgoing call
   * carries its own wire hold.
   */
  assert(fixture.mount.has_session_capability);
  assert(fixture.mount.has_project_capability);
  assert(fixture.mount.has_rule_capability);
  assert(!fixture.mount.has_local_capability);
  assert(fixture.captured_count == 9U);
  assert(strcmp(fixture.captured[8], "[\"release\",3,1]") == 0);

  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_CLOSED);
  assert(fixture.captured_count == 12U);
  /* The rule first: it IS the provision, and dropping it would leave the
   * match naming a stub this session no longer answers for. Then the project,
   * then the session it was addressed from. */
  assert(strcmp(fixture.captured[9], "[\"release\",-12,1]") == 0);
  assert(strcmp(fixture.captured[10], "[\"release\",-11,1]") == 0);
  assert(strcmp(fixture.captured[11], "[\"release\",-10,1]") == 0);
  capnweb_session_close(&fixture.session);
}

/*
 * A rotated or mistyped secret cannot heal while the same firmware session
 * keeps retrying it. Automatic mount-level retry was rejected because it would
 * create an authentication storm and obscure a provisioning fault. Rejection is
 * terminal and precisely classified; the outer connection owner alone may later
 * establish a new session with changed credentials.
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
 * A server or compatibility bug may resolve projects.get with a non-capability
 * value even though authentication succeeded. Treating the device as mounted
 * was rejected because authority was never established, while abandoning the
 * still-owned session handle would leak an import. The mount records the
 * contract failure and explicit close remains responsible for its release.
 */
static void invalid_project_result_is_classified_and_releases_session(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_mount(&fixture);
  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(&fixture, "[\"resolve\",2,null]");
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_FAILED);
  assert(
      fixture.mount.failure ==
      ITERATE_KIT_ITX_MOUNT_FAILURE_PROJECT_RESULT);
  assert(fixture.mount.has_session_capability);
  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  assert(strcmp(
      fixture.captured[fixture.captured_count - 1U],
      "[\"release\",-10,1]") == 0);
  capnweb_session_close(&fixture.session);
}

/*
 * A refused `provide` is its own class. The project is addressable and the
 * credential is good, so retrying authentication would prove nothing and the
 * device would look mis-provisioned; what actually failed is the one act that
 * makes this board reachable, and the project handle it failed on is still
 * owned and must still be released.
 */
static void provide_rejection_is_classified_and_keeps_the_project(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_mount(&fixture);
  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(&fixture, "[\"resolve\",2,[\"export\",-11]]");
  receive(
      &fixture,
      "[\"reject\",3,[\"error\",\"Error\",\"FORBIDDEN\"]]");
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_FAILED);
  assert(
      fixture.mount.failure ==
      ITERATE_KIT_ITX_MOUNT_FAILURE_PROVIDE_REJECTED);
  assert(fixture.mount.has_project_capability);
  assert(!fixture.mount.has_rule_capability);
  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  assert(strcmp(
      fixture.captured[fixture.captured_count - 2U],
      "[\"release\",-11,1]") == 0);
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

static enum capnweb_status start_with_match(
    struct fixture *fixture, const char *capability_match) {
  const struct iterate_kit_itx_mount_options options = {
    &fixture->session,
    "prj-voice",
    "operator-secret-never-log",
    capability_match,
    {inert_dispatch, fixture, NULL},
  };
  fixture_init(fixture);
  return iterate_kit_itx_mount_start(&fixture->mount, &options);
}

/*
 * THE BOARD THE HYPHENS BELONG TO IS STILL THE POINT, and now the answer is
 * different. `projects.connect` took a STREAM path, where a hyphenated product
 * slug is exactly what belongs; `provide` takes an itx EXPRESSION, which the
 * far end writes out in JavaScript, so the same board's name arrives here with
 * underscores. This pins the shape the HAVPE actually flashes.
 */
static void accepts_a_full_length_device_match(void) {
  struct fixture fixture;
  assert(
      start_with_match(
          &fixture, "itx.clients.home_assistant_voice_preview_edition") ==
      CAPNWEB_OK);
  assert(
      fixture.mount.state ==
      ITERATE_KIT_ITX_MOUNT_AUTHENTICATING);
  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  capnweb_session_close(&fixture.session);
}

/*
 * What IS refused is refused before any secret-bearing authentication frame
 * leaves the device. A match the server's codec cannot canonicalize, or one no
 * caller can spell at a JavaScript call site, fails deterministically during
 * bring-up instead of reconnecting forever to an error that neither Wi-Fi nor
 * retries can heal.
 */
static void rejects_unusable_capability_matches_before_network_io(void) {
  static const char *const refused[] = {
    "",                            /* absent */
    "clients.stackchan",           /* not rooted at the itx surface */
    "itx.",                        /* the whole surface, which is not a device */
    "itx.clients.",                /* a trailing dot names nothing */
    "itx..clients",                /* an empty interior segment */
  };
  size_t index;
  for (index = 0U; index < sizeof(refused) / sizeof(refused[0]); ++index) {
    struct fixture fixture;
    assert(
        start_with_match(&fixture, refused[index]) ==
        CAPNWEB_E_INVALID_ARGUMENT);
    assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_FAILED);
    assert(
        fixture.mount.failure ==
        ITERATE_KIT_ITX_MOUNT_FAILURE_INVALID_OPTIONS);
    assert(fixture.captured_count == 0U);
    capnweb_session_close(&fixture.session);
  }
}

/*
 * ONE AT A TIME AND ONCE A PERIOD, because the failure this must not become is
 * a probe every tick against a session with no room for one — which is how a
 * liveness fix becomes the outage. Why it probes at all: voice_device_profile.h.
 * AND ON THE SESSION, NOT THE PROJECT: the session's `whoami()` is answered at
 * the edge from the admission gate; the project's is a call into its Durable
 * Object, which a device parked on it woke once a minute, appending a wake
 * record to the project's log each time.
 */
static void probes_the_session_once_a_period_and_one_at_a_time(void) {
  struct fixture fixture;
  size_t after_ready;
  mount_to_ready(&fixture);
  after_ready = fixture.captured_count;

  /* The first probe is due immediately: nothing has proved this session yet. */
  assert(iterate_kit_itx_mount_probe_if_due(&fixture.mount, 1000U));
  assert(fixture.mount.probes_sent == 1U);
  assert(fixture.mount.probe_pending);
  assert(fixture.captured_count == after_ready + 2U);
  assert(strcmp(
      fixture.captured[after_ready],
      "[\"push\",[\"pipeline\",-10,[\"whoami\"],[]]]") == 0);
  assert(strcmp(fixture.captured[after_ready + 1U], "[\"pull\",4]") == 0);

  /* Not again while one is in flight, and not again inside the period. */
  assert(!iterate_kit_itx_mount_probe_if_due(&fixture.mount, 1001U));
  receive(&fixture, "[\"resolve\",4,{\"kind\":\"user\",\"id\":\"usr-kit\"}]");
  assert(!fixture.mount.probe_pending);
  assert(fixture.mount.probes_answered == 1U);
  assert(!iterate_kit_itx_mount_probe_if_due(
      &fixture.mount, 1000U + ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS - 1U));
  assert(fixture.mount.probes_sent == 1U);

  /* And again as soon as the period has run. */
  assert(iterate_kit_itx_mount_probe_if_due(
      &fixture.mount, 1000U + ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS));
  assert(fixture.mount.probes_sent == 2U);
  capnweb_session_close(&fixture.session);
}

/* A mount that is not READY has no session to ask, and asking anyway would be
 * a call on a zero capability. */
static void refuses_to_probe_before_ready(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_mount(&fixture);
  assert(!iterate_kit_itx_mount_probe_if_due(&fixture.mount, 1000U));
  assert(fixture.mount.probes_sent == 0U);
  assert(fixture.captured_count == 2U);
  assert(iterate_kit_itx_mount_close(&fixture.mount) == CAPNWEB_OK);
  capnweb_session_close(&fixture.session);
}

int main(void) {
  mounts_and_retains_the_project_and_the_rule();
  authentication_rejection_is_terminal_and_not_retried();
  invalid_project_result_is_classified_and_releases_session();
  provide_rejection_is_classified_and_keeps_the_project();
  session_end_is_reported_without_retry();
  accepts_a_full_length_device_match();
  rejects_unusable_capability_matches_before_network_io();
  probes_the_session_once_a_period_and_one_at_a_time();
  refuses_to_probe_before_ready();
  return 0;
}
