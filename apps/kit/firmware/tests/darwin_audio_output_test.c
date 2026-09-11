#include "iterate/kit/platforms/darwin_audio_output.h"

#include <assert.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/* The hardware-facing ring is deliberately large, so keep it off the stack. */
static struct iterate_kit_darwin_audio_output output;
static uint8_t pcm[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES];

struct memory_sink {
  uint32_t frames;
  uint32_t bytes;
};

static struct memory_sink sink;

static bool write_memory(void *context, const uint8_t *samples, size_t length)
{
  struct memory_sink *memory = context;
  if (memory == NULL || samples == NULL ||
      length != ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) {
    return false;
  }
  ++memory->frames;
  memory->bytes += (uint32_t)length;
  return true;
}

static void open_file_output(void)
{
  memset(&output, 0, sizeof(output));
  memset(&sink, 0, sizeof(sink));
  const struct iterate_kit_darwin_audio_file_sink file_sink = {
    .context = &sink,
    .write = write_memory,
  };
  assert(iterate_kit_darwin_audio_output_open_file(&output, &file_sink) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
}

static void close_file_output(void)
{
  iterate_kit_darwin_audio_output_close(&output);
}

/* The render tap writes runs of any length; this sink keeps their sum and content. */
struct tap_sink {
  uint32_t bytes;
  uint32_t nonzero_bytes;
  uint32_t writes;
};

static struct tap_sink tap;

static bool write_tap(void *context, const uint8_t *samples, size_t length)
{
  struct tap_sink *memory = context;
  if (memory == NULL || samples == NULL || length == 0U) return false;
  for (size_t index = 0U; index < length; ++index) {
    if (samples[index] != 0U) ++memory->nonzero_bytes;
  }
  memory->bytes += (uint32_t)length;
  ++memory->writes;
  return true;
}

/*
 * THE TAP IS A TIMELINE OF WHAT THE HARDWARE WAS HANDED. Four frames go in;
 * the puller asks six times. The first pull is silence (the lead is still
 * filling), then four frames of audio, then silence again for the dry pull —
 * six pulls, six frames in the file, audio bytes exactly as many as went in.
 * The playout's own recording would hold four.
 */
static void the_render_tap_records_silence_as_well_as_audio(void)
{
  uint8_t destination[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES];
  const struct iterate_kit_darwin_audio_file_sink tap_sink = {
    .context = &tap,
    .write = write_tap,
  };
  memset(&output, 0, sizeof(output));
  memset(&tap, 0, sizeof(tap));
  memset(pcm, 0x11, sizeof(pcm));
  assert(iterate_kit_darwin_audio_output_open_pulled(&output, &tap_sink) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  /* One pull before any audio: the lead is empty, the hardware gets zeros. */
  assert(iterate_kit_darwin_audio_output_pull(&output, destination, sizeof(destination)) == 0U);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, 4U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  for (size_t index = 0U; index < 4U; ++index) {
    assert(iterate_kit_darwin_audio_output_pull(&output, destination, sizeof(destination)) ==
           ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  }
  assert(iterate_kit_darwin_audio_output_pull(&output, destination, sizeof(destination)) == 0U);
  /* Nothing reaches the file until the caller's thread drains. */
  assert(tap.bytes == 0U);
  iterate_kit_darwin_audio_output_pump(&output, 1000U);
  assert(tap.bytes == 6U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(tap.nonzero_bytes == 4U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_tap_bytes(&output) == tap.bytes);
  assert(iterate_kit_darwin_audio_output_tap_dropped_bytes(&output) == 0U);
  iterate_kit_darwin_audio_output_close(&output);
}

/*
 * A MAIN LOOP THAT STALLS LOSES BYTES, NOT TIME. With nobody draining, pulls
 * past the tap ring's capacity are dropped and counted; the next drain writes
 * that many zeros first, so the file is still one byte per byte handed over.
 */
static void a_full_tap_ring_keeps_the_timeline_length(void)
{
  uint8_t destination[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES];
  const struct iterate_kit_darwin_audio_file_sink tap_sink = {
    .context = &tap,
    .write = write_tap,
  };
  const uint32_t ring_frames =
      ITERATE_KIT_DARWIN_AUDIO_OUTPUT_TAP_RING_BYTES / ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES;
  memset(&output, 0, sizeof(output));
  memset(&tap, 0, sizeof(tap));
  assert(iterate_kit_darwin_audio_output_open_pulled(&output, &tap_sink) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  for (uint32_t index = 0U; index < ring_frames + 3U; ++index) {
    (void)iterate_kit_darwin_audio_output_pull(&output, destination, sizeof(destination));
  }
  assert(iterate_kit_darwin_audio_output_tap_dropped_bytes(&output) ==
         3U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  iterate_kit_darwin_audio_output_pump(&output, 1000U);
  assert(tap.bytes == (ring_frames + 3U) * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_tap_dropped_bytes(&output) == 0U);
  iterate_kit_darwin_audio_output_close(&output);
}

/* Drain confirms every accepted byte at the file/hardware boundary. */
static void drain_accounts_only_payload_that_completed(void)
{
  open_file_output();
  memset(pcm, 0x5AU, 2U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, 2U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_completed_bytes(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_drain(&output, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_queued_bytes(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_completed_bytes(&output) ==
         2U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(sink.frames == 2U);
  assert(sink.bytes == 2U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_platform_error(&output) == 0);
  close_file_output();
}

/* Refused room audio is bounded, returned, and counted in bytes. */
static void a_full_ring_cannot_look_like_success(void)
{
  open_file_output();
  memset(pcm, 0x2AU, sizeof(pcm));
  assert(iterate_kit_darwin_audio_output_write(&output, pcm, sizeof(pcm)) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_FULL);
  assert(output.dropped == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_drain(&output, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_completed_bytes(&output) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES);
  close_file_output();
}

/* A dry pull is a hole only when later answer payload proves speech resumed. */
static void starvation_has_an_explicit_answer_window(void)
{
  open_file_output();
  iterate_kit_darwin_audio_output_pump(&output, 1000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  iterate_kit_darwin_audio_output_set_expected(&output, true);
  iterate_kit_darwin_audio_output_pump(&output, 21000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  memset(pcm, 0x3AU, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  iterate_kit_darwin_audio_output_pump(&output, 41000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 1U);
  iterate_kit_darwin_audio_output_set_expected(&output, false);
  iterate_kit_darwin_audio_output_pump(&output, 61000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 1U);
  assert(iterate_kit_darwin_audio_output_drain(&output, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  close_file_output();
}

/* An answer's final dry pulls are idle tail, not error telemetry. */
static void trailing_silence_is_not_starvation(void)
{
  open_file_output();
  memset(pcm, 0x4AU, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  iterate_kit_darwin_audio_output_pump(&output, 1000U);
  iterate_kit_darwin_audio_output_pump(&output, 21000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  iterate_kit_darwin_audio_output_set_expected(&output, false);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_drain(&output, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  close_file_output();
}

static void unusable_arguments_are_refused(void)
{
  const struct iterate_kit_darwin_audio_file_sink file_sink = {
    .context = &sink,
    .write = write_memory,
  };
  assert(iterate_kit_darwin_audio_output_open(NULL, NULL) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_open_pulled(NULL, NULL) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  {
    const struct iterate_kit_darwin_audio_file_sink unusable_tap = {0};
    assert(iterate_kit_darwin_audio_output_open_pulled(&output, &unusable_tap) ==
           ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  }
  assert(iterate_kit_darwin_audio_output_open_file(NULL, &file_sink) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_open_file(&output, NULL) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_write(NULL, pcm, sizeof(pcm)) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_drain(NULL, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_drain(&output, 0U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(strcmp(iterate_kit_darwin_audio_output_status_name(ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_TIMEOUT),
                "timeout") == 0);
  iterate_kit_darwin_audio_output_close(NULL);
}

/*
 * THE LEAD IS THE HARDWARE'S REQUEST SIZE, NOT A CONSTANT. The queue asks for
 * 20 ms buffers, four in flight; the voice-processing unit asks for about
 * 85 ms at once, so its ring must be allowed to run further ahead or every
 * request at the cap comes up short (see the header).
 */
static void the_pulled_ring_runs_further_ahead_than_the_queue(void)
{
  memset(&output, 0, sizeof(output));
  assert(iterate_kit_darwin_audio_output_open_pulled(&output, NULL) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_lead_bytes(&output) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_PULL_LEAD_BYTES);
  assert(ITERATE_KIT_DARWIN_AUDIO_OUTPUT_PULL_LEAD_BYTES >
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_LEAD_BYTES);
  /* One voice-processing request: 4096 frames at 48 kHz, 1366 samples here. */
  assert(ITERATE_KIT_DARWIN_AUDIO_OUTPUT_PULL_LEAD_BYTES >=
         1366U * 2U + ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  iterate_kit_darwin_audio_output_close(&output);
  open_file_output();
  assert(iterate_kit_darwin_audio_output_lead_bytes(&output) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_LEAD_BYTES);
  close_file_output();
}

/* A barge-in empties the hardware's queue as well as the software's. */
static void a_discard_empties_the_ring_and_the_next_pull_is_silence(void)
{
  uint8_t destination[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES];
  memset(&output, 0, sizeof(output));
  memset(pcm, 0x11, sizeof(pcm));
  assert(iterate_kit_darwin_audio_output_open_pulled(&output, NULL) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, 6U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_pull(&output, destination, sizeof(destination)) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_discard(&output) ==
         5U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_queued_bytes(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_pull(&output, destination, sizeof(destination)) == 0U);
  for (size_t index = 0U; index < sizeof(destination); ++index) assert(destination[index] == 0U);
  assert(iterate_kit_darwin_audio_output_discard(&output) == 0U);
  iterate_kit_darwin_audio_output_close(&output);
}

int main(void)
{
  the_render_tap_records_silence_as_well_as_audio();
  a_full_tap_ring_keeps_the_timeline_length();
  the_pulled_ring_runs_further_ahead_than_the_queue();
  a_discard_empties_the_ring_and_the_next_pull_is_silence();
  drain_accounts_only_payload_that_completed();
  a_full_ring_cannot_look_like_success();
  starvation_has_an_explicit_answer_window();
  trailing_silence_is_not_starvation();
  unusable_arguments_are_refused();
  return 0;
}
