#ifndef ITERATE_KIT_ATOMIC_H
#define ITERATE_KIT_ATOMIC_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Small, C99-compatible atomics for independently sampled diagnostics.
 *
 * The firmware is consumed from C, C++, ESP-IDF, and the host fault harness.
 * Using C11 `_Atomic` in public structs would change their source/ABI shape for
 * C++ consumers and force a newer language mode. GCC/Clang's `__atomic`
 * builtins instead operate on the existing uint32_t storage and compile to
 * native lock-free word operations on the ESP32-S3.
 *
 * Every operation here is deliberately relaxed. Diagnostic counters describe
 * work that already happened; they do not publish a payload, transfer object
 * ownership, or grant permission to use a connection. A reader may observe a
 * slightly older count, but it must never participate in a C data race, see a
 * torn word, or watch a saturating counter wrap. State-machine synchronization
 * needs an explicitly acquire/release-named primitive elsewhere—do not extend
 * this API with ambiguous `load` or `store` functions.
 *
 * Static inline functions add no shared object or allocation. Centralizing the
 * compare/exchange loops prevents a seemingly harmless plain increment from
 * being copied into a field that the once-per-second metrics task reads on the
 * other core.
 */

/** Sample an independent diagnostic counter with relaxed ordering. */
static inline uint32_t iterate_kit_atomic_load_relaxed_u32(
    const volatile uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

/** Add one without wrapping; no payload or ownership is published. */
static inline void
iterate_kit_atomic_saturating_increment_relaxed_u32(
    volatile uint32_t *value) {
  uint32_t current =
      iterate_kit_atomic_load_relaxed_u32(value);
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

/** Retain the largest independently sampled value, with relaxed ordering. */
static inline void iterate_kit_atomic_update_max_relaxed_u32(
    volatile uint32_t *value, uint32_t candidate) {
  uint32_t current =
      iterate_kit_atomic_load_relaxed_u32(value);
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

/** Add an amount, saturating at UINT32_MAX. Same relaxed CAS as increment;
 * moved from the CoreS3 capture reserve and avatar diagnostics. Volatile
 * storage is accepted so existing ISR-facing counter layouts stay unchanged.
 */
static inline void iterate_kit_atomic_saturating_add_relaxed_u32(
    volatile uint32_t *value, uint32_t amount) {
  uint32_t current = iterate_kit_atomic_load_relaxed_u32(value);
  while (current != UINT32_MAX) {
    const uint32_t next = amount > UINT32_MAX - current
        ? UINT32_MAX : current + amount;
    if (__atomic_compare_exchange_n(value, &current, next, false,
            __ATOMIC_RELAXED, __ATOMIC_RELAXED)) return;
  }
}

#ifdef __cplusplus
}
#endif

#endif
