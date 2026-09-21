#include "iterate/kit/capabilities/screen.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static struct iterate_kit_screen screen;
static struct iterate_kit_peer peer;
static struct capnweb_session session;
static char sent[4096];
static enum iterate_kit_screen_state state;
static unsigned submits;
static bool submit(void *context, enum iterate_kit_screen_format format, const uint8_t *data, size_t length) {
  (void)context;
  assert(format == ITERATE_KIT_SCREEN_MONO1 || format == ITERATE_KIT_SCREEN_GRAY4);
  assert(data == screen.bitmap && length == screen.expected_bytes);
  ++submits;
  state = ITERATE_KIT_SCREEN_PENDING;
  return true;
}
static enum iterate_kit_screen_state get_state(void *context) { (void)context; return state; }
static enum capnweb_status send_text(void *context, enum capnweb_text_fragment_kind kind, const char *data, size_t length) {
  (void)context;
  if (kind == CAPNWEB_TEXT_BEGIN) sent[0] = 0;
  if (kind == CAPNWEB_TEXT_DATA) {
    const size_t used = strlen(sent);
    assert(used + length < sizeof(sent));
    memcpy(sent + used, data, length); sent[used + length] = 0;
  }
  return CAPNWEB_OK;
}
static void call(const char *method, const char *argument) {
  static unsigned id;
  char message[1024];
  snprintf(message, sizeof(message), "[\"push\",[\"pipeline\",0,[\"screen\",\"%s\"],[%s]]]", method, argument);
  assert(capnweb_session_receive(&session, message, strlen(message)) == CAPNWEB_OK);
  snprintf(message, sizeof(message), "[\"pull\",%u]", ++id);
  assert(capnweb_session_receive(&session, message, strlen(message)) == CAPNWEB_OK);
}
int main(void) {
  uint8_t pixels[12] = {0};
  struct iterate_kit_screen_driver driver = {.width=9, .height=2, .formats=3,
    .preferred_format=ITERATE_KIT_SCREEN_MONO1, .refresh_timeout_ms=2000,
    .submit=submit, .state=get_state};
  assert(iterate_kit_screen_frame_bytes(9, 2, ITERATE_KIT_SCREEN_MONO1) == 4);
  assert(iterate_kit_screen_frame_bytes(9, 2, ITERATE_KIT_SCREEN_GRAY4) == 10);
  assert(iterate_kit_screen_frame_bytes(3, 2, ITERATE_KIT_SCREEN_RGB565) == 12);
  assert(!iterate_kit_screen_init(&screen, &driver, pixels, 4));
  assert(iterate_kit_screen_init(&screen, &driver, pixels, sizeof(pixels)));
  struct iterate_kit_module module = iterate_kit_screen_module(&screen);
  const struct iterate_kit_peer_options peer_options = {"{}",2,&module,1};
  assert(iterate_kit_peer_init(&peer, &peer_options) == CAPNWEB_OK);
  struct capnweb_pending_call calls[32] = {0};
  struct capnweb_export exports[64] = {0};
  struct capnweb_import imports[32] = {0};
  struct capnweb_json_token tokens[128] = {0};
  char output[4096];
  const struct capnweb_session_options options = {iterate_kit_peer_capability(&peer),send_text,NULL,
    calls,32,exports,64,imports,32,tokens,128,output,sizeof(output)};
  assert(capnweb_session_init(&session,&options) == CAPNWEB_OK);
  call("info", ""); assert(strstr(sent,"\"formats\":[[\"mono1\",\"gray4\"]]") && strstr(sent,"\"width\":9"));
  call("setImage", "{\"uploadId\":1,\"offset\":0,\"format\":\"mono1\",\"data\":\"/w==\"}");
  assert(screen.next_offset == 1 && submits == 0);
  call("status", ""); assert(strstr(sent,"receiving"));
  call("setImage", "{\"uploadId\":1,\"offset\":2,\"format\":\"mono1\",\"data\":\"AAAA\"}");
  assert(strstr(sent,"RangeError") && screen.next_offset == 1);
  call("setImage", "{\"uploadId\":1,\"offset\":4294967297,\"format\":\"mono1\",\"data\":\"AAAA\"}");
  assert(strstr(sent,"RangeError") && screen.next_offset == 1);
  call("setImage", "{\"uploadId\":1,\"offset\":1,\"format\":\"mono1\",\"data\":\"%%%A\"}");
  assert(strstr(sent,"RangeError") && screen.next_offset == 1);
  call("setImage", "{\"uploadId\":1,\"offset\":1,\"format\":\"mono1\",\"data\":\"gP+A\"}");
  assert(submits == 1 && screen.uploads_completed == 0 && pixels[0] == 255 && pixels[3] == 128);
  call("setImage", "null"); assert(strstr(sent,"BusyError") && screen.showing_image);
  call("status", ""); assert(strstr(sent,"pending"));
  module.session_ended(module.context);
  call("setImage", "{\"uploadId\":2,\"offset\":0,\"format\":\"mono1\",\"data\":\"AAAAAA==\"}");
  assert(strstr(sent,"BusyError") && pixels[0] == 255);
  state = ITERATE_KIT_SCREEN_SHOWN;
  call("status", ""); assert(strstr(sent,"shown") && screen.uploads_completed == 1);
  call("status", ""); assert(screen.uploads_completed == 1);
  call("setImage", "null"); assert(!screen.showing_image);
  call("setImage", "{\"uploadId\":2,\"offset\":0,\"format\":\"rgb565\",\"data\":\"AAAA\"}");
  assert(strstr(sent,"RangeError"));
  call("setImage", "{\"uploadId\":3,\"offset\":0,\"format\":\"gray4\",\"data\":\"AAAAAAAAAAAAAA==\"}");
  assert(submits == 2);
  state = ITERATE_KIT_SCREEN_FAILED;
  call("status", ""); assert(strstr(sent,"failed") && screen.uploads_completed == 1);
  capnweb_session_close(&session);
  puts("screen capability test passed");
}
