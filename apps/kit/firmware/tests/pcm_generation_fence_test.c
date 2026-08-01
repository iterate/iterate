#include "iterate/kit/pcm_generation_fence.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      fprintf(stderr, "%s:%d: check failed: %s\n",                         \
          __FILE__, __LINE__, #condition);                                   \
      abort();                                                               \
    }                                                                        \
  } while (0)

struct fixture {
  struct iterate_kit_pcm_generation_fence fence;
  uint32_t reset_calls;
  uint32_t notifications;
  enum iterate_kit_status next_reset_result;
};

static enum iterate_kit_status reset_playback(void *context) {
  struct fixture *fixture = context;
  ++fixture->reset_calls;
  return fixture->next_reset_result;
}

static void notify_consumer(void *context) {
  struct fixture *fixture = context;
  ++fixture->notifications;
}

static void fixture_init(struct fixture *fixture) {
  const struct iterate_kit_pcm_generation_fence_options options = {
    .reset = reset_playback,
    .reset_context = fixture,
    .notify_consumer = notify_consumer,
    .notify_consumer_context = fixture,
  };
  memset(fixture, 0, sizeof(*fixture));
  fixture->next_reset_result = ITERATE_KIT_OK;
  CHECK(iterate_kit_pcm_generation_fence_init(
            &fixture->fence, &options) == ITERATE_KIT_OK);
}

/*
 * A socket generation is not admitted merely because the application ring is
 * empty: old assistant speech may still be retained inside the playback
 * owner or cyclic DMA. The first poll must request exactly one physical reset
 * and remain closed. Only the audio owner can service that command, after
 * which the same target becomes admitted without issuing a second reset.
 */
static void admission_waits_for_the_audio_owner(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_generation_fence_metrics metrics;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 7U, true) == ITERATE_KIT_UNAVAILABLE);
  CHECK(fixture.notifications == 1U);
  CHECK(fixture.reset_calls == 0U);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 7U, true) == ITERATE_KIT_UNAVAILABLE);
  CHECK(fixture.notifications == 1U);

  CHECK(iterate_kit_pcm_generation_fence_service(
            &fixture.fence) == ITERATE_KIT_OK);
  CHECK(fixture.reset_calls == 1U);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 7U, true) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 7U, true) == ITERATE_KIT_OK);
  CHECK(fixture.reset_calls == 1U);

  iterate_kit_pcm_generation_fence_metrics(
      &fixture.fence, &metrics);
  CHECK(metrics.requests == 1U);
  CHECK(metrics.completions == 1U);
  CHECK(metrics.failures == 0U);
  CHECK(metrics.accepted_generation == 7U);
  CHECK(metrics.accepted_connected);
}

/*
 * Disconnect is a second barrier for the same numeric socket generation. It
 * must revoke and purge playback even though the generation did not change;
 * comparing generation alone would leave the tail audible after hang-up.
 */
static void connected_state_is_part_of_the_target(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 11U, true) == ITERATE_KIT_UNAVAILABLE);
  CHECK(iterate_kit_pcm_generation_fence_service(
            &fixture.fence) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 11U, true) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 11U, false) == ITERATE_KIT_UNAVAILABLE);
  CHECK(iterate_kit_pcm_generation_fence_service(
            &fixture.fence) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 11U, false) == ITERATE_KIT_OK);
  CHECK(fixture.reset_calls == 2U);
  CHECK(fixture.notifications == 2U);
}

/*
 * The PCM transport is expected to hold one target until it is acknowledged.
 * If a caller nevertheless asks for a newer target while one reset is still
 * pending, overwriting the mailbox could admit a generation whose cleanup
 * never happened. Reject that misuse explicitly and preserve the first job.
 */
static void a_pending_target_cannot_be_overwritten(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_generation_fence_metrics metrics;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 20U, true) == ITERATE_KIT_UNAVAILABLE);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 21U, true) == ITERATE_KIT_BACKPRESSURE);
  CHECK(iterate_kit_pcm_generation_fence_service(
            &fixture.fence) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 20U, true) == ITERATE_KIT_OK);

  iterate_kit_pcm_generation_fence_metrics(
      &fixture.fence, &metrics);
  CHECK(metrics.target_backpressure == 1U);
  CHECK(metrics.accepted_generation == 20U);
}

/*
 * A failed codec/lane purge is not equivalent to a slow acknowledgement. The
 * connection owner must receive the exact terminal result so it can classify
 * the local invariant failure instead of waiting forever or admitting stale
 * audio. Failure remains sticky for that target and is not retried in a loop.
 */
static void reset_failure_is_terminal_and_visible(void) {
  struct fixture fixture;
  struct iterate_kit_pcm_generation_fence_metrics metrics;
  fixture_init(&fixture);
  fixture.next_reset_result = ITERATE_KIT_IO_ERROR;

  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 31U, true) == ITERATE_KIT_UNAVAILABLE);
  CHECK(iterate_kit_pcm_generation_fence_service(
            &fixture.fence) == ITERATE_KIT_IO_ERROR);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 31U, true) == ITERATE_KIT_IO_ERROR);
  CHECK(iterate_kit_pcm_generation_fence_poll(
            &fixture.fence, 31U, true) == ITERATE_KIT_IO_ERROR);
  CHECK(fixture.reset_calls == 1U);

  iterate_kit_pcm_generation_fence_metrics(
      &fixture.fence, &metrics);
  CHECK(metrics.failures == 1U);
  CHECK(metrics.last_failure == ITERATE_KIT_IO_ERROR);
  CHECK(metrics.accepted_generation == 0U);
}

int main(void) {
  admission_waits_for_the_audio_owner();
  connected_state_is_part_of_the_target();
  a_pending_target_cannot_be_overwritten();
  reset_failure_is_terminal_and_visible();
  puts("pcm generation fence tests passed");
  return 0;
}
