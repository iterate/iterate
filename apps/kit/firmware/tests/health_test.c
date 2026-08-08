#include "iterate/kit/capabilities/health.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

/*
 * Two rules, both learned the hard way elsewhere in this codebase: the render
 * must be pure, and a document that does not fit must SAY so rather than
 * arrive clipped. A clipped JSON document is not a smaller answer — it is an
 * unparseable one, and the caller reads the parse failure as a broken device.
 */

struct fake_device {
  const char *document;
  int renders;
};

static size_t render(void *context, char *out, size_t capacity) {
  struct fake_device *device = context;
  const size_t length = strlen(device->document);
  ++device->renders;
  if (length >= capacity) return 0U;
  memcpy(out, device->document, length);
  return length;
}

static void a_pull_returns_the_devices_own_document(void) {
  struct fake_device device = {.document = "{\"gateOpen\":true,\"seq\":7}"};
  struct iterate_kit_health health;
  char buffer[256];
  struct capnweb_reply reply = {0};
  const struct iterate_kit_health_driver driver = {
    .context = &device,
    .render = render,
  };
  assert(
      iterate_kit_health_init(&health, &driver, buffer, sizeof(buffer)) ==
      ITERATE_KIT_OK);
  const struct iterate_kit_module module = iterate_kit_health_module(&health);

  assert(module.method_count == 1U);
  assert(strcmp(module.methods[0].path[0], "health") == 0);
  /* No poll, no close, no session hook: a pure reader owns no lifecycle. */
  assert(module.poll == NULL);
  assert(module.session_ended == NULL);

  assert(
      module.methods[0].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_EXPRESSION);
  assert(
      strncmp(
          (const char *)reply.value.borrowed.data,
          device.document,
          strlen(device.document)) == 0);
  assert(device.renders == 1);
}

static void a_document_that_does_not_fit_is_refused_not_clipped(void) {
  /* Longer than the buffer below, so the renderer reports it cannot fit. */
  struct fake_device device = {
    .document =
        "{\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\":1,"
        "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\":2}"};
  struct iterate_kit_health health;
  char buffer[64];
  struct capnweb_reply reply = {0};
  const struct iterate_kit_health_driver driver = {
    .context = &device,
    .render = render,
  };
  /* Force the too-small case: capacity is at the floor init accepts. */
  assert(
      iterate_kit_health_init(&health, &driver, buffer, 20U) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_health_init(&health, &driver, buffer, 64U) ==
      ITERATE_KIT_OK);
  const struct iterate_kit_module module = iterate_kit_health_module(&health);
  assert(
      module.methods[0].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_ERROR);
  assert(strstr(reply.value.error.message, "did not fit") != NULL);
}

static void init_refuses_what_it_cannot_serve(void) {
  struct iterate_kit_health health;
  char buffer[128];
  const struct iterate_kit_health_driver empty = {0};
  const struct iterate_kit_health_driver ok = {.render = render};
  assert(
      iterate_kit_health_init(&health, &empty, buffer, sizeof(buffer)) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_health_init(&health, &ok, NULL, sizeof(buffer)) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_health_init(NULL, &ok, buffer, sizeof(buffer)) ==
      ITERATE_KIT_INVALID_ARGUMENT);
}

int main(void) {
  a_pull_returns_the_devices_own_document();
  a_document_that_does_not_fit_is_refused_not_clipped();
  init_refuses_what_it_cannot_serve();
  printf("health capability test passed\n");
  return 0;
}
