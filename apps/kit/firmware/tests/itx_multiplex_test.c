// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

/* One Cap'n Web session owns two stream callbacks and one live-state callback. */
#include "iterate/kit/itx_mount.h"
#include "iterate/kit/stream_subscription.h"
#include "iterate/kit/voice_device_profile.h"

#include <assert.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { TOKENS = 256, CAPTURE = 96, MESSAGE = 4096 };

struct observer {
  uint32_t epoch;
  size_t calls;
  int64_t offset;
  int64_t revision;
  int64_t from;
  int64_t to;
  /* The delivery range a stream push carried as its SECOND argument. */
  int64_t after;
  int64_t through;
  char path[96];
  bool snapshot;
  bool patch;
};

struct fixture {
  struct capnweb_session session;
  struct capnweb_pending_call calls[ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY];
  struct capnweb_export exports[ITERATE_KIT_VOICE_EXPORT_CAPACITY];
  struct capnweb_import imports[ITERATE_KIT_VOICE_IMPORT_CAPACITY];
  struct capnweb_json_token tokens[TOKENS];
  char output[ITERATE_KIT_VOICE_OUTPUT_CAPACITY];
  char sent[CAPTURE][MESSAGE];
  size_t lengths[CAPTURE];
  size_t sent_count;
  bool writing;
  struct iterate_kit_itx_mount mount;
  struct iterate_kit_stream stream_a;
  struct iterate_kit_stream stream_b;
  struct iterate_kit_stream_subscription subscription_a;
  struct iterate_kit_stream_subscription subscription_b;
  struct iterate_kit_stream_subscription live_state;
  struct observer a;
  struct observer b;
  struct observer live;
  int64_t next_callback_result;
};

