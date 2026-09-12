#ifndef ITERATE_KIT_STARVATION_LEDGER_H
#define ITERATE_KIT_STARVATION_LEDGER_H

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/voice_playout.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Absolute audio-empty deadline and saturating counters. Initialize before use.
 * The caller supplies exclusion around EVERY access, including metrics. Supply
 * monotonic microseconds and durations whose deadlines fit in int64_t.
 * This owns no clock, task, hardware or lock. Do not mutate fields directly.
 */
struct iterate_kit_starvation_ledger {
  uint32_t ring_ms;
  bool watching;
  bool draining;
  bool stale_ring;
  int64_t empty_at_us;
  uint32_t written_ms;
  uint32_t starved_ms;
  uint32_t starve_events;
};

/** Lifetime starvation totals and written audio since the latest arm edge. */
struct iterate_kit_starvation_ledger_metrics {
  uint32_t starved_ms;
  uint32_t starve_events;
  uint32_t written_ms;
};

/** Reset an unused ledger with the physical ring duration, in milliseconds. */
void iterate_kit_starvation_ledger_init(
    struct iterate_kit_starvation_ledger *ledger, uint32_t ring_ms);
/** Arm only while feeding; a false-to-true edge resets the opening window.
 * After a flush, credit one stale hardware ring before the first new write.
 */
void iterate_kit_starvation_ledger_watch(
    struct iterate_kit_starvation_ledger *ledger, bool active, int64_t now_us);
/** Mark the normal end-of-answer drain; suppress starvation until re-armed. */
void iterate_kit_starvation_ledger_draining(
    struct iterate_kit_starvation_ledger *ledger);
/** Record an intentional software flush, after disarming and before discard. */
void iterate_kit_starvation_ledger_note_flush(
    struct iterate_kit_starvation_ledger *ledger);
/** Credit audio BEFORE a blocking hardware write and account for prior lateness.
 * Opening writes are exempt until one ring's worth of audio has been credited.
 */
void iterate_kit_starvation_ledger_reserve_write(
    struct iterate_kit_starvation_ledger *ledger, uint32_t ms, int64_t now_us);
/** Undo the matching failed write's reservation; not the preceding lateness. */
void iterate_kit_starvation_ledger_rollback_write(
    struct iterate_kit_starvation_ledger *ledger, uint32_t ms);
/** Whether armed audio remains, including hold_ms of pauses inside an answer. */
bool iterate_kit_starvation_ledger_speaker_is_playing(
    const struct iterate_kit_starvation_ledger *ledger,
    int64_t now_us, uint32_t hold_ms);
/** Copy counters under the caller's lock; out and ledger must be valid. */
void iterate_kit_starvation_ledger_metrics(
    const struct iterate_kit_starvation_ledger *ledger,
    struct iterate_kit_starvation_ledger_metrics *out);
/** Apply a playout phase under the caller's lock. ARRIVED/QUIET do nothing;
 * the board owns amplifier actions. now_us is needed when FEEDING arms.
 */
void iterate_kit_starvation_ledger_phase(
    struct iterate_kit_starvation_ledger *ledger,
    enum iterate_kit_voice_phase phase, int64_t now_us);

#ifdef __cplusplus
}
#endif

#endif
