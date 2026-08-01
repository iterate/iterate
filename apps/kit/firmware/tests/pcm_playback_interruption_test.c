#include "iterate/kit/pcm_playback_interruption.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      fprintf(                                                              \
          stderr, "%s:%d: check failed: %s\n",                            \
          __FILE__, __LINE__, #condition);                                   \
      abort();                                                               \
    }                                                                        \
  } while (0)

struct fixture {
  struct iterate_kit_pcm_playback_interruption interruption;
  uint32_t resets;
  uint32_t notifications;
  enum iterate_kit_status next_reset_result;
};

static enum iterate_kit_status reset_playback(void *context) {
  struct fixture *fixture = context;
  ++fixture->resets;
  return fixture->next_reset_result;
}

static void notify_audio_owner(void *context) {
  struct fixture *fixture = context;
  ++fixture->notifications;
}

static void fixture_init(struct fixture *fixture) {
  const struct iterate_kit_pcm_playback_interruption_options options = {
    .reset = reset_playback,
    .reset_context = fixture,
    .notify_consumer = notify_audio_owner,
    .notify_consumer_context = fixture,
  };
  memset(fixture, 0, sizeof(*fixture));
  fixture->next_reset_result = ITERATE_KIT_OK;
  CHECK(iterate_kit_pcm_playback_interruption_init(
            &fixture->interruption, &options) == ITERATE_KIT_OK);
}

/*
 * An RPC admission is not an interruption acknowledgement. The speaker task
 * may still hold a partial frame after the control task has emptied every
 * visible queue. This test exists to prevent the tempting but false shortcut
 * of returning true when a reset flag is merely set: the token remains
 * UNAVAILABLE until the physical owner has synchronously purged its state.
 */
static void acknowledgement_waits_for_physical_reset(void) {
  struct fixture fixture;
  uint32_t token = 0U;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_playback_interruption_request(
            &fixture.interruption, &token) == ITERATE_KIT_OK);
  CHECK(token == 1U);
  CHECK(fixture.resets == 0U);
  CHECK(fixture.notifications == 1U);
  CHECK(iterate_kit_pcm_playback_interruption_poll(
            &fixture.interruption, token) == ITERATE_KIT_UNAVAILABLE);

  CHECK(iterate_kit_pcm_playback_interruption_service(
            &fixture.interruption) == ITERATE_KIT_OK);
  CHECK(fixture.resets == 1U);
  CHECK(iterate_kit_pcm_playback_interruption_poll(
            &fixture.interruption, token) == ITERATE_KIT_OK);
}

/*
 * There is no backlog of interruption work. A second request while one purge
 * is unresolved would either overwrite the first acknowledgement or queue an
 * obsolete reset in front of current audio. Both violate the realtime design,
 * so admission is explicitly bounded to one token and reports pressure.
 */
static void an_unresolved_request_cannot_grow_a_queue(void) {
  struct fixture fixture;
  uint32_t first = 0U;
  uint32_t second = 0U;
  fixture_init(&fixture);

  CHECK(iterate_kit_pcm_playback_interruption_request(
            &fixture.interruption, &first) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_playback_interruption_request(
            &fixture.interruption, &second) == ITERATE_KIT_BACKPRESSURE);
  CHECK(second == 0U);
  CHECK(fixture.notifications == 1U);
  CHECK(iterate_kit_pcm_playback_interruption_service(
            &fixture.interruption) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_playback_interruption_poll(
            &fixture.interruption, first) == ITERATE_KIT_OK);

  CHECK(iterate_kit_pcm_playback_interruption_request(
            &fixture.interruption, &second) == ITERATE_KIT_OK);
  CHECK(second == 2U);
}

/*
 * A failed purge cannot be re-labelled as delay or success. Userspace relies
 * on literal true to release its downlink generation fence; propagating the
 * exact terminal status ensures fresh provider audio is never admitted behind
 * a speaker state that may still contain pre-interruption samples.
 */
static void reset_failure_is_the_token_result(void) {
  struct fixture fixture;
  uint32_t token = 0U;
  fixture_init(&fixture);
  fixture.next_reset_result = ITERATE_KIT_IO_ERROR;

  CHECK(iterate_kit_pcm_playback_interruption_request(
            &fixture.interruption, &token) == ITERATE_KIT_OK);
  CHECK(iterate_kit_pcm_playback_interruption_service(
            &fixture.interruption) == ITERATE_KIT_IO_ERROR);
  CHECK(iterate_kit_pcm_playback_interruption_poll(
            &fixture.interruption, token) == ITERATE_KIT_IO_ERROR);
  CHECK(iterate_kit_pcm_playback_interruption_request(
            &fixture.interruption, &token) == ITERATE_KIT_IO_ERROR);
  CHECK(fixture.resets == 1U);
}

int main(void) {
  acknowledgement_waits_for_physical_reset();
  an_unresolved_request_cannot_grow_a_queue();
  reset_failure_is_the_token_result();
  puts("pcm playback interruption tests passed");
  return 0;
}
