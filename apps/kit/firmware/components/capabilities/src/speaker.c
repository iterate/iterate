#include "iterate/kit/capabilities/speaker.h"

#include "rpc_internal.h"

#include <stdio.h>
#include <string.h>

static const char *const set_volume_path[] = {"speaker", "setVolume"};
static const char *const volume_path[] = {"speaker", "volume"};

/*
 * One reply shape for both methods. A caller that just set the volume and a
 * caller that only asked should not have to parse two different answers to
 * learn the same two facts.
 */
static enum capnweb_status reply_with_level(
    struct capnweb_reply *reply, uint8_t percent, uint8_t ceiling) {
  /* Small, fixed-width, and only one dispatch runs at a time on this peer. */
  static char document[64];
  const int written = snprintf(
      document,
      sizeof(document),
      "{\"percent\":%u,\"ceiling\":%u}",
      (unsigned int)percent,
      (unsigned int)ceiling);
  if (written < 0 || (size_t)written >= sizeof(document)) {
    return capnweb_reply_set_error(
        reply, "RangeError", "speaker level did not fit its reply");
  }
  return capnweb_reply_set_borrowed_expression(
      reply, document, (size_t)written, NULL, NULL);
}

static enum capnweb_status set_volume(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_speaker *speaker = context;
  struct capnweb_value object = {0};
  int64_t percent = 0;
  uint8_t applied = 0U;
  enum iterate_kit_status status;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "percent", &percent)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "speaker.setVolume needs {percent}");
  }
  /*
   * OUT OF RANGE IS A MISTAKE, OVER THE CEILING IS NOT. 0-100 is the contract
   * and anything else is a caller bug worth naming; asking for more than this
   * board can safely give is a reasonable thing to do and is answered with
   * what it did give.
   */
  if (percent < 0 || percent > 100) {
    return capnweb_reply_set_error(
        reply, "RangeError", "speaker volume is a percentage, 0 to 100");
  }
  status = speaker->driver.set_volume(
      speaker->driver.context, (uint8_t)percent, &applied);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return reply_with_level(reply, applied, speaker->driver.ceiling);
}

static enum capnweb_status volume(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_speaker *speaker = context;
  (void)call;
  return reply_with_level(
      reply,
      speaker->driver.volume(speaker->driver.context),
      speaker->driver.ceiling);
}

enum iterate_kit_status iterate_kit_speaker_init(
    struct iterate_kit_speaker *speaker,
    const struct iterate_kit_speaker_driver *driver) {
  if (speaker == NULL || driver == NULL || driver->set_volume == NULL ||
      driver->volume == NULL || driver->ceiling == 0U ||
      driver->ceiling > 100U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(speaker, 0, sizeof(*speaker));
  speaker->driver = *driver;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_speaker_module(
    struct iterate_kit_speaker *speaker) {
  static const struct iterate_kit_method methods[] = {
    {set_volume_path, 2U, set_volume},
    {volume_path, 2U, volume},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = speaker,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
