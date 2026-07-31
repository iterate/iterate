// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "iterate/kit/voicelab_stream.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char *const authenticate_path[] = {"authenticate"};
static const char *const streams_get_path[] = {"streams", "get"};
static const char *const project_path[] = {"projects", "get"};
static const char *const append_path[] = {"append"};

static bool nonempty(const char *value) {
  return value != NULL && value[0] != '\0';
}

static bool valid_options(
    const struct iterate_kit_voicelab_options *options) {
  return options != NULL &&
      options->session != NULL &&
      nonempty(options->project_id) &&
      nonempty(options->project_api_key) &&
      nonempty(options->stream_path) &&
      nonempty(options->call_id) &&
      options->now_ms != NULL;
}

static enum capnweb_status fail(
    struct iterate_kit_voicelab *voicelab,
    enum iterate_kit_voicelab_failure failure,
    enum capnweb_status status) {
  voicelab->state = ITERATE_KIT_VOICELAB_FAILED;
  voicelab->failure = failure;
  voicelab->capnweb_status = status;
  return status;
}

static enum capnweb_status release_remote(
    struct iterate_kit_voicelab *voicelab,
    struct capnweb_remote_capability *capability,
    bool *owned) {
  enum capnweb_status status;
  if (!*owned) {
    return CAPNWEB_OK;
  }
  status = capnweb_session_release_remote(
      voicelab->options.session, *capability);
  if (status == CAPNWEB_OK) {
    *owned = false;
  }
  return status;
}

static bool take_result_capability(
    const struct capnweb_result *result,
    struct capnweb_remote_capability *capability) {
  return result->kind == CAPNWEB_RESULT_VALUE &&
      result->status == CAPNWEB_OK &&
      capnweb_value_get_remote_capability(&result->value, capability);
}

/* --- base64 (RFC 4648, unpadded — matches the vendored writer) ---------- */

static const char base64_alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64_encode(
    const uint8_t *bytes,
    size_t byte_count,
    char *destination,
    size_t destination_capacity) {
  size_t out = 0U;
  size_t index = 0U;
  while (index + 3U <= byte_count) {
    uint32_t chunk = ((uint32_t)bytes[index] << 16) |
        ((uint32_t)bytes[index + 1U] << 8) |
        (uint32_t)bytes[index + 2U];
    if (out + 4U > destination_capacity) {
      return 0U;
    }
    destination[out++] = base64_alphabet[(chunk >> 18) & 0x3fU];
    destination[out++] = base64_alphabet[(chunk >> 12) & 0x3fU];
    destination[out++] = base64_alphabet[(chunk >> 6) & 0x3fU];
    destination[out++] = base64_alphabet[chunk & 0x3fU];
    index += 3U;
  }
  if (index < byte_count) {
    uint32_t chunk = (uint32_t)bytes[index] << 16;
    size_t remainder = byte_count - index;
    if (remainder == 2U) {
      chunk |= (uint32_t)bytes[index + 1U] << 8;
    }
    if (out + (remainder == 2U ? 3U : 2U) > destination_capacity) {
      return 0U;
    }
    destination[out++] = base64_alphabet[(chunk >> 18) & 0x3fU];
    destination[out++] = base64_alphabet[(chunk >> 12) & 0x3fU];
    if (remainder == 2U) {
      destination[out++] = base64_alphabet[(chunk >> 6) & 0x3fU];
    }
  }
  return out;
}

/* --- mount-to-stream state machine --------------------------------------- */

static void stream_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  enum capnweb_status status;
  if (voicelab->state == ITERATE_KIT_VOICELAB_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        voicelab, ITERATE_KIT_VOICELAB_FAILURE_STREAM_REJECTED, CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(result, &voicelab->stream_capability)) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_STREAM_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  voicelab->has_stream_capability = true;
  status = release_remote(
      voicelab,
      &voicelab->project_capability,
      &voicelab->has_project_capability);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_RELEASE, status);
    return;
  }
  voicelab->state = ITERATE_KIT_VOICELAB_READY;
  voicelab->failure = ITERATE_KIT_VOICELAB_FAILURE_NONE;
  voicelab->capnweb_status = CAPNWEB_OK;
}

static void project_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  struct capnweb_expression stream_path;
  enum capnweb_status status;
  if (voicelab->state == ITERATE_KIT_VOICELAB_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        voicelab, ITERATE_KIT_VOICELAB_FAILURE_PROJECT_REJECTED, CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(result, &voicelab->project_capability)) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_PROJECT_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  voicelab->has_project_capability = true;
  status = release_remote(
      voicelab,
      &voicelab->session_capability,
      &voicelab->has_session_capability);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_RELEASE, status);
    return;
  }
  stream_path = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      voicelab->options.stream_path,
      strlen(voicelab->options.stream_path),
    }},
  };
  voicelab->state = ITERATE_KIT_VOICELAB_GETTING_STREAM;
  status = capnweb_session_call_expressions(
      voicelab->options.session,
      voicelab->project_capability,
      streams_get_path,
      sizeof(streams_get_path) / sizeof(streams_get_path[0]),
      &stream_path,
      1U,
      stream_completed,
      voicelab);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_STREAM_CALL, status);
  }
}

