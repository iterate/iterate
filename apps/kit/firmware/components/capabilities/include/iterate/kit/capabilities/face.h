#ifndef ITERATE_KIT_CAPABILITIES_FACE_H
#define ITERATE_KIT_CAPABILITIES_FACE_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * `face.set({face})`: wear one of the avatar catalogue's faces by its slug,
 * on every board that draws one. The capability matches the slug against the
 * catalogue and names the whole catalogue when it matches nothing; the board
 * only adopts an index, on its render task, between frames.
 */
struct iterate_kit_face_driver {
  void *context;
  /** The catalogue's slug at `index`, NULL past the last: a board passes
   *  face_avatar_registry_slug_at, which keeps this library free of the
   *  avatar component. */
  const char *(*slug_at)(size_t index);
  /** Wear catalogue entry `index`; false when the face cannot take a request
   *  yet (its render task is not running). */
  bool (*wear)(void *context, size_t index);
};

struct iterate_kit_face {
  struct iterate_kit_face_driver driver;
  /** "unknown face — the catalogue is …", composed once at init because a
   *  Cap'n Web error borrows its message past the dispatch. */
  char unknown_face_error[192];
};

enum iterate_kit_status iterate_kit_face_init(
    struct iterate_kit_face *face,
    const struct iterate_kit_face_driver *driver);
struct iterate_kit_module iterate_kit_face_module(struct iterate_kit_face *face);

#ifdef __cplusplus
}
#endif

#endif
