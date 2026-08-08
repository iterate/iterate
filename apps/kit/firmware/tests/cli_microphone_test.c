#include "cli_microphone.h"

#include <assert.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

enum {
  TEST_FIRST_RETAINED_FRAME = 1,
  TEST_NEWEST_FRAME = 0xA5,
  TEST_PRIOR_DROPS = 7,
};

static struct cli_microphone microphone;
static uint8_t frame[ITERATE_KIT_VOICE_FRAME_BYTES];
static uint8_t output[ITERATE_KIT_VOICE_FRAME_BYTES];

/* Fill one frame with a visible sequence identity. */
static void make_frame(uint8_t identity)
{
  memset(frame, identity, sizeof(frame));
}

/*
 * A capture ring wraps every 640 ms under pressure. If either cursor forgets
 * the modulo step, the sender repeats a prior frame or reads beyond the fixed
 * allocation just as a person is speaking continuously.
 */
static void captured_frames_stay_ordered_across_ring_wrap(void)
{
  cli_microphone_clear(&microphone);
  microphone.dropped = 0U;
  for (size_t index = 0U; index < ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH; ++index) {
    make_frame((uint8_t)index);
    assert(cli_microphone_push(&microphone, frame, sizeof(frame)) ==
           CLI_MICROPHONE_OK);
  }
  assert(cli_microphone_pop(&microphone, output, sizeof(output)) ==
         CLI_MICROPHONE_OK);
  make_frame((uint8_t)ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH);
  assert(cli_microphone_push(&microphone, frame, sizeof(frame)) ==
         CLI_MICROPHONE_OK);
  for (size_t index = 1U; index <= ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH; ++index) {
    assert(cli_microphone_pop(&microphone, output, sizeof(output)) ==
           CLI_MICROPHONE_OK);
    assert(output[0] == (uint8_t)index);
  }
}

/*
 * When upload stalls, preserving the oldest frame makes every later word
 * arrive late. The queue must discard that stale frame, retain the newest,
 * and count the gap so a broken transcript has an explanation.
 */
static void a_full_microphone_discards_and_counts_its_oldest_frame(void)
{
  cli_microphone_clear(&microphone);
  microphone.dropped = 0U;
  for (size_t index = 0U; index < ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH; ++index) {
    make_frame((uint8_t)index);
    assert(cli_microphone_push(&microphone, frame, sizeof(frame)) ==
           CLI_MICROPHONE_OK);
  }
  make_frame(TEST_NEWEST_FRAME);
  assert(cli_microphone_push(&microphone, frame, sizeof(frame)) ==
         CLI_MICROPHONE_OK);
  assert(microphone.dropped == 1U);
  assert(cli_microphone_queued(&microphone) ==
         ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH);
  assert(cli_microphone_pop(&microphone, output, sizeof(output)) ==
         CLI_MICROPHONE_OK);
  assert(output[0] == TEST_FIRST_RETAINED_FRAME);
  for (size_t index = 1U; index < ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH; ++index) {
    assert(cli_microphone_pop(&microphone, output, sizeof(output)) ==
           CLI_MICROPHONE_OK);
  }
  assert(output[0] == TEST_NEWEST_FRAME);
}

/*
 * Clearing a turn must not erase evidence that capture previously fell
 * behind.
 */
static void clearing_audio_keeps_the_drop_count(void)
{
  microphone.dropped = TEST_PRIOR_DROPS;
  cli_microphone_clear(&microphone);
  assert(microphone.dropped == TEST_PRIOR_DROPS);
  assert(cli_microphone_pop(&microphone, output, sizeof(output)) ==
         CLI_MICROPHONE_ERR_EMPTY);
}

/* A short frame cannot be admitted because every downstream offset assumes 20 ms. */
static void partial_and_null_frames_are_refused(void)
{
  assert(cli_microphone_push(NULL, frame, sizeof(frame)) ==
         CLI_MICROPHONE_ERR_ARG);
  assert(cli_microphone_push(&microphone, frame, sizeof(frame) - 1U) ==
         CLI_MICROPHONE_ERR_ARG);
  assert(cli_microphone_pop(&microphone, NULL, sizeof(output)) ==
         CLI_MICROPHONE_ERR_ARG);
  assert(strcmp(cli_microphone_status_name(CLI_MICROPHONE_ERR_EMPTY),
                "empty") == 0);
}

int main(void)
{
  captured_frames_stay_ordered_across_ring_wrap();
  a_full_microphone_discards_and_counts_its_oldest_frame();
  clearing_audio_keeps_the_drop_count();
  partial_and_null_frames_are_refused();
  return 0;
}
