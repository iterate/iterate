#ifndef ITERATE_KIT_SPSC_RING_H
#define ITERATE_KIT_SPSC_RING_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct iterate_kit_spsc_ring_metrics {
  uint32_t messages_published;
  uint32_t messages_consumed;
  uint32_t producer_backpressure;
  uint32_t high_water_slots;
  uint32_t current_slots;
};

/**
 * Allocation-free, lock-free single-producer/single-consumer byte-message
 * ring. The caller supplies one contiguous storage block and one length per
 * slot. Slot count must be a power of two.
 *
 * Acquired storage remains owned by that side until publish/release. Neither
 * side waits: a full producer returns BACKPRESSURE and an empty consumer
 * returns UNAVAILABLE. Exactly one producer and one consumer may use the ring;
 * the API contains no multi-writer arbitration and diagnostic snapshots do not
 * transfer slot ownership.
 *
 * Publish/release are the cross-core visibility boundaries. The implementation
 * uses release/acquire sequence operations so a consumer cannot observe a slot
 * before its bytes and length, and a producer cannot reuse it before release.
 * Sequence wrap is supported because capacity is constrained below half the
 * uint32_t namespace. Operations allocate nothing, call no scheduler primitive,
 * and perform no hidden retry; a higher layer must give full-ring loss its
 * device-specific meaning.
 */
struct iterate_kit_spsc_ring {
  uint8_t *storage;
  size_t slot_size;
  size_t slot_count;
  size_t *lengths;
  uint32_t producer_sequence;
  uint32_t consumer_sequence;
  uint32_t messages_published;
  uint32_t messages_consumed;
  uint32_t producer_backpressure;
  uint32_t high_water_slots;
  uint32_t write_index;
  uint32_t read_index;
  bool write_acquired;
  bool read_acquired;
  bool initialized;
};

enum iterate_kit_status iterate_kit_spsc_ring_init(
    struct iterate_kit_spsc_ring *ring,
    void *storage,
    size_t slot_size,
    size_t slot_count,
    size_t *lengths);

enum iterate_kit_status iterate_kit_spsc_ring_write_acquire(
    struct iterate_kit_spsc_ring *ring,
    void **data,
    size_t *capacity);

/**
 * Acquires producer storage while leaving `reserved_slots` unavailable to this
 * class of message. The reservation is logical, not a second allocation: a
 * caller with stronger ordering requirements can still use ordinary
 * write_acquire() for the final slot. Rejection is counted as normal producer
 * backpressure, preserving the same observability as a physically full ring.
 */
enum iterate_kit_status
iterate_kit_spsc_ring_write_acquire_reserving(
    struct iterate_kit_spsc_ring *ring,
    size_t reserved_slots,
    void **data,
    size_t *capacity);

enum iterate_kit_status iterate_kit_spsc_ring_write_publish(
    struct iterate_kit_spsc_ring *ring,
    size_t length);

enum iterate_kit_status iterate_kit_spsc_ring_write_cancel(
    struct iterate_kit_spsc_ring *ring);

enum iterate_kit_status iterate_kit_spsc_ring_read_acquire(
    struct iterate_kit_spsc_ring *ring,
    const void **data,
    size_t *length);

enum iterate_kit_status iterate_kit_spsc_ring_read_release(
    struct iterate_kit_spsc_ring *ring);

void iterate_kit_spsc_ring_metrics(
    const struct iterate_kit_spsc_ring *ring,
    struct iterate_kit_spsc_ring_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
