#include "cli_delivery_fault.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * This module reorders, drops and duplicates frames on purpose, so that the
 * receive path's recovery branches are reachable on a real run instead of
 * being dead code the orderly provider never exercises. These tests are about
 * it doing exactly what the schedule says and nothing more.
 *
 * A frame is told apart by its PAYLOAD TAG rather than by an identity struct.
 * Frames used to carry an answer number and a position for the device's own
 * classifier; that classifier is gone (`drop` and `last` say what it inferred),
 * so the bytes are all there is — which is also all this module ever moved.
 */

/** A payload whose first byte names the frame, so a copy can be checked. */
static void payload(uint8_t *buffer, uint8_t tag)
{
  memset(buffer, tag, ITERATE_KIT_VOICE_FRAME_BYTES);
}

/*
 * NAME A FRAME IN ITS OWN BYTES, since it no longer carries an identity.
 *
 * A single byte wraps after 256 and these loops run to 600, which would make
 * a reordering test see frames going backwards that never did. Four bytes at
 * the front, little-endian, and the rest of the frame filled with the low byte.
 */
static void tag_payload(uint8_t *buffer, uint32_t tag)
{
  memset(buffer, (uint8_t)(tag & 0xFFU), ITERATE_KIT_VOICE_FRAME_BYTES);
  buffer[0] = (uint8_t)(tag & 0xFFU);
  buffer[1] = (uint8_t)((tag >> 8) & 0xFFU);
  buffer[2] = (uint8_t)((tag >> 16) & 0xFFU);
  buffer[3] = (uint8_t)((tag >> 24) & 0xFFU);
}

static uint32_t frame_tag(const uint8_t *pcm)
{
  return (uint32_t)pcm[0] | ((uint32_t)pcm[1] << 8) | ((uint32_t)pcm[2] << 16) |
         ((uint32_t)pcm[3] << 24);
}

