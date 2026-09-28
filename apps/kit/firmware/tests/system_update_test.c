#include "iterate/kit/capabilities/system_update.h"

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/*
 * `system.update({url, sha256})` as a caller sends it: a Cap'n Web push whose
 * target is the module's method, answered with `true` or a rejection. The
 * driver is a recorder, so each test states what reached the platform.
 */

enum {
  TOKEN_CAPACITY = 64,
  CALL_CAPACITY = 4,
  OUTPUT_CAPACITY = 64,
  CAPTURE_CAPACITY = 8,
  MESSAGE_CAPACITY = 1024,
};

static const char digest_hex[] =
    "00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210";
static const uint8_t digest_bytes[32] = {
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
  0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
};

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
  struct iterate_kit_system_update update;
  struct iterate_kit_module module;
  /* The driver's record, and what it answers. */
  enum iterate_kit_status begin_status;
  int begins;
  char url[ITERATE_KIT_SYSTEM_UPDATE_URL_CAPACITY];
  uint8_t sha256[32];
};

#include "capnweb_capture.h"

static enum iterate_kit_status record_begin(
    void *context, const char *url, const uint8_t sha256[32]) {
  struct fixture *fixture = context;
  ++fixture->begins;
  assert(strlen(url) < sizeof(fixture->url));
  strcpy(fixture->url, url);
  memcpy(fixture->sha256, sha256, sizeof(fixture->sha256));
  return fixture->begin_status;
}

static enum capnweb_status dispatch_update(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct fixture *fixture = context;
  return fixture->module.methods[0].dispatch(
      fixture->module.context, call, reply);
}