static enum capnweb_status capture(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct fixture *fixture = context;
  size_t *written;

  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (fixture->writing || fixture->sent_count == CAPTURE) return CAPNWEB_E_STATE;
    fixture->writing = true;
    fixture->lengths[fixture->sent_count] = 0U;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!fixture->writing || data == NULL || length == 0U) return CAPNWEB_E_STATE;
    written = &fixture->lengths[fixture->sent_count];
    if (length >= MESSAGE || *written >= MESSAGE - length) return CAPNWEB_E_LIMIT;
    memcpy(fixture->sent[fixture->sent_count] + *written, data, length);
    *written += length;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_END) {
    if (!fixture->writing) return CAPNWEB_E_STATE;
    fixture->sent[fixture->sent_count][fixture->lengths[fixture->sent_count]] = '\0';
    ++fixture->sent_count;
    fixture->writing = false;
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

static void start_session(struct fixture *fixture) {
  struct capnweb_session_options options;

  memset(&fixture->session, 0, sizeof(fixture->session));
  memset(fixture->calls, 0, sizeof(fixture->calls));
  memset(fixture->exports, 0, sizeof(fixture->exports));
  memset(fixture->imports, 0, sizeof(fixture->imports));
  memset(fixture->tokens, 0, sizeof(fixture->tokens));
  memset(fixture->output, 0, sizeof(fixture->output));
  memset(fixture->sent, 0, sizeof(fixture->sent));
  memset(fixture->lengths, 0, sizeof(fixture->lengths));
  fixture->sent_count = 0U;
  fixture->writing = false;
  options = (struct capnweb_session_options){
    {inert_dispatch, fixture, NULL},
    capture,
    fixture,
    fixture->calls,
    ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY,
    fixture->exports,
    ITERATE_KIT_VOICE_EXPORT_CAPACITY,
    fixture->imports,
    ITERATE_KIT_VOICE_IMPORT_CAPACITY,
    fixture->tokens,
    TOKENS,
    fixture->output,
    sizeof(fixture->output),
  };
  assert(capnweb_session_init(&fixture->session, &options) == CAPNWEB_OK);
  fixture->next_callback_result = 1;
}

static void init(struct fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  start_session(fixture);
}

static void receive(struct fixture *fixture, const char *message) {
  const enum capnweb_status status =
      capnweb_session_receive(&fixture->session, message, strlen(message));
  if (status != CAPNWEB_OK) {
    fprintf(stderr, "receive failed (%d): %s\n", (int)status, message);
  }
  assert(status == CAPNWEB_OK);
}

static size_t exports_used(const struct fixture *fixture) {
  size_t index;
  size_t used = 0U;

  for (index = 0U; index < ITERATE_KIT_VOICE_EXPORT_CAPACITY; ++index) {
    if (fixture->exports[index].occupied) ++used;
  }
  return used;
}

static size_t imports_used(const struct fixture *fixture) {
  size_t index;
  size_t used = 0U;

  for (index = 0U; index < ITERATE_KIT_VOICE_IMPORT_CAPACITY; ++index) {
    if (fixture->imports[index].occupied) ++used;
  }
  return used;
}

static size_t calls_used(const struct fixture *fixture) {
  size_t index;
  size_t used = 0U;

  for (index = 0U; index < ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY; ++index) {
    if (fixture->calls[index].occupied) ++used;
  }
  return used;
}

static size_t messages_with(const struct fixture *fixture, const char *needle) {
  size_t index;
  size_t count = 0U;

  for (index = 0U; index < fixture->sent_count; ++index) {
    if (strstr(fixture->sent[index], needle) != NULL) ++count;
  }
  return count;
}

static const char *latest_with(const struct fixture *fixture, const char *needle) {
  size_t index;

  for (index = fixture->sent_count; index > 0U; --index) {
    if (strstr(fixture->sent[index - 1U], needle) != NULL) {
      return fixture->sent[index - 1U];
    }
  }
  return NULL;
}

static int64_t number_after(const char *message, const char *needle) {
  char *end;
  const char *at = strstr(message, needle);
  long long value;

  assert(at != NULL);
  at += strlen(needle);
  value = strtoll(at, &end, 10);
  assert(end != at);
  return (int64_t)value;
}

static int64_t latest_pull(const struct fixture *fixture) {
  return number_after(latest_with(fixture, "[\"pull\","), "[\"pull\",");
}

static void resolve_latest_pull(struct fixture *fixture, int64_t capability) {
  char message[96];
  const int written = snprintf(
      message,
      sizeof(message),
      "[\"resolve\",%" PRId64 ",[\"export\",%" PRId64 "]]",
      latest_pull(fixture),
      capability);
  assert(written > 0 && (size_t)written < sizeof(message));
  receive(fixture, message);
}

static int64_t callback_from(
    const struct fixture *fixture, const char *open_marker) {
  return number_after(
      latest_with(fixture, open_marker), "\"export\",");
}

static void start_mount(struct fixture *fixture) {
  const struct iterate_kit_itx_mount_options options = {
    .session = &fixture->session,
    .project_id = "prj-voice",
    .project_api_key = "operator-secret-never-log",
    .capability_match = "itx.clients.multiplex_host_test",
    .capability = {inert_dispatch, fixture, NULL},
  };

  assert(iterate_kit_itx_mount_start(&fixture->mount, &options) == CAPNWEB_OK);
  assert(messages_with(fixture, "\"authenticate\"") == 1U);
  resolve_latest_pull(fixture, -101);
  resolve_latest_pull(fixture, -102);
  resolve_latest_pull(fixture, -103);
  assert(fixture->mount.state == ITERATE_KIT_ITX_MOUNT_READY);
  assert(fixture->mount.has_project_capability);
  assert(fixture->mount.project_capability.id == -102);
  assert(fixture->mount.has_rule_capability);
  assert(fixture->mount.rule_capability.id == -103);
  assert(calls_used(fixture) == 0U);
}

/*
 * ONE DISPATCHER, TWO ARGUMENT SHAPES. A stream push arrives as the bare
 * `(events, range)` the OS calls a lent stub with — argument 0 IS the events
 * array — while live state still hands over one state object and no range.
 * Telling them apart on the array, rather than on a field that happened to be
 * in the old batch envelope, is what makes this boundary honest.
 */
static void observe(
    void *owner,
    uint32_t owner_epoch,
    const struct capnweb_value *update,
    const struct capnweb_value *range) {
  struct observer *observer = owner;
  struct capnweb_value value;
  struct capnweb_value events;

  assert(observer != NULL);
  assert(owner_epoch == observer->epoch);
  ++observer->calls;

  if (capnweb_value_get_expression_array(update, &events)) {
    struct capnweb_value event;
    size_t length = 0U;

    assert(range != NULL);
    assert(capnweb_value_object_get(range, "after", &value));
    assert(capnweb_value_get_int64(&value, &observer->after));
    assert(capnweb_value_object_get(range, "through", &value));
    assert(capnweb_value_get_int64(&value, &observer->through));
    assert(capnweb_value_array_at(&events, 0U, &event));
    /* The path now rides the EVENT, which is where an event's identity lives. */
    assert(capnweb_value_object_get(&event, "path", &value));
    assert(capnweb_value_copy_string(
        &value, observer->path, sizeof(observer->path), &length) == CAPNWEB_OK);
    assert(length > 0U);
    assert(capnweb_value_object_get(&event, "offset", &value));
    assert(capnweb_value_get_int64(&value, &observer->offset));
    return;
  }

  assert(range == NULL);
  assert(capnweb_value_object_get(update, "type", &value));
  if (capnweb_value_string_equals(&value, "snapshot")) {
    assert(capnweb_value_object_get(update, "revision", &value));
    assert(capnweb_value_get_int64(&value, &observer->revision));
    observer->snapshot = true;
    return;
  }
  assert(capnweb_value_string_equals(&value, "patch"));
  assert(capnweb_value_object_get(update, "from", &value));
  assert(capnweb_value_get_int64(&value, &observer->from));
  assert(capnweb_value_object_get(update, "to", &value));
  assert(capnweb_value_get_int64(&value, &observer->to));
  observer->patch = true;
}

static void deliver(
    struct fixture *fixture, int64_t callback, const char *payload) {
  char message[MESSAGE];
  int written = snprintf(
      message,
      sizeof(message),
      "[\"push\",[\"pipeline\",%" PRId64 ",[],[%s]]]",
      callback,
      payload);
  assert(written > 0 && (size_t)written < sizeof(message));
  receive(fixture, message);

  written = snprintf(
      message,
      sizeof(message),
      "[\"release\",%" PRId64 ",1]",
      fixture->next_callback_result++);
  assert(written > 0 && (size_t)written < sizeof(message));
  receive(fixture, message);
}

static void release_callback(struct fixture *fixture, int64_t callback) {
  char message[96];
  const int written = snprintf(
      message, sizeof(message), "[\"release\",%" PRId64 ",1]", callback);
  assert(written > 0 && (size_t)written < sizeof(message));
  receive(fixture, message);
}

static void opens_on_one_mounted_session(struct fixture *fixture) {
  static const char *const event_types[] = {
    "events.iterate.com/voice-agent/spk-frame",
  };
  const struct capnweb_remote_capability project =
      fixture->mount.project_capability;

  assert(iterate_kit_stream_get(
      &fixture->stream_a, &fixture->session, project,
      "/agents/voice/v24/multiplex-a") == CAPNWEB_OK);
  resolve_latest_pull(fixture, -201);
  assert(iterate_kit_stream_get(
      &fixture->stream_b, &fixture->session, project,
      "/agents/voice/v24/multiplex-b") == CAPNWEB_OK);
  resolve_latest_pull(fixture, -202);

  fixture->a.epoch = 11U;
  assert(iterate_kit_stream_subscription_open(
      &fixture->subscription_a, &fixture->stream_a, "multiplex-a",
      event_types, sizeof(event_types) / sizeof(event_types[0]), observe, &fixture->a, fixture->a.epoch) == CAPNWEB_OK);
  /* `{name, consumes, target}` — and the CAPABILITY is the target itself. */
  assert(strstr(
      latest_with(fixture, "\"name\":\"multiplex-a\""),
      "[\"subscribe\"]") != NULL);
  assert(strstr(
      latest_with(fixture, "\"name\":\"multiplex-a\""),
      "\"consumes\":[[\"events.iterate.com/voice-agent/spk-frame\"]]") != NULL);
  assert(strstr(
      latest_with(fixture, "\"name\":\"multiplex-a\""),
      "\"target\":[\"export\",") != NULL);
  resolve_latest_pull(fixture, -301);

  fixture->b.epoch = 12U;
  assert(iterate_kit_stream_subscription_open(
      &fixture->subscription_b, &fixture->stream_b, "multiplex-b",
      event_types, sizeof(event_types) / sizeof(event_types[0]), observe, &fixture->b, fixture->b.epoch) == CAPNWEB_OK);
  resolve_latest_pull(fixture, -302);

  fixture->live.epoch = 13U;
  assert(iterate_kit_live_state_subscription_open(
      &fixture->live_state, &fixture->session, project,
      observe, &fixture->live, fixture->live.epoch) == CAPNWEB_OK);
  assert(latest_with(fixture, "[\"liveState\",\"subscribe\"]") != NULL);
  resolve_latest_pull(fixture, -303);

  assert(fixture->subscription_a.state == ITERATE_KIT_SUBSCRIPTION_OPEN);
  assert(fixture->subscription_b.state == ITERATE_KIT_SUBSCRIPTION_OPEN);
  assert(fixture->live_state.state == ITERATE_KIT_SUBSCRIPTION_OPEN);
}

static void multiplexes_and_reclaims(void) {
  struct fixture fixture;
  size_t mounted_exports;
  size_t mounted_imports;
  int64_t callback_a;
  int64_t callback_b;
  int64_t callback_live;

  init(&fixture);
  start_mount(&fixture);
  mounted_exports = exports_used(&fixture);
  mounted_imports = imports_used(&fixture);
  opens_on_one_mounted_session(&fixture);

  callback_a = callback_from(&fixture, "\"name\":\"multiplex-a\"");
  callback_b = callback_from(&fixture, "\"name\":\"multiplex-b\"");
  callback_live = callback_from(&fixture, "[\"liveState\",\"subscribe\"]");
  assert(callback_a < 0 && callback_b < 0 && callback_live < 0);
  assert(callback_a != callback_b);
  assert(callback_a != callback_live);
  assert(callback_b != callback_live);

  /*
   * The mount keeps one export and these independent callbacks add three.
   * Remote stream and subscription handles are opaque IDs retained by their
   * owners; the Cap'n Web import table instead tracks only unresolved outgoing
   * calls and returns to its mount baseline.
   */
  assert(exports_used(&fixture) == mounted_exports + 3U);
  assert(exports_used(&fixture) <= ITERATE_KIT_VOICE_EXPORT_CAPACITY);
  assert(imports_used(&fixture) == mounted_imports);
  assert(calls_used(&fixture) == 0U);
  assert(messages_with(&fixture, "\"authenticate\"") == 1U);
  assert(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);

  deliver(&fixture, callback_a,
      "[[{\"type\":\"events.iterate.test/a\",\"offset\":40,"
      "\"path\":\"/agents/voice/v24/multiplex-a\","
      "\"payload\":{\"round\":1}}]],{\"after\":39,\"through\":40}");
  deliver(&fixture, callback_b,
      "[[{\"type\":\"events.iterate.test/b\",\"offset\":41,"
      "\"path\":\"/agents/voice/v24/multiplex-b\","
      "\"payload\":{\"round\":1}}]],{\"after\":40,\"through\":41}");
  deliver(&fixture, callback_live,
      "{\"type\":\"snapshot\",\"revision\":7,\"state\":{\"active\":true}}");
  deliver(&fixture, callback_live,
      "{\"type\":\"patch\",\"from\":7,\"to\":8,"
      "\"patch\":{\"fields\":{\"active\":{\"set\":false}}}}");

  assert(fixture.a.calls == 1U);
  assert(strcmp(fixture.a.path, "/agents/voice/v24/multiplex-a") == 0);
  assert(fixture.a.offset == 40);
  assert(fixture.a.after == 39 && fixture.a.through == 40);
  assert(fixture.b.calls == 1U);
  assert(strcmp(fixture.b.path, "/agents/voice/v24/multiplex-b") == 0);
  assert(fixture.b.offset == 41);
  assert(fixture.b.after == 40 && fixture.b.through == 41);
  assert(fixture.live.calls == 2U);
  assert(fixture.live.snapshot && fixture.live.patch);
  assert(fixture.live.revision == 7);
  assert(fixture.live.from == 7 && fixture.live.to == 8);

  /*
   * Closing A sends close + releases the handle, but the remote still owns its
   * callback. A late A callback is acknowledged and ignored until that remote
   * reference releases. B and live state continue independently.
   */
  assert(iterate_kit_stream_subscription_close(&fixture.subscription_a) == CAPNWEB_OK);
  {
    const size_t after_first_close = fixture.sent_count;
    assert(iterate_kit_stream_subscription_close(&fixture.subscription_a) == CAPNWEB_OK);
    assert(fixture.sent_count == after_first_close);
  }
  assert(fixture.subscription_a.state == ITERATE_KIT_SUBSCRIPTION_CLOSING);
  deliver(&fixture, callback_a,
      "[[{\"offset\":42,\"path\":\"/agents/voice/v24/multiplex-a\"}]],"
      "{\"after\":41,\"through\":42}");
  assert(fixture.a.calls == 1U);
  deliver(&fixture, callback_b,
      "[[{\"offset\":43,\"path\":\"/agents/voice/v24/multiplex-b\"}]],"
      "{\"after\":42,\"through\":43}");
  assert(fixture.b.calls == 2U);
  deliver(&fixture, callback_live,
      "{\"type\":\"patch\",\"from\":8,\"to\":9,\"patch\":{}}");
  assert(fixture.live.calls == 3U);

  release_callback(&fixture, callback_a);
  assert(fixture.subscription_a.state == ITERATE_KIT_SUBSCRIPTION_CLOSED);
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription_a));

  assert(iterate_kit_stream_subscription_close(&fixture.live_state) == CAPNWEB_OK);
  assert(latest_with(&fixture, "[\"unsubscribe\"]") != NULL);
  release_callback(&fixture, callback_live);
  assert(fixture.live_state.state == ITERATE_KIT_SUBSCRIPTION_CLOSED);
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.live_state));

  deliver(&fixture, callback_b,
      "[[{\"offset\":44,\"path\":\"/agents/voice/v24/multiplex-b\"}]],"
      "{\"after\":43,\"through\":44}");
  assert(fixture.b.calls == 3U);

  assert(iterate_kit_stream_subscription_close(&fixture.subscription_b) == CAPNWEB_OK);
  release_callback(&fixture, callback_b);
  assert(fixture.subscription_b.state == ITERATE_KIT_SUBSCRIPTION_CLOSED);
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription_b));

  assert(iterate_kit_stream_close(&fixture.stream_a) == CAPNWEB_OK);
  assert(iterate_kit_stream_close(&fixture.stream_b) == CAPNWEB_OK);
  assert(iterate_kit_stream_reclaimable(&fixture.stream_a));
  assert(iterate_kit_stream_reclaimable(&fixture.stream_b));
  assert(exports_used(&fixture) == mounted_exports);
  assert(imports_used(&fixture) == mounted_imports);
  assert(calls_used(&fixture) == 0U);
  assert(messages_with(&fixture, "\"authenticate\"") == 1U);
  assert(fixture.mount.state == ITERATE_KIT_ITX_MOUNT_READY);
  assert(fixture.mount.has_project_capability);
  assert(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);
}

