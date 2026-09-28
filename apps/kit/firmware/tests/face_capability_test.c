#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/capabilities/face.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

/*
 * `face.set({face})` on every board that draws a face: the slug resolves
 * against the compiled avatar catalogue, the board adopts only an index, and
 * an unknown slug is answered with the whole catalogue.
 */
static struct iterate_kit_face face;
static struct iterate_kit_peer peer;
static struct capnweb_session session;
static char sent[1024];
static size_t worn = SIZE_MAX;
static bool showing = true;

static bool wear(void *context, size_t index) {
  (void)context;
  if (!showing) return false;
  worn = index;
  return true;
}

static enum capnweb_status send_text(
    void *context, enum capnweb_text_fragment_kind kind, const char *data,
    size_t length) {
  (void)context;
  if (kind == CAPNWEB_TEXT_BEGIN) sent[0] = 0;
  if (kind == CAPNWEB_TEXT_DATA) {
    const size_t used = strlen(sent);
    assert(used + length < sizeof(sent));
    memcpy(sent + used, data, length);
    sent[used + length] = 0;
  }
  return CAPNWEB_OK;
}

static void set(const char *argument) {
  static unsigned id;
  char message[256];
  snprintf(message, sizeof(message),
           "[\"push\",[\"pipeline\",0,[\"face\",\"set\"],[%s]]]", argument);
  assert(capnweb_session_receive(&session, message, strlen(message)) == CAPNWEB_OK);
  snprintf(message, sizeof(message), "[\"pull\",%u]", ++id);
  assert(capnweb_session_receive(&session, message, strlen(message)) == CAPNWEB_OK);
}

int main(void) {
  const struct iterate_kit_face_driver driver = {
    .context = NULL,
    .slug_at = face_avatar_registry_slug_at,
    .wear = wear,
  };
  assert(iterate_kit_face_init(&face, &driver) == ITERATE_KIT_OK);
  struct iterate_kit_module module = iterate_kit_face_module(&face);
  const struct iterate_kit_peer_options peer_options = {"{}", 2, &module, 1};
  assert(iterate_kit_peer_init(&peer, &peer_options) == CAPNWEB_OK);
  struct capnweb_pending_call calls[8] = {0};
  struct capnweb_export exports[16] = {0};
  struct capnweb_import imports[8] = {0};
  struct capnweb_json_token tokens[64] = {0};
  char output[1024];
  const struct capnweb_session_options options = {
      iterate_kit_peer_capability(&peer), send_text, NULL, calls, 8, exports, 16,
      imports, 8, tokens, 64, output, sizeof(output)};
  assert(capnweb_session_init(&session, &options) == CAPNWEB_OK);

  /* Every catalogue slug is wearable, as its own index. */
  for (size_t index = 0U; index < face_avatar_registry_count(); ++index) {
    char argument[96];
    snprintf(argument, sizeof(argument), "{\"face\":\"%s\"}",
             face_avatar_registry_slug_at(index));
    set(argument);
    assert(strstr(sent, "\"resolve\"") && strstr(sent, "true"));
    assert(worn == index);
  }

  /* An unknown slug, or a prefix of a real one, names the whole catalogue. */
  worn = SIZE_MAX;
  set("{\"face\":\"moon\"}");
  assert(worn == SIZE_MAX && strstr(sent, "unknown face"));
  for (size_t index = 0U; index < face_avatar_registry_count(); ++index) {
    assert(strstr(sent, face_avatar_registry_slug_at(index)));
  }

  set("{\"face\":7}");
  assert(strstr(sent, "TypeError") && worn == SIZE_MAX);

  /* A face that is not up yet says so rather than claiming the slug is wrong. */
  showing = false;
  set("{\"face\":\"moonscope\"}");
  assert(strstr(sent, "BusyError") && worn == SIZE_MAX);

  capnweb_session_close(&session);
  puts("face capability test passed");
  return 0;
}
