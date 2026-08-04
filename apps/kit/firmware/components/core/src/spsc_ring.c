#include "iterate/kit/spsc_ring.h"

#include <limits.h>
#include <string.h>

/*
 * This ring is the small concurrency primitive underneath bounded byte lanes.
 * It is specifically SPSC: one producer owns write_acquired and
 * producer_sequence;
 * one consumer owns read_acquired and consumer_sequence. Supporting multiple
 * writers with a mutex or CAS reservation loop was rejected because audio
 * tasks must never wait behind unrelated work and every current lane already
 * has a natural single owner.
 *
 * A slot's bytes and length are ordinary memory until the producer's release
 * store publishes the next sequence. The consumer's acquire load makes those
 * writes visible before it borrows the slot. Release/acquire in the other
 * direction prevents reuse until the consumer has finished. Owner-local
 * sequence loads and diagnostic counters can remain relaxed; they neither
 * transfer a slot nor grant permission to access one.
 *
 * Unsigned sequence subtraction deliberately tolerates wrap as long as the
 * ring stays below half the uint32_t namespace, which init enforces. Power-of-
 * two capacity turns indexing into a mask without division on the hot path.
 * Full and empty are returned immediately—there is no retry loop, allocation,
 * logging, or scheduler call inside this primitive. Higher layers decide
 * whether fullness means drop, epoch reset, or connection recovery.
 */

