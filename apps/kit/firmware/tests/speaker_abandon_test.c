/*
 * Throwing queued speaker audio away, in the one order that does not lie.
 *
 * `spkStarveEvents` is the never-tier gate: milliseconds the DAC had an empty
 * ring while the device was meant to be feeding it. Abandoning audio on purpose
 * empties that ring, so unless the watch is disarmed FIRST, the absolute
 * audio-empty deadline it holds passes with nothing written and the device
 * reports a starvation it caused deliberately.
 *
 * Measured on 2026-08-04, session 5 turn 7 of the ten-session acceptance run:
 * the bridge had raced 13,020ms of audio ahead of realtime, the hang-up arrived
 * with the ring still that deep, and the counter moved by 1 — failing the run at
 * 5/10. The audit that followed found five abandon sites with three orderings:
 * two disarmed AFTER the discard, two never disarmed, one was right.
 */
#include "iterate/kit/speaker_abandon.h"

#include <assert.h>
#include <string.h>

enum { MAX_STEPS = 16 };

/** What a caller did, in the order it did it. */
struct recorder {
  const char *steps[MAX_STEPS];
  unsigned count;
  uint32_t queued_bytes;
  uint32_t discarded;
  int reprimed;
};

static void note(struct recorder *r, const char *step) {
  if (r->count < MAX_STEPS) r->steps[r->count++] = step;
}
static void on_disarm(void *c) { note((struct recorder *)c, "disarm"); }
static void on_flush(void *c) { note((struct recorder *)c, "flush"); }
static uint32_t on_buffered(void *c) {
  struct recorder *r = (struct recorder *)c;
  note(r, "read");
  return r->queued_bytes;
}
static void on_discard(void *c, uint32_t bytes) {
  struct recorder *r = (struct recorder *)c;
  note(r, "discard");
  r->discarded = bytes;
}
static void on_reprime(void *c) {
  struct recorder *r = (struct recorder *)c;
  note(r, "reprime");
  r->reprimed = 1;
}

static const struct iterate_kit_speaker_abandon_hooks all_hooks = {
  on_disarm, on_flush, on_buffered, on_discard, on_reprime,
};

static unsigned index_of(const struct recorder *r, const char *step) {
  for (unsigned at = 0U; at < r->count; ++at) {
    if (strcmp(r->steps[at], step) == 0) return at;
  }
  return MAX_STEPS;
}

/* The observed edge: a hang-up with thirteen seconds queued ahead. */
static void a_hangup_with_thirteen_seconds_queued_does_not_starve(void) {
  /* 13,020ms of 16kHz mono s16le is what the failing turn actually held. */
  struct recorder r = {.queued_bytes = 13020U * 16U * 2U};
  const uint32_t abandoned = iterate_kit_speaker_abandon(&all_hooks, &r);
  assert(abandoned == r.queued_bytes);
  assert(r.discarded == r.queued_bytes);
  assert(r.reprimed == 1);
  /* The watch is off BEFORE the audio is taken away, so the deadline it was
   * holding can never expire against a source that no longer exists. */
  assert(index_of(&r, "disarm") < index_of(&r, "read"));
  assert(index_of(&r, "disarm") < index_of(&r, "discard"));
  assert(index_of(&r, "disarm") < index_of(&r, "reprime"));
}

/* And the ring is marked stale, so the NEXT real playout re-arms honestly. */
static void the_next_playout_rearms_against_a_fresh_ring(void) {
  struct recorder r = {.queued_bytes = 4096U};
  (void)iterate_kit_speaker_abandon(&all_hooks, &r);
  assert(index_of(&r, "flush") < MAX_STEPS);
  /* Stale-marking must also precede the discard: the flush is what makes the
   * next arm start its deadline a full ring in the future instead of measuring
   * against audio that was thrown away. */
  assert(index_of(&r, "flush") < index_of(&r, "discard"));
  assert(index_of(&r, "disarm") < index_of(&r, "flush"));
  /* Reprime is last, so the reader cannot reopen the DAC mid-teardown. */
  assert(index_of(&r, "reprime") == r.count - 1U);
}

/*
 * Every intentional-abandon path — barge-in, supersede, hang-up, call
 * replacement, a new turn's flush — is the same sequence. That is the fix: not
 * five hand-ordered sites, one funnel.
 */
static void every_abandon_path_produces_the_same_ordering(void) {
  const uint32_t queues[] = {0U, 1U, 640U, 96000U, 416640U};
  for (unsigned at = 0U; at < sizeof(queues) / sizeof(queues[0]); ++at) {
    struct recorder r = {.queued_bytes = queues[at]};
    (void)iterate_kit_speaker_abandon(&all_hooks, &r);
    assert(r.count == 5U);
    assert(strcmp(r.steps[0], "disarm") == 0);
    assert(strcmp(r.steps[1], "flush") == 0);
    assert(strcmp(r.steps[2], "read") == 0);
    assert(strcmp(r.steps[3], "discard") == 0);
    assert(strcmp(r.steps[4], "reprime") == 0);
  }
}

/* An empty ring is still an abandon: the watch must come off regardless. */
static void an_empty_queue_still_disarms(void) {
  struct recorder r = {.queued_bytes = 0U};
  assert(iterate_kit_speaker_abandon(&all_hooks, &r) == 0U);
  assert(strcmp(r.steps[0], "disarm") == 0);
  assert(r.reprimed == 1);
}

/* A caller with nothing to reprime is a caller, not a crash. */
static void partial_hooks_are_tolerated_without_reordering(void) {
  struct recorder r = {.queued_bytes = 320U};
  const struct iterate_kit_speaker_abandon_hooks partial = {
    on_disarm, NULL, on_buffered, on_discard, NULL,
  };
  assert(iterate_kit_speaker_abandon(&partial, &r) == 320U);
  assert(r.count == 3U);
  assert(strcmp(r.steps[0], "disarm") == 0);
  assert(index_of(&r, "disarm") < index_of(&r, "discard"));
  assert(r.reprimed == 0);
  /* And no hooks at all is a no-op, not a fault. */
  assert(iterate_kit_speaker_abandon(NULL, &r) == 0U);
}

int main(void) {
  a_hangup_with_thirteen_seconds_queued_does_not_starve();
  the_next_playout_rearms_against_a_fresh_ring();
  every_abandon_path_produces_the_same_ordering();
  an_empty_queue_still_disarms();
  partial_hooks_are_tolerated_without_reordering();
  return 0;
}