static void pending_open_close_waits_for_remote_callback_release(void) {
  static const char *const event_types[] = {
    "events.iterate.com/voice-agent/spk-frame",
  };
  struct fixture fixture;
  int64_t stream_pull;
  int64_t live_pull;
  int64_t callback_stream;
  int64_t callback_live;

  init(&fixture);
  fixture.stream_a = (struct iterate_kit_stream){
    .state = ITERATE_KIT_STREAM_READY,
    .session = &fixture.session,
    .capability = {-401},
    .has_capability = true,
  };
  fixture.a.epoch = 21U;
  assert(iterate_kit_stream_subscription_open(
      &fixture.subscription_a, &fixture.stream_a, "pending-stream",
      event_types, sizeof(event_types) / sizeof(event_types[0]), observe, &fixture.a, fixture.a.epoch) == CAPNWEB_OK);
  stream_pull = latest_pull(&fixture);
  callback_stream = fixture.subscription_a.callback.id;

  fixture.live.epoch = 22U;
  assert(iterate_kit_live_state_subscription_open(
      &fixture.live_state, &fixture.session,
      (struct capnweb_remote_capability){-402},
      observe, &fixture.live, fixture.live.epoch) == CAPNWEB_OK);
  live_pull = latest_pull(&fixture);
  callback_live = fixture.live_state.callback.id;

  assert(iterate_kit_stream_subscription_close(&fixture.subscription_a) == CAPNWEB_OK);
  assert(iterate_kit_stream_subscription_close(&fixture.live_state) == CAPNWEB_OK);
  assert(!iterate_kit_stream_subscription_reclaimable(&fixture.subscription_a));
  assert(!iterate_kit_stream_subscription_reclaimable(&fixture.live_state));

  {
    char message[96];
    int written = snprintf(
        message, sizeof(message),
        "[\"resolve\",%" PRId64 ",[\"export\",-501]]", stream_pull);
    assert(written > 0 && (size_t)written < sizeof(message));
    receive(&fixture, message);
    written = snprintf(
        message, sizeof(message),
        "[\"resolve\",%" PRId64 ",[\"export\",-502]]", live_pull);
    assert(written > 0 && (size_t)written < sizeof(message));
    receive(&fixture, message);
  }

  /*
   * A STREAM SUBSCRIPTION IS CLOSED BY BEING RELEASED. The OS's handle has no
   * `close()`, so calling one would reject — and on this client a rejection is
   * indistinguishable from a network fault. Live state still has `unsubscribe`.
   */
  assert(latest_with(&fixture, "[\"close\"]") == NULL);
  assert(latest_with(&fixture, "[\"unsubscribe\"]") != NULL);
  deliver(&fixture, callback_stream,
      "[[{\"offset\":1,\"path\":\"/agents/voice/v24/pending\"}]],"
      "{\"after\":0,\"through\":1}");
  deliver(&fixture, callback_live,
      "{\"type\":\"snapshot\",\"revision\":1,\"state\":{}}");
  assert(fixture.a.calls == 0U);
  assert(fixture.live.calls == 0U);

  release_callback(&fixture, callback_stream);
  release_callback(&fixture, callback_live);
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription_a));
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.live_state));
  assert(calls_used(&fixture) == 0U);
  assert(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);
}

