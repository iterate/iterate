#include "iterate/kit/speaker_abandon.h"

#include <stddef.h>

uint32_t iterate_kit_speaker_abandon(
    const struct iterate_kit_speaker_abandon_hooks *hooks, void *context) {
  uint32_t bytes = 0U;
  if (hooks == NULL) return 0U;
  /*
   * ORDER, and it is the whole point of this function.
   *
   * 1. Disarm first, while the deadline the watch is holding still refers to
   *    audio that exists. Do it after the discard and the ISR gets a window in
   *    which the source is gone and the watch still expects to be fed — which is
   *    exactly the false starve event this exists to prevent.
   * 2. Note the flush, so the ring is known stale and the NEXT arm measures from
   *    a full ring ahead rather than against audio nobody will play. This is
   *    what stops one abandon from mismeasuring the next call.
   * 3. Only then read what is queued, and hand it to the reader to skip.
   */
  if (hooks->disarm_watch != NULL) hooks->disarm_watch(context);
  if (hooks->note_flush != NULL) hooks->note_flush(context);
  if (hooks->buffered_bytes != NULL) bytes = hooks->buffered_bytes(context);
  if (hooks->set_discard != NULL) hooks->set_discard(context, bytes);
  if (hooks->set_reprime != NULL) hooks->set_reprime(context);
  return bytes;
}
