#include "iterate/kit/atomic.h"

#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
  WRITER_COUNT = 4,
  INCREMENTS_PER_WRITER = 50000,
};

struct counter_fixture {
  uint32_t counter;
  uint32_t writers_finished;
  uint32_t maximum_observed;
};

static void *increment_counter(void *context) {
  struct counter_fixture *fixture = context;
  uint32_t increment;
  for (increment = 0U;
       increment < INCREMENTS_PER_WRITER;
       ++increment) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &fixture->counter);
  }
  iterate_kit_atomic_saturating_increment_relaxed_u32(
      &fixture->writers_finished);
  return NULL;
}

static void *observe_counter(void *context) {
  struct counter_fixture *fixture = context;
  uint32_t previous = 0U;
  while (iterate_kit_atomic_load_relaxed_u32(
             &fixture->writers_finished) < WRITER_COUNT) {
    const uint32_t current =
        iterate_kit_atomic_load_relaxed_u32(&fixture->counter);
    assert(current >= previous);
    iterate_kit_atomic_update_max_relaxed_u32(
        &fixture->maximum_observed, current);
    previous = current;
    sched_yield();
  }
  return NULL;
}

/*
 * The ESP network task owns each WebSocket but the main task samples its
 * diagnostic counters once per second. A plain increment racing an atomic or
 * plain read is undefined C—not merely a slightly stale metric—and optimized
 * builds may lose updates or synthesize impossible observations. Exercise the
 * exact one-writer/one-observer pattern plus extra writers so the primitive
 * remains correct if a counter later gains another producer.
 *
 * Relaxed ordering is intentional: these numbers explain behavior but never
 * publish payload memory or grant permission to use connection state. Paying
 * for acquire/release would not establish any useful additional invariant.
 */
static void diagnostic_counters_remain_atomic_under_parallel_sampling(void) {
  struct counter_fixture fixture = {0};
  pthread_t writers[WRITER_COUNT];
  pthread_t observer;
  uint32_t index;

  assert(pthread_create(
             &observer, NULL, observe_counter, &fixture) == 0);
  for (index = 0U; index < WRITER_COUNT; ++index) {
    assert(pthread_create(
               &writers[index],
               NULL,
               increment_counter,
               &fixture) == 0);
  }
  for (index = 0U; index < WRITER_COUNT; ++index) {
    assert(pthread_join(writers[index], NULL) == 0);
  }
  assert(pthread_join(observer, NULL) == 0);

  assert(
      iterate_kit_atomic_load_relaxed_u32(&fixture.counter) ==
      WRITER_COUNT * INCREMENTS_PER_WRITER);
  assert(
      iterate_kit_atomic_load_relaxed_u32(
          &fixture.maximum_observed) <=
      WRITER_COUNT * INCREMENTS_PER_WRITER);
}

/*
 * Devices may run unattended long enough to exhaust a 32-bit incident count.
 * Wrapping to zero would make a worsening fault appear to have recovered.
 * Saturation therefore means "at least UINT32_MAX" and must survive repeated
 * increments without a special reader-side convention.
 */
static void diagnostic_counter_saturation_never_wraps(void) {
  uint32_t counter = UINT32_MAX - 1U;
  iterate_kit_atomic_saturating_increment_relaxed_u32(&counter);
  assert(counter == UINT32_MAX);
  iterate_kit_atomic_saturating_increment_relaxed_u32(&counter);
  assert(counter == UINT32_MAX);
}

static void diagnostic_add_table(void) {
  const struct { uint32_t before, amount, after; } rows[] = {
    {0, 0, 0}, {0, 12, 12}, {20, 5, 25},
    {UINT32_MAX - 1, 1, UINT32_MAX}, {UINT32_MAX - 1, 2, UINT32_MAX},
    {UINT32_MAX, 0, UINT32_MAX}, {UINT32_MAX, 5, UINT32_MAX},
    {10, UINT32_MAX, UINT32_MAX},
  };
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    volatile uint32_t counter = rows[i].before;
    iterate_kit_atomic_saturating_add_relaxed_u32(&counter, rows[i].amount);
    assert(iterate_kit_atomic_load_relaxed_u32(&counter) == rows[i].after);
  }
}

int main(void) {
  diagnostic_add_table();
  diagnostic_counters_remain_atomic_under_parallel_sampling();
  diagnostic_counter_saturation_never_wraps();
  return 0;
}