static void invalid_types_and_export_exhaustion_leave_reclaimable_storage(void) {
  static const char *const event_types[] = {
    "events.iterate.com/voice-agent/spk-frame",
  };
  struct fixture fixture;
  struct capnweb_local_capability fillers[ITERATE_KIT_VOICE_EXPORT_CAPACITY];
  size_t index;

  init(&fixture);
  fixture.stream_a = (struct iterate_kit_stream){
    .state = ITERATE_KIT_STREAM_READY,
    .session = &fixture.session,
    .capability = {-601},
    .has_capability = true,
  };
  {
    const char *const invalid_types[] = {NULL};
    assert(iterate_kit_stream_subscription_open(
        &fixture.subscription_a, &fixture.stream_a, "invalid-types",
        invalid_types, sizeof(invalid_types) / sizeof(invalid_types[0]),
        observe, &fixture.a, 31U) == CAPNWEB_E_INVALID_ARGUMENT);
  }
  assert(exports_used(&fixture) == 0U);
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription_a));

  for (index = 0U; index < ITERATE_KIT_VOICE_EXPORT_CAPACITY; ++index) {
    assert(capnweb_session_export_capability(
        &fixture.session, (struct capnweb_capability){inert_dispatch, &fixture, NULL},
        &fillers[index]) == CAPNWEB_OK);
  }
  assert(exports_used(&fixture) == ITERATE_KIT_VOICE_EXPORT_CAPACITY);
  assert(iterate_kit_stream_subscription_open(
      &fixture.subscription_b, &fixture.stream_a, "exhausted",
      event_types, sizeof(event_types) / sizeof(event_types[0]), observe, &fixture.b, 32U) == CAPNWEB_E_LIMIT);
  assert(fixture.subscription_b.state == ITERATE_KIT_SUBSCRIPTION_FAILED);
  assert(iterate_kit_stream_subscription_close(&fixture.subscription_b) == CAPNWEB_OK);
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription_b));
  assert(exports_used(&fixture) == ITERATE_KIT_VOICE_EXPORT_CAPACITY);

  for (index = 0U; index < ITERATE_KIT_VOICE_EXPORT_CAPACITY; ++index) {
    assert(capnweb_session_release_local_capability(
        &fixture.session, fillers[index]) == CAPNWEB_OK);
  }
  assert(exports_used(&fixture) == 0U);
  assert(calls_used(&fixture) == 0U);
}

