#include "iterate/kit/starvation_ledger.h"

#include <assert.h>
#include <stddef.h>

/** A caller action; the test supplies the monotonic clock instead of hardware. */
enum ledger_operation_kind {
  PHASE, WATCH, DRAINING, FLUSH, RESERVE, ROLLBACK,
};

/** One ordered ledger call. Duration is milliseconds; timestamp is microseconds. */
struct ledger_operation {
  enum ledger_operation_kind kind;
  int64_t now_us;
  uint32_t ms;
  enum iterate_kit_voice_phase phase;
  bool active;
};

/** Ring geometry and calls, followed by the exact counters and speaker level. */
struct ledger_case {
  const char *name;
  uint32_t ring_ms;
  struct ledger_operation operations[10];
  size_t count;
  int64_t observe_us;
  uint32_t hold_ms;
  struct {
    uint32_t starved_ms;
    uint32_t starve_events;
    uint32_t written_ms;
    bool speaker_playing;
  } becomes;
};

int main(void) {
  const struct ledger_case cases[] = {
    {"idle", 60, {{0}}, 0, 1000000, 800, {0, 0, 0, false}},
    {"unwatched local audio is not starvation", 60, {
      {RESERVE, 1000, 60, 0, false},
      {RESERVE, 1000000, 20, 0, false},
    }, 2, 1000001, 0, {0, 0, 80, false}},
    {"opening fragments do not fill a ring until credited", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 20, 0, false},
      {RESERVE, 1100000, 20, 0, false},
      {RESERVE, 1200000, 20, 0, false},
      {RESERVE, 1260000, 20, 0, false},
    }, 5, 1270000, 0, {40, 1, 80, true}},
    {"600 ms injected gap", 60, {
      {PHASE, 1000000, 0, ITERATE_KIT_VOICE_PHASE_FEEDING, false},
      {RESERVE, 1000000, 60, 0, false},
      {RESERVE, 1660000, 20, 0, false},
    }, 3, 1680000, 0, {600, 1, 80, false}},
    {"hold spans answer pauses", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
    }, 2, 1859999, 800, {0, 0, 60, true}},
    {"hold expires at exact deadline", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
    }, 2, 1860000, 800, {0, 0, 60, false}},
    {"feeding repeatedly preserves deadline and opening credit", 60, {
      {PHASE, 1000000, 0, ITERATE_KIT_VOICE_PHASE_FEEDING, false},
      {RESERVE, 1000000, 60, 0, false},
      {PHASE, 1100000, 0, ITERATE_KIT_VOICE_PHASE_FEEDING, false},
      {RESERVE, 1100000, 20, 0, false},
    }, 4, 1100000, 0, {40, 1, 80, true}},
    {"waiting disarms despite a held speaker deadline", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
      {PHASE, 1010000, 0, ITERATE_KIT_VOICE_PHASE_WAITING, false},
      {RESERVE, 1200000, 20, 0, false},
    }, 4, 1200000, 800, {0, 0, 80, false}},
    {"draining phase is an intentional end", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
      {PHASE, 1010000, 0, ITERATE_KIT_VOICE_PHASE_DRAINING, false},
      {RESERVE, 1200000, 20, 0, false},
    }, 4, 1200000, 800, {0, 0, 80, false}},
    {"direct drain suppresses accounting until feeding resumes", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
      {DRAINING, 0, 0, 0, false},
      {RESERVE, 1200000, 20, 0, false},
      {WATCH, 1240000, 0, 0, true},
      {RESERVE, 1240000, 20, 0, false},
    }, 6, 1240000, 0, {20, 1, 100, true}},
    {"flush grants one stale ring at rearm", 60, {
      {WATCH, 1000, 0, 0, true},
      {RESERVE, 1000, 60, 0, false},
      {PHASE, 10000, 0, ITERATE_KIT_VOICE_PHASE_FLUSHED, false},
      {PHASE, 100000, 0, ITERATE_KIT_VOICE_PHASE_FEEDING, false},
      {RESERVE, 100000, 60, 0, false},
      {RESERVE, 210000, 20, 0, false},
    }, 6, 239999, 0, {0, 0, 80, true}},
    {"normal drain does not grant stale ring credit", 60, {
      {WATCH, 1000, 0, 0, true},
      {RESERVE, 1000, 60, 0, false},
      {PHASE, 10000, 0, ITERATE_KIT_VOICE_PHASE_DRAINING, false},
      {PHASE, 100000, 0, ITERATE_KIT_VOICE_PHASE_FEEDING, false},
      {RESERVE, 100000, 60, 0, false},
      {RESERVE, 210000, 20, 0, false},
    }, 6, 210000, 0, {50, 1, 80, true}},
    {"direct flush respects the supplied ring geometry", 90, {
      {FLUSH, 0, 0, 0, false},
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 90, 0, false},
      {RESERVE, 1170000, 20, 0, false},
    }, 4, 1199999, 0, {0, 0, 110, true}},
    {"failed reservation restores credit and deadline", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
      {RESERVE, 1000000, 20, 0, false},
      {ROLLBACK, 0, 20, 0, false},
      {RESERVE, 1070000, 20, 0, false},
    }, 5, 1070000, 0, {10, 1, 80, true}},
    {"failed late write does not erase preceding starvation", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
      {RESERVE, 1100000, 20, 0, false},
      {ROLLBACK, 0, 20, 0, false},
    }, 4, 1100000, 0, {40, 1, 60, false}},
    {"amplifier phases do not touch the ledger", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
      {PHASE, 1000001, 0, ITERATE_KIT_VOICE_PHASE_ARRIVED, false},
      {PHASE, 1000002, 0, ITERATE_KIT_VOICE_PHASE_QUIET, false},
    }, 4, 1000002, 0, {0, 0, 60, true}},
    {"fractional-ms gap still counts one event", 60, {
      {WATCH, 1000000, 0, 0, true},
      {RESERVE, 1000000, 60, 0, false},
      {RESERVE, 1060001, 20, 0, false},
    }, 3, 1060001, 0, {0, 1, 80, true}},
    {"written duration saturates", 60, {
      {RESERVE, 1000, UINT32_MAX - 10, 0, false},
      {RESERVE, 1000, 20, 0, false},
    }, 2, 1000, 0, {0, 0, UINT32_MAX, false}},
    {"starved duration saturates", 1, {
      {WATCH, 1000, 0, 0, true},
      {RESERVE, 1000, 1, 0, false},
      {RESERVE, 4294967292000LL, 1, 0, false},
      {RESERVE, 4294967303000LL, 1, 0, false},
    }, 4, 4294967303000LL, 0, {UINT32_MAX, 2, 3, true}},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    struct iterate_kit_starvation_ledger ledger;
    iterate_kit_starvation_ledger_init(&ledger, cases[i].ring_ms);
    for (size_t j = 0; j < cases[i].count; ++j) {
      const struct ledger_operation *operation = &cases[i].operations[j];
      switch (operation->kind) {
        case PHASE:
          iterate_kit_starvation_ledger_phase(&ledger, operation->phase, operation->now_us);
          break;
        case WATCH:
          iterate_kit_starvation_ledger_watch(&ledger, operation->active, operation->now_us);
          break;
        case DRAINING:
          iterate_kit_starvation_ledger_draining(&ledger);
          break;
        case FLUSH:
          iterate_kit_starvation_ledger_note_flush(&ledger);
          break;
        case RESERVE:
          iterate_kit_starvation_ledger_reserve_write(&ledger, operation->ms, operation->now_us);
          break;
        case ROLLBACK:
          iterate_kit_starvation_ledger_rollback_write(&ledger, operation->ms);
          break;
      }
    }
    struct iterate_kit_starvation_ledger_metrics metrics;
    iterate_kit_starvation_ledger_metrics(&ledger, &metrics);
    assert(metrics.starved_ms == cases[i].becomes.starved_ms);
    assert(metrics.starve_events == cases[i].becomes.starve_events);
    assert(metrics.written_ms == cases[i].becomes.written_ms);
    assert(iterate_kit_starvation_ledger_speaker_is_playing(
        &ledger, cases[i].observe_us, cases[i].hold_ms) == cases[i].becomes.speaker_playing);
  }
  return 0;
}