static void authenticated(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  struct capnweb_expression project_id;
  enum capnweb_status status;
  if (voicelab->state == ITERATE_KIT_VOICELAB_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        voicelab, ITERATE_KIT_VOICELAB_FAILURE_AUTH_REJECTED, CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(result, &voicelab->session_capability)) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_AUTH_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  voicelab->has_session_capability = true;
  project_id = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      voicelab->options.project_id,
      strlen(voicelab->options.project_id),
    }},
  };
  voicelab->state = ITERATE_KIT_VOICELAB_GETTING_PROJECT;
  status = capnweb_session_call_expressions(
      voicelab->options.session,
      voicelab->session_capability,
      project_path,
      sizeof(project_path) / sizeof(project_path[0]),
      &project_id,
      1U,
      project_completed,
      voicelab);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_PROJECT_CALL, status);
  }
}

enum capnweb_status iterate_kit_voicelab_start(
    struct iterate_kit_voicelab *voicelab,
    const struct iterate_kit_voicelab_options *options) {
  static const struct capnweb_expression project_secret = {
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"project-secret", sizeof("project-secret") - 1U}},
  };
  struct capnweb_expression project_id;
  struct capnweb_expression secret;
  struct capnweb_object_field auth_fields[3];
  struct capnweb_expression auth;
  enum capnweb_status status;

  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(voicelab, 0, sizeof(*voicelab));
  if (!valid_options(options)) {
    voicelab->state = ITERATE_KIT_VOICELAB_FAILED;
    voicelab->failure = ITERATE_KIT_VOICELAB_FAILURE_INVALID_OPTIONS;
    voicelab->capnweb_status = CAPNWEB_E_INVALID_ARGUMENT;
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  voicelab->options = *options;
  voicelab->state = ITERATE_KIT_VOICELAB_AUTHENTICATING;
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
      voicelab);
  if (status != CAPNWEB_OK) {
    return fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_AUTH_CALL, status);
  }
  return CAPNWEB_OK;
}

/* --- appends -------------------------------------------------------------- */

enum capnweb_status iterate_kit_voicelab_append_frame(
    struct iterate_kit_voicelab *voicelab,
    const uint8_t *pcm,
    size_t pcm_length,
    uint32_t sequence,
    uint64_t captured_at_ms) {
  int prefix_length;
  size_t encoded_length;
  size_t offset;
  enum capnweb_status status;
  if (voicelab == NULL ||
      pcm == NULL ||
      pcm_length == 0U ||
      pcm_length > ITERATE_KIT_VOICELAB_FRAME_BYTES) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  prefix_length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      "[{\"type\":\"voicelab/mic-frame\",\"ephemeral\":true,"
      "\"payload\":{\"callId\":\"%s\",\"seq\":%" PRIu32
      ",\"t\":%" PRIu64 ",\"pcm\":\"",
      voicelab->options.call_id,
      sequence,
      captured_at_ms);
  if (prefix_length < 0 ||
      (size_t)prefix_length >= sizeof(voicelab->args_buffer)) {
    return CAPNWEB_E_LIMIT;
  }
  offset = (size_t)prefix_length;
  encoded_length = base64_encode(
      pcm,
      pcm_length,
      voicelab->args_buffer + offset,
      sizeof(voicelab->args_buffer) - offset - sizeof("\"}}]"));
  if (encoded_length == 0U) {
    return CAPNWEB_E_LIMIT;
  }
  offset += encoded_length;
  memcpy(voicelab->args_buffer + offset, "\"}}]", sizeof("\"}}]"));
  offset += sizeof("\"}}]") - 1U;

  status = capnweb_session_call_oneway_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      voicelab->args_buffer,
      offset);
  if (status == CAPNWEB_OK) {
    ++voicelab->frames_sent;
  } else {
    ++voicelab->frame_send_failures;
  }
  return status;
}

enum capnweb_status iterate_kit_voicelab_append_raw(
    struct iterate_kit_voicelab *voicelab,
    const char *events_json_array,
    size_t length) {
  if (voicelab == NULL || events_json_array == NULL || length == 0U) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  return capnweb_session_call_oneway_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      events_json_array,
      length);
}