static void session_loss_clears_pending_children_before_new_session(void) {
  static const char *const event_types[] = {
    "events.iterate.com/voice-agent/spk-frame",
  };
  struct fixture fixture;

  init(&fixture);
  fixture.stream_a = (struct iterate_kit_stream){
    .state = ITERATE_KIT_STREAM_READY,
    .session = &fixture.session,
    .capability = {-701},
    .has_capability = true,
  };
  fixture.a.epoch = 41U;
  assert(iterate_kit_stream_subscription_open(
      &fixture.subscription_a, &fixture.stream_a, "lost-open",
      event_types, sizeof(event_types) / sizeof(event_types[0]), observe, &fixture.a, fixture.a.epoch) == CAPNWEB_OK);
  assert(iterate_kit_stream_get(
      &fixture.stream_b, &fixture.session,
      (struct capnweb_remote_capability){-702},
      "/agents/voice/v24/lost-get") == CAPNWEB_OK);

  capnweb_session_close(&fixture.session);
  iterate_kit_stream_session_ended(&fixture.stream_b);
  iterate_kit_stream_subscription_session_ended(&fixture.subscription_a);
  assert(iterate_kit_stream_reclaimable(&fixture.stream_b));
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription_a));

  start_session(&fixture);
  assert(iterate_kit_stream_get(
      &fixture.stream_b, &fixture.session,
      (struct capnweb_remote_capability){-703},
      "/agents/voice/v24/new-session") == CAPNWEB_OK);
  assert(strstr(
      latest_with(&fixture, "[\"cd\"]"),
      "-703") != NULL);
  resolve_latest_pull(&fixture, -704);
  fixture.b.epoch = 42U;
  assert(iterate_kit_stream_subscription_open(
      &fixture.subscription_a, &fixture.stream_b, "new-session",
      event_types, sizeof(event_types) / sizeof(event_types[0]), observe, &fixture.b, fixture.b.epoch) == CAPNWEB_OK);
  resolve_latest_pull(&fixture, -705);
  assert(fixture.subscription_a.state == ITERATE_KIT_SUBSCRIPTION_OPEN);
  assert(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);
}

int main(void) {
  multiplexes_and_reclaims();
  pending_open_close_waits_for_remote_callback_release();
  invalid_types_and_export_exhaustion_leave_reclaimable_storage();
  session_loss_clears_pending_children_before_new_session();
  return 0;
}
