#include "iterate/kit/spsc_ring.h"

#include <pthread.h>
#include <sched.h>
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

enum {
  SLOT_COUNT = 4,
  STRESS_MESSAGES = 100000,
};

struct ring_fixture {
  struct iterate_kit_spsc_ring ring;
  uint32_t storage[SLOT_COUNT];
  size_t lengths[SLOT_COUNT];
};

static void fixture_init(struct ring_fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  CHECK(iterate_kit_spsc_ring_init(
      &fixture->ring,
      fixture->storage,
      sizeof(fixture->storage[0]),
      SLOT_COUNT,
      fixture->lengths) == ITERATE_KIT_OK);
}

/*
 * Audio crosses task/core boundaries at high frequency, so the ring must
 * transfer ownership through preallocated slots without blocking or allocating.
 * A convenience queue that copies internally hides RAM and CPU costs, while
 * overwriting on full destroys a buffer still owned by the consumer. This
 * baseline pins direct slot identity, FIFO publication, explicit backpressure,
 * and high-water diagnostics after a complete fill/drain cycle.
 */
static void preserves_order_without_copying_or_blocking(void) {
  struct ring_fixture fixture;
  struct iterate_kit_spsc_ring_metrics metrics;
  void *write_data;
  size_t write_capacity;
  const void *read_data;
  size_t read_size;
  size_t index;
  fixture_init(&fixture);

  for (index = 0U; index < SLOT_COUNT; ++index) {
    CHECK(iterate_kit_spsc_ring_write_acquire(
        &fixture.ring, &write_data, &write_capacity) ==
        ITERATE_KIT_OK);
    CHECK(write_capacity == sizeof(uint32_t));
    CHECK(write_data == &fixture.storage[index]);
    *(uint32_t *)write_data = (uint32_t)(100U + index);
    CHECK(iterate_kit_spsc_ring_write_publish(
        &fixture.ring, sizeof(uint32_t)) == ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_spsc_ring_write_acquire(
      &fixture.ring, &write_data, &write_capacity) ==
      ITERATE_KIT_BACKPRESSURE);

  for (index = 0U; index < SLOT_COUNT; ++index) {
    CHECK(iterate_kit_spsc_ring_read_acquire(
        &fixture.ring, &read_data, &read_size) == ITERATE_KIT_OK);
    CHECK(read_data == &fixture.storage[index]);
    CHECK(read_size == sizeof(uint32_t));
    CHECK(*(const uint32_t *)read_data == (uint32_t)(100U + index));
    CHECK(iterate_kit_spsc_ring_read_release(&fixture.ring) ==
        ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_spsc_ring_read_acquire(
      &fixture.ring, &read_data, &read_size) ==
      ITERATE_KIT_UNAVAILABLE);

  iterate_kit_spsc_ring_metrics(
      &fixture.ring, &metrics);
  CHECK(metrics.messages_published == SLOT_COUNT);
  CHECK(metrics.messages_consumed == SLOT_COUNT);
  CHECK(metrics.producer_backpressure == 1U);
  CHECK(metrics.high_water_slots == SLOT_COUNT);
  CHECK(metrics.current_slots == 0U);
}

/*
 * Speaker and WebSocket APIs may retain a PCM pointer beyond the acquire call.
 * Advancing capacity as soon as the reader acquires would let the producer wrap
 * and overwrite that memory before hardware/transport is finished with it.
 * This scenario proves the oldest slot remains immutable and counts against
 * capacity until explicit release, even while every other slot is published.
 */
static void a_reader_owns_its_slot_until_release(void) {
  struct ring_fixture fixture;
  void *write_data;
  size_t write_capacity;
  const void *read_data;
  size_t read_size;
  size_t index;
  fixture_init(&fixture);

  CHECK(iterate_kit_spsc_ring_write_acquire(
      &fixture.ring, &write_data, &write_capacity) ==
      ITERATE_KIT_OK);
  *(uint32_t *)write_data = 42U;
  CHECK(iterate_kit_spsc_ring_write_publish(
      &fixture.ring, sizeof(uint32_t)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_read_acquire(
      &fixture.ring, &read_data, &read_size) == ITERATE_KIT_OK);
  CHECK(*(const uint32_t *)read_data == 42U);

  for (index = 1U; index < SLOT_COUNT; ++index) {
    CHECK(iterate_kit_spsc_ring_write_acquire(
        &fixture.ring, &write_data, &write_capacity) ==
        ITERATE_KIT_OK);
    *(uint32_t *)write_data = (uint32_t)index;
    CHECK(iterate_kit_spsc_ring_write_publish(
        &fixture.ring, sizeof(uint32_t)) == ITERATE_KIT_OK);
  }
  CHECK(iterate_kit_spsc_ring_write_acquire(
      &fixture.ring, &write_data, &write_capacity) ==
      ITERATE_KIT_BACKPRESSURE);
  CHECK(*(const uint32_t *)read_data == 42U);
  CHECK(iterate_kit_spsc_ring_read_release(&fixture.ring) ==
      ITERATE_KIT_OK);
}

struct stress_context {
  struct ring_fixture fixture;
};

static void *produce(void *context) {
  struct stress_context *stress = context;
  uint32_t value;
  for (value = 0U; value < STRESS_MESSAGES; ++value) {
    void *data;
    size_t capacity;
    while (iterate_kit_spsc_ring_write_acquire(
               &stress->fixture.ring, &data, &capacity) ==
           ITERATE_KIT_BACKPRESSURE) {
      sched_yield();
    }
    CHECK(capacity == sizeof(value));
    memcpy(data, &value, sizeof(value));
    CHECK(iterate_kit_spsc_ring_write_publish(
        &stress->fixture.ring, sizeof(value)) == ITERATE_KIT_OK);
  }
  return NULL;
}

static void *consume(void *context) {
  struct stress_context *stress = context;
  uint32_t expected;
  for (expected = 0U; expected < STRESS_MESSAGES; ++expected) {
    const void *data;
    size_t size;
    while (iterate_kit_spsc_ring_read_acquire(
               &stress->fixture.ring, &data, &size) ==
           ITERATE_KIT_UNAVAILABLE) {
      sched_yield();
    }
    CHECK(size == sizeof(expected));
    CHECK(memcmp(data, &expected, sizeof(expected)) == 0);
    CHECK(iterate_kit_spsc_ring_read_release(
        &stress->fixture.ring) == ITERATE_KIT_OK);
  }
  return NULL;
}

/*
 * Sequential tests cannot expose missing acquire/release ordering between the
 * ESP32-style single producer and single consumer. Replacing the SPSC contract
 * with locks would add priority-inversion risk, while relaxed atomics without
 * the publication edge can expose partially written PCM. This sustained
 * two-thread run proves the lock-free ownership protocol preserves every value
 * in order and keeps observed depth within the fixed allocation.
 */
static void remains_ordered_under_real_parallel_load(void) {
  struct stress_context stress;
  struct iterate_kit_spsc_ring_metrics metrics;
  pthread_t producer;
  pthread_t consumer;
  fixture_init(&stress.fixture);

  CHECK(pthread_create(&producer, NULL, produce, &stress) == 0);
  CHECK(pthread_create(&consumer, NULL, consume, &stress) == 0);
  CHECK(pthread_join(producer, NULL) == 0);
  CHECK(pthread_join(consumer, NULL) == 0);

  iterate_kit_spsc_ring_metrics(
      &stress.fixture.ring, &metrics);
  CHECK(metrics.messages_published == STRESS_MESSAGES);
  CHECK(metrics.messages_consumed == STRESS_MESSAGES);
  CHECK(metrics.current_slots == 0U);
  CHECK(metrics.high_water_slots <= SLOT_COUNT);
}

int main(void) {
  preserves_order_without_copying_or_blocking();
  a_reader_owns_its_slot_until_release();
  remains_ordered_under_real_parallel_load();
  return 0;
}
