#include "iterate/kit/capabilities/face.h"

#include "iterate/kit/capabilities/arguments.h"

#include <string.h>

static const char *const set_path[] = {"face", "set"};

static enum capnweb_status set(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_face *face = context;
  struct capnweb_value object = {0};
  char slug[48];
  size_t length = 0U;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_string_field(
          &object, "face", slug, sizeof(slug), &length)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "face.set needs {face} as a catalogue slug");
  }
  const char *candidate;
  for (size_t index = 0U; (candidate = face->driver.slug_at(index)) != NULL;
       ++index) {
    if (strlen(candidate) != length || memcmp(candidate, slug, length) != 0) {
      continue;
    }
    if (!face->driver.wear(face->driver.context, index)) {
      return capnweb_reply_set_error(
          reply, "BusyError", "the face is not showing yet");
    }
    return capnweb_reply_set_boolean(reply, true);
  }
  return capnweb_reply_set_error(reply, "Error", face->unknown_face_error);
}

enum iterate_kit_status iterate_kit_face_init(
    struct iterate_kit_face *face,
    const struct iterate_kit_face_driver *driver) {
  static const char prefix[] = "unknown face — the catalogue is ";
  size_t used = sizeof(prefix) - 1U;
  if (face == NULL || driver == NULL || driver->slug_at == NULL ||
      driver->wear == NULL || driver->slug_at(0U) == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(face, 0, sizeof(*face));
  face->driver = *driver;
  memcpy(face->unknown_face_error, prefix, used);
  const char *slug;
  for (size_t index = 0U; (slug = driver->slug_at(index)) != NULL; ++index) {
    const char *const separator = index == 0U ? "" : ", ";
    const size_t separator_length = strlen(separator);
    const size_t slug_length = strlen(slug);
    /* A catalogue too long to name is a build defect, refused at boot. */
    if (used + separator_length + slug_length >=
        sizeof(face->unknown_face_error)) {
      return ITERATE_KIT_INVALID_ARGUMENT;
    }
    memcpy(face->unknown_face_error + used, separator, separator_length);
    used += separator_length;
    memcpy(face->unknown_face_error + used, slug, slug_length);
    used += slug_length;
  }
  face->unknown_face_error[used] = '\0';
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_face_module(struct iterate_kit_face *face) {
  static const struct iterate_kit_method methods[] = {
    {set_path, 2U, set},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = face,
  };
  return module;
}
