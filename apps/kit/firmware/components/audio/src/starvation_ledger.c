#include "iterate/kit/starvation_ledger.h"

/*
 * M5Stick's authoritative measure: a 600 ms injected Waveshare gap moved its
 * ISR counter by zero, because the descriptors it caught were the REFILL.
 * The deadline is advanced only by writes, never by descriptor callbacks.
 * Waveshare's first attempt subtracted ISR consumption twice: 20 ms credited,
 * then a 15 ms callback, left 5 ms and reported a fictitious 15 ms starvation.
 */
static uint32_t saturating_add(uint32_t value, uint32_t delta) {
  const uint32_t sum = value + delta;
  return sum < value ? 0xffffffffU : sum;
}

void iterate_kit_starvation_ledger_init(
    struct iterate_kit_starvation_ledger *ledger, uint32_t ring_ms) {
  *ledger = (struct iterate_kit_starvation_ledger){.ring_ms = ring_ms};
}

void iterate_kit_starvation_ledger_watch(
    struct iterate_kit_starvation_ledger *ledger, bool active, int64_t now_us) {
  if (active && !ledger->watching) {
    ledger->written_ms = 0U;
    /* A software flush leaves up to one ring in hardware. Assuming empty
     * made Waveshare's first writes after a cut look up to 90 ms late. */
    ledger->empty_at_us = now_us +
        (ledger->stale_ring ? (int64_t)ledger->ring_ms * 1000 : 0);
    ledger->stale_ring = false;
  }
  if (active) ledger->draining = false;
  ledger->watching = active;
}

void iterate_kit_starvation_ledger_draining(
    struct iterate_kit_starvation_ledger *ledger) {
  ledger->draining = true;
}

void iterate_kit_starvation_ledger_note_flush(
    struct iterate_kit_starvation_ledger *ledger) {
  ledger->stale_ring = true;
}

void iterate_kit_starvation_ledger_reserve_write(
    struct iterate_kit_starvation_ledger *ledger, uint32_t ms, int64_t now_us) {
  /* Credit before blocking: Waveshare counted 265 opening underruns for 275
   * played frames when on_sent fired during writes not yet in its ledger.
   * Count audio duration, not sends: a flush can split the first frame. */
  if (ledger->watching && !ledger->draining && ledger->empty_at_us > 0 &&
      ledger->written_ms >= ledger->ring_ms && now_us > ledger->empty_at_us) {
    ledger->starved_ms = saturating_add(
        ledger->starved_ms, (uint32_t)((now_us - ledger->empty_at_us) / 1000));
    ledger->starve_events = saturating_add(ledger->starve_events, 1U);
  }
  const int64_t base_us =
      now_us > ledger->empty_at_us ? now_us : ledger->empty_at_us;
  ledger->empty_at_us = base_us + (int64_t)ms * 1000;
  ledger->written_ms = saturating_add(ledger->written_ms, ms);
}

void iterate_kit_starvation_ledger_rollback_write(
    struct iterate_kit_starvation_ledger *ledger, uint32_t ms) {
  ledger->empty_at_us -= (int64_t)ms * 1000;
  if (ledger->written_ms >= ms) ledger->written_ms -= ms;
}

bool iterate_kit_starvation_ledger_speaker_is_playing(
    const struct iterate_kit_starvation_ledger *ledger,
    int64_t now_us, uint32_t hold_ms) {
  /* HAVPE: "One. Two. Three." has real gaps inside one answer. Without the
   * hold, the uplink opened during each gap and the provider cancelled its
   * answer at "One. Two.". The caller still checks whether a PERSON speaks;
   * this hold spans pauses within an answer without spanning silence after it. */
  return ledger->watching &&
      ledger->empty_at_us + (int64_t)hold_ms * 1000 > now_us;
}

void iterate_kit_starvation_ledger_metrics(
    const struct iterate_kit_starvation_ledger *ledger,
    struct iterate_kit_starvation_ledger_metrics *out) {
  *out = (struct iterate_kit_starvation_ledger_metrics){
    .starved_ms = ledger->starved_ms,
    .starve_events = ledger->starve_events,
    .written_ms = ledger->written_ms,
  };
}

void iterate_kit_starvation_ledger_phase(
    struct iterate_kit_starvation_ledger *ledger,
    enum iterate_kit_voice_phase phase, int64_t now_us) {
  switch (phase) {
    case ITERATE_KIT_VOICE_PHASE_FEEDING:
      iterate_kit_starvation_ledger_watch(ledger, true, now_us);
      break;
    case ITERATE_KIT_VOICE_PHASE_WAITING:
      iterate_kit_starvation_ledger_watch(ledger, false, now_us);
      break;
    case ITERATE_KIT_VOICE_PHASE_DRAINING:
      iterate_kit_starvation_ledger_draining(ledger);
      iterate_kit_starvation_ledger_watch(ledger, false, now_us);
      break;
    case ITERATE_KIT_VOICE_PHASE_FLUSHED:
      /* Disarm before declaring: otherwise an intentional cut is starvation. */
      iterate_kit_starvation_ledger_watch(ledger, false, now_us);
      iterate_kit_starvation_ledger_note_flush(ledger);
      break;
    case ITERATE_KIT_VOICE_PHASE_ARRIVED:
    case ITERATE_KIT_VOICE_PHASE_QUIET:
      break;
  }
}
