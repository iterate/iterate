#include "cli_audio_in.h"

#include <assert.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * The interesting half of live capture is the handoff, not CoreAudio. A
 * capture thread that never stops meets a cooperative loop that sometimes
 * does, and what happens at that boundary decides whether a person's sentence
 * arrives late, arrives torn, or does not arrive at all. None of that needs a
 * microphone, a permission prompt, or a quiet room to test — which is exactly
 * why cli_audio_in_push is public.
 */

/* Twenty kilobytes of ring; on a stack it would be a crash, not a test. */
static struct cli_audio_in capture;
static uint8_t frame[ITERATE_KIT_VOICE_FRAME_BYTES];

/* Pushes one frame whose every byte is `mark`, as the callback would. */
static void push_marked(uint8_t mark);

/* Pops one frame and returns its mark, asserting it was whole. */
static uint8_t pop_marked(void);

/* Speech arrives in the order it was spoken, or it is not speech. */
static void frames_come_back_in_the_order_they_were_captured(void)
{
  memset(&capture, 0, sizeof(capture));
  for (uint8_t mark = 1U; mark <= 8U; ++mark) push_marked(mark);
  for (uint8_t mark = 1U; mark <= 8U; ++mark) assert(pop_marked() == mark);
  assert(cli_audio_in_pop(&capture, frame, sizeof(frame)) ==
         CLI_AUDIO_IN_ERR_EMPTY);
  assert(capture.dropped == 0U);
}

/*
 * The loop can be away for longer than the ring holds — a long TLS handshake,
 * a scheduler stall, a person's laptop thinking about something else. What
 * survives must be the NEWEST speech: keeping the oldest would send a
 * sentence that falls further behind the speaker with every frame, and the
 * transcript would read as if they had spoken slowly and then stopped.
 *
 * The loss has to be counted, because a turn whose transcript is missing its
 * middle is explained by nothing else in the run.
 */
static void a_consumer_a_whole_ring_behind_keeps_the_newest_speech(void)
{
  memset(&capture, 0, sizeof(capture));
  const uint8_t overrun = CLI_AUDIO_IN_RING_FRAMES + 8U;
  for (uint8_t mark = 1U; mark <= overrun; ++mark) push_marked(mark);
  const uint8_t first = pop_marked();
  assert(first > 1U);
  assert(capture.dropped == first - 1U);
  /* Everything from there to the newest frame is intact and in order. */
  for (uint8_t mark = (uint8_t)(first + 1U); mark <= overrun; ++mark) {
    assert(pop_marked() == mark);
  }
  assert(cli_audio_in_pop(&capture, frame, sizeof(frame)) ==
         CLI_AUDIO_IN_ERR_EMPTY);
}

/*
 * CoreAudio can hand back a part-filled buffer around start and stop. Padding
 * one to a whole frame would put a step discontinuity at the front of the
 * first turn of every session — a click, on the one frame a listener is
 * paying most attention to.
 */
static void a_partial_callback_is_counted_rather_than_padded(void)
{
  memset(&capture, 0, sizeof(capture));
  memset(frame, 0x5AU, sizeof(frame));
  assert(cli_audio_in_push(&capture, frame, sizeof(frame) / 2U) ==
         CLI_AUDIO_IN_ERR_ARG);
  assert(capture.short_buffers == 1U);
  assert(capture.captured == 0U);
  assert(cli_audio_in_pop(&capture, frame, sizeof(frame)) ==
         CLI_AUDIO_IN_ERR_EMPTY);
}

/*
 * macOS starts a process without microphone permission perfectly happily and
 * then never calls back. `captured` staying at zero through a turn is the
 * only way to tell that apart from a quiet room, so it must count accepted
 * frames and nothing else.
 */
static void captured_counts_only_what_was_really_accepted(void)
{
  memset(&capture, 0, sizeof(capture));
  assert(capture.captured == 0U);
  push_marked(1U);
  push_marked(2U);
  assert(capture.captured == 2U);
  assert(cli_audio_in_push(&capture, frame, 1U) == CLI_AUDIO_IN_ERR_ARG);
  assert(capture.captured == 2U);
}

static void unusable_arguments_are_refused(void)
{
  assert(cli_audio_in_push(NULL, frame, sizeof(frame)) ==
         CLI_AUDIO_IN_ERR_ARG);
  assert(cli_audio_in_push(&capture, NULL, sizeof(frame)) ==
         CLI_AUDIO_IN_ERR_ARG);
  assert(cli_audio_in_pop(NULL, frame, sizeof(frame)) == CLI_AUDIO_IN_ERR_ARG);
  assert(cli_audio_in_pop(&capture, frame, 1U) == CLI_AUDIO_IN_ERR_ARG);
  assert(strcmp(cli_audio_in_status_name(CLI_AUDIO_IN_ERR_EMPTY), "empty") ==
         0);
  /* Closing a capture that never opened must not talk to CoreAudio at all. */
  cli_audio_in_close(NULL);
  memset(&capture, 0, sizeof(capture));
  cli_audio_in_close(&capture);
}

static void push_marked(uint8_t mark)
{
  uint8_t pcm[ITERATE_KIT_VOICE_FRAME_BYTES];
  memset(pcm, mark, sizeof(pcm));
  assert(cli_audio_in_push(&capture, pcm, sizeof(pcm)) == CLI_AUDIO_IN_OK);
}

static uint8_t pop_marked(void)
{
  assert(cli_audio_in_pop(&capture, frame, sizeof(frame)) == CLI_AUDIO_IN_OK);
  for (size_t index = 0U; index < sizeof(frame); ++index) {
    assert(frame[index] == frame[0]);
  }
  return frame[0];
}

int main(void)
{
  frames_come_back_in_the_order_they_were_captured();
  a_consumer_a_whole_ring_behind_keeps_the_newest_speech();
  a_partial_callback_is_counted_rather_than_padded();
  captured_counts_only_what_was_really_accepted();
  unusable_arguments_are_refused();
  return 0;
}