static uint32_t atomic_load_relaxed(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static uint32_t atomic_load_acquire(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

static void atomic_store_release(
    uint32_t *destination, uint32_t value) {
  __atomic_store_n(destination, value, __ATOMIC_RELEASE);
}

static void atomic_saturating_increment(uint32_t *value) {
  uint32_t current = atomic_load_relaxed(value);
  while (current != UINT32_MAX &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             current + 1U,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static void atomic_update_max(
    uint32_t *value, uint32_t candidate) {
  uint32_t current = atomic_load_relaxed(value);
  while (candidate > current &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             candidate,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static bool power_of_two(size_t value) {
  return value != 0U && (value & (value - 1U)) == 0U;
}

enum iterate_kit_status iterate_kit_spsc_ring_init(
    struct iterate_kit_spsc_ring *ring,
    void *storage,
    size_t slot_size,
    size_t slot_count,
    size_t *lengths) {
  if (ring == NULL ||
      storage == NULL ||
      slot_size == 0U ||
      !power_of_two(slot_count) ||
      slot_count > (size_t)UINT32_MAX / 2U ||
      slot_count > SIZE_MAX / slot_size ||
      lengths == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(ring, 0, sizeof(*ring));
  memset(lengths, 0, slot_count * sizeof(*lengths));
  ring->storage = storage;
  ring->slot_size = slot_size;
  ring->slot_count = slot_count;
  ring->lengths = lengths;
  ring->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status
iterate_kit_spsc_ring_write_acquire_reserving(
    struct iterate_kit_spsc_ring *ring,
    size_t reserved_slots,
    void **data,
    size_t *capacity) {
  uint32_t producer;
  uint32_t consumer;
  uint32_t index;
  if (data != NULL) {
    *data = NULL;
  }
  if (capacity != NULL) {
    *capacity = 0U;
  }
  if (ring == NULL ||
      !ring->initialized ||
      data == NULL ||
      capacity == NULL ||
      reserved_slots >= ring->slot_count) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (ring->write_acquired) {
    return ITERATE_KIT_STATE_ERROR;
  }

  producer = atomic_load_relaxed(&ring->producer_sequence);
  consumer = atomic_load_acquire(&ring->consumer_sequence);
  if ((uint32_t)(producer - consumer) >=
      ring->slot_count - reserved_slots) {
    atomic_saturating_increment(&ring->producer_backpressure);
    return ITERATE_KIT_BACKPRESSURE;
  }
  index = producer & (uint32_t)(ring->slot_count - 1U);
  ring->write_index = index;
  ring->write_acquired = true;
  *data = ring->storage + ((size_t)index * ring->slot_size);
  *capacity = ring->slot_size;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_spsc_ring_write_acquire(
    struct iterate_kit_spsc_ring *ring,
    void **data,
    size_t *capacity) {
  return iterate_kit_spsc_ring_write_acquire_reserving(
      ring, 0U, data, capacity);
}

enum iterate_kit_status iterate_kit_spsc_ring_write_publish(
    struct iterate_kit_spsc_ring *ring,
    size_t length) {
  uint32_t producer;
  uint32_t consumer;
  uint32_t next;
  uint32_t depth;
  if (ring == NULL || !ring->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!ring->write_acquired) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (length > ring->slot_size) {
    return ITERATE_KIT_LIMIT;
  }

  ring->lengths[ring->write_index] = length;
  producer = atomic_load_relaxed(&ring->producer_sequence);
  next = producer + 1U;
  ring->write_acquired = false;
  /*
   * This release is the publication point for both slot bytes and `lengths`.
   * Moving it earlier, or weakening it to relaxed, permits the other core to
   * observe a new sequence while still seeing an old payload.
   */
  atomic_store_release(&ring->producer_sequence, next);
  atomic_saturating_increment(&ring->messages_published);
  consumer = atomic_load_acquire(&ring->consumer_sequence);
  depth = next - consumer;
  atomic_update_max(&ring->high_water_slots, depth);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_spsc_ring_write_cancel(
    struct iterate_kit_spsc_ring *ring) {
  if (ring == NULL || !ring->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!ring->write_acquired) {
    return ITERATE_KIT_STATE_ERROR;
  }
  ring->write_acquired = false;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_spsc_ring_read_acquire(
    struct iterate_kit_spsc_ring *ring,
    const void **data,
    size_t *length) {
  uint32_t producer;
  uint32_t consumer;
  uint32_t index;
  if (data != NULL) {
    *data = NULL;
  }
  if (length != NULL) {
    *length = 0U;
  }
  if (ring == NULL ||
      !ring->initialized ||
      data == NULL ||
      length == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (ring->read_acquired) {
    return ITERATE_KIT_STATE_ERROR;
  }

  consumer = atomic_load_relaxed(&ring->consumer_sequence);
  producer = atomic_load_acquire(&ring->producer_sequence);
  if (consumer == producer) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  index = consumer & (uint32_t)(ring->slot_count - 1U);
  ring->read_index = index;
  ring->read_acquired = true;
  *data = ring->storage + ((size_t)index * ring->slot_size);
  *length = ring->lengths[index];
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_spsc_ring_read_release(
    struct iterate_kit_spsc_ring *ring) {
  uint32_t consumer;
  if (ring == NULL || !ring->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!ring->read_acquired) {
    return ITERATE_KIT_STATE_ERROR;
  }
  consumer = atomic_load_relaxed(&ring->consumer_sequence);
  ring->read_acquired = false;
  atomic_store_release(
      &ring->consumer_sequence, consumer + 1U);
  atomic_saturating_increment(&ring->messages_consumed);
  return ITERATE_KIT_OK;
}

void iterate_kit_spsc_ring_metrics(
    const struct iterate_kit_spsc_ring *ring,
    struct iterate_kit_spsc_ring_metrics *metrics) {
  uint32_t producer;
  uint32_t consumer;
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (ring == NULL || !ring->initialized) {
    return;
  }
  producer = atomic_load_acquire(&ring->producer_sequence);
  consumer = atomic_load_acquire(&ring->consumer_sequence);
  metrics->messages_published =
      atomic_load_relaxed(&ring->messages_published);
  metrics->messages_consumed =
      atomic_load_relaxed(&ring->messages_consumed);
  metrics->producer_backpressure =
      atomic_load_relaxed(&ring->producer_backpressure);
  metrics->high_water_slots =
      atomic_load_relaxed(&ring->high_water_slots);
  metrics->current_slots = producer - consumer;
}