static void ping_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  uint64_t now;
  voicelab->ping_pending = false;
  if (result->kind == CAPNWEB_RESULT_VALUE && result->status == CAPNWEB_OK) {
    now = voicelab->options.now_ms(voicelab->options.clock_context);
    voicelab->last_rtt_ms = (uint32_t)(now - voicelab->ping_started_ms);
    ++voicelab->ping_count;
  } else {
    ++voicelab->ping_failures;
  }
}

enum capnweb_status iterate_kit_voicelab_ping(
    struct iterate_kit_voicelab *voicelab) {
  int length;
  enum capnweb_status status;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY ||
      voicelab->ping_pending) {
    return CAPNWEB_E_STATE;
  }
  voicelab->ping_started_ms =
      voicelab->options.now_ms(voicelab->options.clock_context);
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      "[{\"type\":\"voicelab/ping\",\"ephemeral\":true,"
      "\"payload\":{\"id\":\"%s-%" PRIu32 "\",\"t0\":%" PRIu64 "}}]",
      voicelab->options.call_id,
      voicelab->ping_count,
      voicelab->ping_started_ms);
  if (length < 0 || (size_t)length >= sizeof(voicelab->args_buffer)) {
    return CAPNWEB_E_LIMIT;
  }
  status = capnweb_session_call_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      voicelab->args_buffer,
      (size_t)length,
      ping_completed,
      voicelab);
  if (status == CAPNWEB_OK) {
    voicelab->ping_pending = true;
  }
  return status;
}

enum capnweb_status iterate_kit_voicelab_close(
    struct iterate_kit_voicelab *voicelab) {
  enum capnweb_status first_error = CAPNWEB_OK;
  enum capnweb_status status;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  status = release_remote(
      voicelab,
      &voicelab->stream_capability,
      &voicelab->has_stream_capability);
  if (status != CAPNWEB_OK && first_error == CAPNWEB_OK) {
    first_error = status;
  }
  status = release_remote(
      voicelab,
      &voicelab->project_capability,
      &voicelab->has_project_capability);
  if (status != CAPNWEB_OK && first_error == CAPNWEB_OK) {
    first_error = status;
  }
  status = release_remote(
      voicelab,
      &voicelab->session_capability,
      &voicelab->has_session_capability);
  if (status != CAPNWEB_OK && first_error == CAPNWEB_OK) {
    first_error = status;
  }
  voicelab->state = ITERATE_KIT_VOICELAB_CLOSED;
  return first_error;
}

const char *iterate_kit_voicelab_state_name(
    enum iterate_kit_voicelab_state state) {
  switch (state) {
    case ITERATE_KIT_VOICELAB_IDLE: return "idle";
    case ITERATE_KIT_VOICELAB_AUTHENTICATING: return "authenticating";
    case ITERATE_KIT_VOICELAB_GETTING_PROJECT: return "getting-project";
    case ITERATE_KIT_VOICELAB_GETTING_STREAM: return "getting-stream";
    case ITERATE_KIT_VOICELAB_READY: return "ready";
    case ITERATE_KIT_VOICELAB_FAILED: return "failed";
    case ITERATE_KIT_VOICELAB_CLOSED: return "closed";
    default: return "unknown";
  }
}

const char *iterate_kit_voicelab_failure_name(
    enum iterate_kit_voicelab_failure failure) {
  switch (failure) {
    case ITERATE_KIT_VOICELAB_FAILURE_NONE: return "none";
    case ITERATE_KIT_VOICELAB_FAILURE_INVALID_OPTIONS:
      return "invalid-options";
    case ITERATE_KIT_VOICELAB_FAILURE_AUTH_CALL: return "auth-call";
    case ITERATE_KIT_VOICELAB_FAILURE_AUTH_REJECTED: return "auth-rejected";
    case ITERATE_KIT_VOICELAB_FAILURE_AUTH_RESULT: return "auth-result";
    case ITERATE_KIT_VOICELAB_FAILURE_PROJECT_CALL: return "project-call";
    case ITERATE_KIT_VOICELAB_FAILURE_PROJECT_REJECTED:
      return "project-rejected";
    case ITERATE_KIT_VOICELAB_FAILURE_PROJECT_RESULT:
      return "project-result";
    case ITERATE_KIT_VOICELAB_FAILURE_STREAM_CALL: return "stream-call";
    case ITERATE_KIT_VOICELAB_FAILURE_STREAM_REJECTED:
      return "stream-rejected";
    case ITERATE_KIT_VOICELAB_FAILURE_STREAM_RESULT: return "stream-result";
    case ITERATE_KIT_VOICELAB_FAILURE_RELEASE: return "release";
    case ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED:
      return "session-ended";
    default: return "unknown";
  }
}