static void fixture_init(struct fixture *fixture) {
  struct capnweb_session_options options;
  memset(fixture, 0, sizeof(*fixture));
  const struct iterate_kit_system_update_driver driver = {
    .context = fixture,
    .begin = record_begin,
  };
  assert(
      iterate_kit_system_update_init(&fixture->update, &driver) ==
      ITERATE_KIT_OK);
  fixture->module = iterate_kit_system_update_module(&fixture->update);
  options = (struct capnweb_session_options){
    {dispatch_update, fixture, NULL},
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

/* Sends call number `id` with `arguments` (a JSON array) and returns the answer. */
static const char *call_update(
    struct fixture *fixture, int id, const char *arguments) {
  char push[MESSAGE_CAPACITY];
  char pull[32];
  const size_t before = fixture->captured_count;
  (void)snprintf(
      push, sizeof(push),
      "[\"push\",[\"pipeline\",0,[\"system\",\"update\"],%s]]", arguments);
  (void)snprintf(pull, sizeof(pull), "[\"pull\",%d]", id);
  assert(
      capnweb_session_receive(&fixture->session, push, strlen(push)) ==
      CAPNWEB_OK);
  assert(
      capnweb_session_receive(&fixture->session, pull, strlen(pull)) ==
      CAPNWEB_OK);
  assert(fixture->captured_count == before + 1U);
  return fixture->captured[before];
}

static const char *call_with(
    struct fixture *fixture, int id, const char *url, const char *sha256) {
  char arguments[MESSAGE_CAPACITY];
  (void)snprintf(
      arguments, sizeof(arguments), "[{\"url\":\"%s\",\"sha256\":\"%s\"}]",
      url, sha256);
  return call_update(fixture, id, arguments);
}

static void the_module_lends_system_update(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(fixture.module.method_count == 1U);
  assert(fixture.module.methods[0].path_count == 2U);
  assert(strcmp(fixture.module.methods[0].path[0], "system") == 0);
  assert(strcmp(fixture.module.methods[0].path[1], "update") == 0);
}

static void a_valid_request_reaches_the_driver_decoded(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(strcmp(
      call_with(
          &fixture, 1, "https://k.iterate.com/firmware/a/b/app.bin",
          digest_hex),
      "[\"resolve\",1,true]") == 0);
  assert(fixture.begins == 1);
  assert(strcmp(fixture.url, "https://k.iterate.com/firmware/a/b/app.bin") == 0);
  assert(memcmp(fixture.sha256, digest_bytes, sizeof(digest_bytes)) == 0);
}

/* The url reaches the driver terminated at its own length, whatever an
 * earlier, longer call left in the module's buffer. */
static void a_short_url_after_a_long_one_arrives_whole(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  (void)call_with(
      &fixture, 1, "https://example.com/a-much-longer-first-image.bin",
      digest_hex);
  (void)call_with(&fixture, 2, "https://example.com/b.bin", digest_hex);
  assert(fixture.begins == 2);
  assert(strcmp(fixture.url, "https://example.com/b.bin") == 0);
}

static void a_malformed_request_is_refused_before_the_driver(void) {
  static const char *const refused[] = {
    "[]",
    "[\"https://example.com/a.bin\"]",
    "[{\"sha256\":\"00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210\"}]",
    "[{\"url\":\"https://example.com/a.bin\"}]",
    "[{\"url\":7,\"sha256\":\"00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210\"}]",
    /* plain http: esp_https_ota refuses it, so the module does first */
    "[{\"url\":\"http://example.com/a.bin\",\"sha256\":\"00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210\"}]",
    /* uppercase, 63 digits, 65 digits, a non-hex digit */
    "[{\"url\":\"https://example.com/a.bin\",\"sha256\":\"00112233445566778899AABBCCDDEEFF0123456789ABCDEFFEDCBA9876543210\"}]",
    "[{\"url\":\"https://example.com/a.bin\",\"sha256\":\"00112233445566778899aabbccddeeff0123456789abcdeffedcba987654321\"}]",
    "[{\"url\":\"https://example.com/a.bin\",\"sha256\":\"00112233445566778899aabbccddeeff0123456789abcdeffedcba98765432100\"}]",
    "[{\"url\":\"https://example.com/a.bin\",\"sha256\":\"g0112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210\"}]",
  };
  size_t index;
  for (index = 0U; index < sizeof(refused) / sizeof(refused[0]); ++index) {
    struct fixture fixture;
    fixture_init(&fixture);
    assert(strcmp(
        call_update(&fixture, 1, refused[index]),
        "[\"reject\",1,[\"error\",\"TypeError\",\"system.update needs "
        "{url, sha256}: an https url and the image's sha256 as 64 lowercase "
        "hex digits\"]]") == 0);
    assert(fixture.begins == 0);
  }
}

static void a_url_longer_than_the_capacity_is_refused(void) {
  struct fixture fixture;
  char url[ITERATE_KIT_SYSTEM_UPDATE_URL_CAPACITY + 1];
  memset(url, 'a', sizeof(url) - 1U);
  memcpy(url, "https://", 8U);
  url[sizeof(url) - 1U] = '\0';
  fixture_init(&fixture);
  assert(strncmp(
      call_with(&fixture, 1, url, digest_hex),
      "[\"reject\",1,[\"error\",\"TypeError\"", 30U) == 0);
  assert(fixture.begins == 0);
}

static void the_drivers_refusals_reach_the_caller(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.begin_status = ITERATE_KIT_BACKPRESSURE;
  assert(strcmp(
      call_with(&fixture, 1, "https://example.com/a.bin", digest_hex),
      "[\"reject\",1,[\"error\",\"Error\","
      "\"an update is already in flight\"]]") == 0);
  /* The Mac's answer: no OTA slot. */
  fixture.begin_status = ITERATE_KIT_UNAVAILABLE;
  assert(strcmp(
      call_with(&fixture, 2, "https://example.com/a.bin", digest_hex),
      "[\"reject\",2,[\"error\",\"Error\","
      "\"hardware capability unavailable\"]]") == 0);
}

static void init_requires_a_driver(void) {
  struct iterate_kit_system_update update;
  const struct iterate_kit_system_update_driver no_begin = {NULL, NULL};
  assert(
      iterate_kit_system_update_init(&update, NULL) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_system_update_init(&update, &no_begin) ==
      ITERATE_KIT_INVALID_ARGUMENT);
}

int main(void) {
  the_module_lends_system_update();
  a_valid_request_reaches_the_driver_decoded();
  a_short_url_after_a_long_one_arrives_whole();
  a_malformed_request_is_refused_before_the_driver();
  a_url_longer_than_the_capacity_is_refused();
  the_drivers_refusals_reach_the_caller();
  init_requires_a_driver();
  return 0;
}
