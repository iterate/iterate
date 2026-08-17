/* cli_delivery_fault.c: loses, repeats and reorders frames from a schedule. */

#include "cli_delivery_fault.h"

#include <assert.h>
#include <string.h>

const char *cli_delivery_fault_status_name(enum cli_delivery_fault_status s)
{
  switch (s) {
    case CLI_DELIVERY_FAULT_OK: return "ok";
    case CLI_DELIVERY_FAULT_ERR_ARG: return "arg";
  }
  return "unknown";
}

void cli_delivery_fault_configure(
    struct cli_delivery_fault *fault, const struct cli_fault_schedule *schedule)
{
  if (fault == NULL) return;
  memset(fault, 0, sizeof(*fault));
  fault->schedule = schedule;
}

/** Put one frame into the output, in the order it must be delivered. */
static void emit(
    struct cli_delivery_fault_out *out,
    const uint8_t *pcm,
    size_t bytes)
{
  assert(out != NULL && pcm != NULL);
  /*
   * The bound is arithmetic, not a hope: every held slot falling due at once
   * plus the current frame twice is exactly CLI_DELIVERY_FAULT_MAX_EMIT. An
   * assertion rather than a silent drop, because a dropped emission here
   * would be a fault this module invented and did not count.
   */
  assert(out->count < CLI_DELIVERY_FAULT_MAX_EMIT);
  out->frames[out->count].pcm = pcm;
  out->frames[out->count].bytes = bytes;
  out->count++;
}

/** Release one held slot into the output and free it. */
static void release(
    struct cli_delivery_fault *fault, size_t slot, struct cli_delivery_fault_out *out)
{
  struct cli_delivery_held *held;
  assert(fault != NULL && out != NULL && slot < CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD);
  held = &fault->held[slot];
  emit(out, held->pcm, held->bytes);
  held->remaining = 0U;
}

/**
 * Age every held frame by one offer, releasing those now due.
 *
 * Done BEFORE the current frame is considered, so a released frame is
 * delivered ahead of the one that displaced it. The other order would make a
 * reordering indistinguishable from a drop followed by a late arrival.
 */
static void age_held(
    struct cli_delivery_fault *fault, struct cli_delivery_fault_out *out)
{
  size_t slot;
  assert(fault != NULL && out != NULL);
  for (slot = 0U; slot < CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD; slot++) {
    if (fault->held[slot].remaining == 0U) continue;
    fault->held[slot].remaining--;
    if (fault->held[slot].remaining == 0U) release(fault, slot, out);
  }
}

/** Copy the frame into a free slot; false when every slot is taken. */
static bool hold(
    struct cli_delivery_fault *fault,
    const uint8_t *pcm,
    size_t bytes,
    uint32_t frames)
{
  size_t slot;
  assert(fault != NULL && pcm != NULL);
  if (bytes > ITERATE_KIT_VOICE_FRAME_BYTES) return false;
  for (slot = 0U; slot < CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD; slot++) {
    if (fault->held[slot].remaining != 0U) continue;
    memcpy(fault->held[slot].pcm, pcm, bytes);
    fault->held[slot].bytes = bytes;
    fault->held[slot].remaining = frames;
    return true;
  }
  return false;
}

enum cli_delivery_fault_status cli_delivery_fault_offer(
    struct cli_delivery_fault *fault,
    const uint8_t *pcm,
    size_t bytes,
    struct cli_delivery_fault_out *out)
{
  enum cli_frame_fate fate;
  uint32_t hold_frames = 1U;
  if (fault == NULL || pcm == NULL || out == NULL) {
    return CLI_DELIVERY_FAULT_ERR_ARG;
  }
  out->count = 0U;
  age_held(fault, out);

  fate = cli_fault_schedule_fate(fault->schedule, fault->offers, &hold_frames);
  fault->offers++;

  if (fate == CLI_FRAME_FATE_DROP) {
    fault->dropped++;
    return CLI_DELIVERY_FAULT_OK;
  }
  if (fate == CLI_FRAME_FATE_REORDER) {
    if (hold(fault, pcm, bytes, hold_frames)) {
      fault->reordered++;
      return CLI_DELIVERY_FAULT_OK;
    }
    /* Nowhere to put it: deliver rather than invent an uncounted drop. */
    fault->hold_unavailable++;
  }
  emit(out, pcm, bytes);
  fault->delivered++;
  if (fate != CLI_FRAME_FATE_DUPLICATE) return CLI_DELIVERY_FAULT_OK;
  /*
   * The SAME audio twice, back to back, which is what a recycle overlap
   * delivers: 20ms of the answer is heard again. There is nothing left on the
   * device to recognise it as a repeat, so this is now a fault the listener
   * hears rather than one a classifier absorbs.
   */
  emit(out, pcm, bytes);
  fault->duplicated++;
  return CLI_DELIVERY_FAULT_OK;
}

void cli_delivery_fault_flush(
    struct cli_delivery_fault *fault, struct cli_delivery_fault_out *out)
{
  size_t slot;
  if (fault == NULL || out == NULL) return;
  out->count = 0U;
  for (slot = 0U; slot < CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD; slot++) {
    if (fault->held[slot].remaining == 0U) continue;
    release(fault, slot, out);
    fault->flushed++;
  }
}
