// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#define _POSIX_C_SOURCE 200809L

#include "capnweb/capnweb.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

enum {
  TOKEN_CAPACITY = 64,
  CALL_CAPACITY = 8,
  OUTPUT_SCRATCH_CAPACITY = 128,
  MESSAGE_CAPACITY = 160,
  ITERATIONS = 100000,
};

struct profile {
  struct capnweb_session session;
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  char output_scratch[OUTPUT_SCRATCH_CAPACITY];
  volatile uint64_t checksum;
};

static enum capnweb_status dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value argument;
  int64_t value;
  (void)context;
  if (!capnweb_value_array_at(&call->arguments, 0U, &argument) ||
      !capnweb_value_get_int64(&argument, &value)) {
    return CAPNWEB_E_INVALID_MESSAGE;
  }
  return capnweb_reply_set_int64(reply, value);
}

static enum capnweb_status consume_send(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct profile *profile = context;
  size_t index;
  if (kind != CAPNWEB_TEXT_DATA) {
    return data == NULL && length == 0U
        ? CAPNWEB_OK
        : CAPNWEB_E_TRANSPORT;
  }
  if (data == NULL && length > 0U) {
    return CAPNWEB_E_TRANSPORT;
  }
  for (index = 0U; index < length; ++index) {
    profile->checksum =
        (profile->checksum * UINT64_C(33)) ^ (unsigned char)data[index];
  }
  return CAPNWEB_OK;
}

static uint64_t elapsed_nanoseconds(
    const struct timespec *start, const struct timespec *end) {
  uint64_t seconds = (uint64_t)(end->tv_sec - start->tv_sec);
  int64_t nanoseconds = end->tv_nsec - start->tv_nsec;
  if (nanoseconds < 0) {
    --seconds;
    nanoseconds += 1000000000;
  }
  return seconds * UINT64_C(1000000000) + (uint64_t)nanoseconds;
}

int main(void) {
  struct profile profile;
  struct capnweb_session_options options;
  struct timespec start;
  struct timespec end;
  char push[MESSAGE_CAPACITY];
  char pull[MESSAGE_CAPACITY];
  char release[MESSAGE_CAPACITY];
  uint64_t elapsed;
  size_t iteration;

  memset(&profile, 0, sizeof(profile));
  options = (struct capnweb_session_options){
    {dispatch, &profile, NULL},
    consume_send,
    &profile,
    profile.pending_calls,
    CALL_CAPACITY,
    profile.exports,
    CALL_CAPACITY,
    profile.imports,
    CALL_CAPACITY,
    profile.tokens,
    TOKEN_CAPACITY,
    profile.output_scratch,
    sizeof(profile.output_scratch),
  };
  if (capnweb_session_init(&profile.session, &options) != CAPNWEB_OK ||
      clock_gettime(CLOCK_MONOTONIC, &start) != 0) {
    return 1;
  }

  for (iteration = 1U; iteration <= ITERATIONS; ++iteration) {
    int push_length = snprintf(
        push,
        sizeof(push),
        "[\"push\",[\"pipeline\",0,[\"echo\"],[%zu]]]",
        iteration);
    int pull_length = snprintf(
        pull, sizeof(pull), "[\"pull\",%zu]", iteration);
    int release_length = snprintf(
        release, sizeof(release), "[\"release\",%zu,1]", iteration);
    if (push_length < 0 || (size_t)push_length >= sizeof(push) ||
        pull_length < 0 || (size_t)pull_length >= sizeof(pull) ||
        release_length < 0 || (size_t)release_length >= sizeof(release) ||
        capnweb_session_receive(
            &profile.session, push, (size_t)push_length) != CAPNWEB_OK ||
        capnweb_session_receive(
            &profile.session, pull, (size_t)pull_length) != CAPNWEB_OK ||
        capnweb_session_receive(
            &profile.session, release, (size_t)release_length) != CAPNWEB_OK) {
      return 2;
    }
  }
  if (clock_gettime(CLOCK_MONOTONIC, &end) != 0) {
    return 3;
  }
  elapsed = elapsed_nanoseconds(&start, &end);
  printf(
      "{\"iterations\":%u,"
      "\"wireMessages\":%u,"
      "\"elapsedNanoseconds\":%" PRIu64 ","
      "\"nanosecondsPerRpc\":%" PRIu64 ","
      "\"workingSetBytes\":%zu,"
      "\"sessionBytes\":%zu,"
      "\"tokenBytes\":%zu,"
      "\"pendingCallBytes\":%zu,"
      "\"exportBytes\":%zu,"
      "\"importBytes\":%zu,"
      "\"outputScratchBytes\":%u,"
      "\"libraryHeapPolicy\":\"no allocator dependency\","
      "\"checksum\":%" PRIu64 "}\n",
      ITERATIONS,
      ITERATIONS * 3U,
      elapsed,
      elapsed / ITERATIONS,
      sizeof(profile),
      sizeof(profile.session),
      sizeof(profile.tokens),
      sizeof(profile.pending_calls),
      sizeof(profile.exports),
      sizeof(profile.imports),
      OUTPUT_SCRATCH_CAPACITY,
      profile.checksum);
  return 0;
}