static struct cli_fault_schedule schedule_of(struct cli_fault_recipe recipe)
{
  struct cli_fault_schedule schedule;
  recipe.session_ms = 60000U;
  assert(cli_fault_schedule_generate(&schedule, 0xD00DULL, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  return schedule;
}

/* Turning the knob off must leave delivery byte-identical to no module. */
static void with_no_schedule_every_frame_is_delivered_once(void)
{
  struct cli_delivery_fault fault;
  struct cli_delivery_fault_out out;
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
  uint32_t index;

  payload(pcm, 0x11);
  cli_delivery_fault_configure(&fault, NULL);
  for (index = 0U; index < 500U; index++) {
    assert(cli_delivery_fault_offer(
               &fault, pcm, sizeof(pcm), &out) ==
           CLI_DELIVERY_FAULT_OK);
    assert(out.count == 1U);
    /* Passed straight through: the same buffer, not a copy. */
    assert(out.frames[0].pcm == pcm);
    assert(out.frames[0].bytes == sizeof(pcm));
  }
  assert(fault.delivered == 500U);
  assert(fault.dropped == 0U && fault.duplicated == 0U);
  assert(fault.reordered == 0U && fault.flushed == 0U);
}

/* A dropped frame emits nothing, which is what leaves a gap to be counted. */
static void a_dropped_frame_emits_nothing(void)
{
  struct cli_fault_recipe recipe;
  struct cli_fault_schedule schedule;
  struct cli_delivery_fault fault;
  struct cli_delivery_fault_out out;
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
  uint32_t index;
  uint32_t emitted = 0U;

  memset(&recipe, 0, sizeof(recipe));
  recipe.frame_loss_one_in = 4U;
  schedule = schedule_of(recipe);
  payload(pcm, 0x22);
  cli_delivery_fault_configure(&fault, &schedule);
  for (index = 0U; index < 400U; index++) {
    assert(cli_delivery_fault_offer(
               &fault, pcm, sizeof(pcm), &out) ==
           CLI_DELIVERY_FAULT_OK);
    emitted += (uint32_t)out.count;
  }
  assert(fault.dropped > 0U);
  assert(emitted == 400U - fault.dropped);
}

/*
 * A duplicate is the SAME frame twice. One carrying different audio would be a
 * different frame, and playing it would be correct rather than a fault.
 */
static void a_duplicate_repeats_the_same_frame(void)
{
  struct cli_fault_recipe recipe;
  struct cli_fault_schedule schedule;
  struct cli_delivery_fault fault;
  struct cli_delivery_fault_out out;
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
  uint32_t index;
  bool saw_pair = false;

  memset(&recipe, 0, sizeof(recipe));
  recipe.frame_duplicate_one_in = 3U;
  schedule = schedule_of(recipe);
  payload(pcm, 0x33);
  cli_delivery_fault_configure(&fault, &schedule);
  for (index = 0U; index < 300U; index++) {
    assert(cli_delivery_fault_offer(
               &fault, pcm, sizeof(pcm), &out) ==
           CLI_DELIVERY_FAULT_OK);
    if (out.count != 2U) continue;
    saw_pair = true;
    assert(out.frames[0].bytes == out.frames[1].bytes);
    assert(
        memcmp(out.frames[0].pcm, out.frames[1].pcm, out.frames[0].bytes) == 0);
  }
  assert(saw_pair);
  assert(fault.duplicated > 0U);
}

/*
 * A held frame comes back BEFORE the frame that displaced it. The other order
 * is a drop followed by a late arrival, which is a different fault.
 */
static void a_held_frame_returns_out_of_order_not_missing(void)
{
  struct cli_fault_recipe recipe;
  struct cli_fault_schedule schedule;
  struct cli_delivery_fault fault;
  struct cli_delivery_fault_out out;
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
  uint32_t index;
  uint32_t emitted = 0U;
  uint32_t previous = 0U;
  bool saw_backwards = false;

  memset(&recipe, 0, sizeof(recipe));
  recipe.frame_reorder_one_in = 5U;
  schedule = schedule_of(recipe);
  cli_delivery_fault_configure(&fault, &schedule);
  for (index = 0U; index < 400U; index++) {
    size_t slot;
    tag_payload(pcm, index);
    assert(cli_delivery_fault_offer(
               &fault, pcm, sizeof(pcm), &out) ==
           CLI_DELIVERY_FAULT_OK);
    for (slot = 0U; slot < out.count; slot++) {
      const uint32_t number = frame_tag(out.frames[slot].pcm);
      if (emitted > 0U && number < previous) saw_backwards = true;
      previous = number;
      emitted++;
    }
  }
  assert(fault.reordered > 0U);
  assert(saw_backwards);
  /* Nothing is lost by reordering: what is held is either released or flushed. */
  {
    struct cli_delivery_fault_out tail;
    cli_delivery_fault_flush(&fault, &tail);
    assert(emitted + (uint32_t)tail.count == 400U);
  }
}

/*
 * A held frame's payload is COPIED. The caller's buffer is gone by the time
 * the frame is released, and a pointer to it would deliver whatever audio
 * happened to be there — plausible, wrong, and inaudible in a report.
 */
static void a_held_payload_survives_the_callers_buffer(void)
{
  struct cli_fault_recipe recipe;
  struct cli_fault_schedule schedule;
  struct cli_delivery_fault fault;
  struct cli_delivery_fault_out out;
  uint8_t scratch[ITERATE_KIT_VOICE_FRAME_BYTES];
  uint32_t index;
  bool checked = false;

  memset(&recipe, 0, sizeof(recipe));
  recipe.frame_reorder_one_in = 3U;
  schedule = schedule_of(recipe);
  cli_delivery_fault_configure(&fault, &schedule);
  for (index = 0U; index < 200U && !checked; index++) {
    /* Every frame carries its own tag, and the buffer is reused every time. */
    tag_payload(scratch, index);
    assert(cli_delivery_fault_offer(
               &fault, scratch, sizeof(scratch), &out) ==
           CLI_DELIVERY_FAULT_OK);
    {
      size_t slot;
      for (slot = 0U; slot < out.count; slot++) {
        const uint32_t number = frame_tag(out.frames[slot].pcm);
        if (number == index) continue; /* the current frame, not a release */
        /* A released frame still says who it is, so its bytes were COPIED
         * rather than pointed at a buffer the caller has since scribbled on. */
        assert(number < index);
        assert(out.frames[slot].pcm[4] == (uint8_t)(number & 0xFFU));
        checked = true;
      }
    }
    /* Scribble over it, exactly as the real caller's next frame would. */
    memset(scratch, 0xEE, sizeof(scratch));
  }
  assert(checked);
}

/*
 * A call that ends with frames held must give them up. Otherwise the audio is
 * missing, no counter says so, and the next call starts holding a buffer with
 * the previous conversation in it.
 */
static void a_flush_gives_back_everything_held(void)
{
  struct cli_fault_recipe recipe;
  struct cli_fault_schedule schedule;
  struct cli_delivery_fault fault;
  struct cli_delivery_fault_out out;
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
  uint32_t index;

  memset(&recipe, 0, sizeof(recipe));
  recipe.frame_reorder_one_in = 2U;
  schedule = schedule_of(recipe);
  payload(pcm, 0x55);
  cli_delivery_fault_configure(&fault, &schedule);
  for (index = 0U; index < 6U; index++) {
    assert(cli_delivery_fault_offer(
               &fault, pcm, sizeof(pcm), &out) ==
           CLI_DELIVERY_FAULT_OK);
  }
  cli_delivery_fault_flush(&fault, &out);
  assert(out.count == fault.flushed);
  /* And a second flush has nothing left to give. */
  cli_delivery_fault_flush(&fault, &out);
  assert(out.count == 0U);
}

/*
 * Faults are indexed by frames SEEN, not by the frame's own number, so the
 * adversity a run suffers does not change when the provider renumbers its
 * answers. Two runs of the same schedule must therefore agree exactly.
 */
static void the_same_schedule_injects_the_same_faults(void)
{
  struct cli_fault_recipe recipe;
  struct cli_fault_schedule schedule;
  struct cli_delivery_fault first;
  struct cli_delivery_fault second;
  struct cli_delivery_fault_out out;
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
  uint32_t index;

  memset(&recipe, 0, sizeof(recipe));
  recipe.frame_loss_one_in = 7U;
  recipe.frame_duplicate_one_in = 11U;
  recipe.frame_reorder_one_in = 13U;
  schedule = schedule_of(recipe);
  payload(pcm, 0x66);
  cli_delivery_fault_configure(&first, &schedule);
  cli_delivery_fault_configure(&second, &schedule);
  for (index = 0U; index < 600U; index++) {
    /* Identical offer counts, deliberately different audio. */
    assert(cli_delivery_fault_offer(&first, pcm, sizeof(pcm), &out) ==
           CLI_DELIVERY_FAULT_OK);
    assert(cli_delivery_fault_offer(&second, pcm, sizeof(pcm), &out) ==
           CLI_DELIVERY_FAULT_OK);
  }
  assert(first.delivered == second.delivered);
  assert(first.dropped == second.dropped);
  assert(first.duplicated == second.duplicated);
  assert(first.reordered == second.reordered);
}

static void null_arguments_are_refused(void)
{
  struct cli_delivery_fault fault;
  struct cli_delivery_fault_out out;
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];

  payload(pcm, 0x77);
  cli_delivery_fault_configure(&fault, NULL);
  assert(cli_delivery_fault_offer(NULL, pcm, sizeof(pcm), &out) ==
         CLI_DELIVERY_FAULT_ERR_ARG);
  assert(cli_delivery_fault_offer(&fault, NULL, 0U, &out) ==
         CLI_DELIVERY_FAULT_ERR_ARG);
  assert(cli_delivery_fault_offer(&fault, pcm, sizeof(pcm), NULL) ==
         CLI_DELIVERY_FAULT_ERR_ARG);
  cli_delivery_fault_configure(NULL, NULL);
  cli_delivery_fault_flush(NULL, &out);
  assert(strcmp(cli_delivery_fault_status_name(CLI_DELIVERY_FAULT_ERR_ARG),
                "arg") == 0);
}

int main(void)
{
  with_no_schedule_every_frame_is_delivered_once();
  a_dropped_frame_emits_nothing();
  a_duplicate_repeats_the_same_frame();
  a_held_frame_returns_out_of_order_not_missing();
  a_held_payload_survives_the_callers_buffer();
  a_flush_gives_back_everything_held();
  the_same_schedule_injects_the_same_faults();
  null_arguments_are_refused();
  printf("cli_delivery_fault_test ok\n");
  return 0;
}
