#include "iterate/kit/control_recovery.h"

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>

static void permanent_fatal_state_requests_one_bounded_restart(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);

  /*
   * Ordinary FAILED generations remain the transport's responsibility. Only
   * its explicit fatal latch authorizes a process restart; conflating the two
   * would turn routine Wi-Fi or peer failures into reboot loops.
   */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 100U,
                         .fatal_restart_after_ms = 5000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 200U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 5000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 5199U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 5000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 5200U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 5000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_RESTART_PROCESS);
  /* A caller that is slow to restart must not receive a 100 Hz action storm. */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 5300U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 5000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
}

static void cleared_or_regressed_observations_cannot_trigger_early(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);

  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 10000U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 1000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  /*
   * A monotonic-clock regression is itself abnormal, but unsigned underflow
   * must not manufacture an enormous elapsed interval and reboot immediately.
   * Restart the grace window from the observed clock instead.
   */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 9000U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 1000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 9999U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 1000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 10000U,
                         .fatal_restart_after_ms = 1000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 20000U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 1000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 21000U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 1000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_RESTART_PROCESS);
}

static void each_replacement_control_generation_restarts_pcm_once(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);

  /*
   * Recurring Cap'n Web callback exports die with their socket generation.
   * The userspace /pcm session owns those callbacks, so a freshly READY control
   * generation must replace an already-started PCM generation exactly once.
   * The first READY merely authorizes the initial PCM start and must not cause
   * a redundant disconnect during boot.
   */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 10U,
                         .fatal_restart_after_ms = 5000U,
                         .ready_generation = 1U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 20U,
                         .fatal_restart_after_ms = 5000U,
                         .pcm_started = true,
                         .ready_generation = 1U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 30U,
                         .fatal_restart_after_ms = 5000U,
                         .pcm_started = true,
                         .ready_generation = 2U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_RESTART_PCM);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 40U,
                         .fatal_restart_after_ms = 5000U,
                         .pcm_started = true,
                         .ready_generation = 2U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 50U,
                         .fatal_restart_after_ms = 5000U,
                         .pcm_started = true,
                         .ready_generation = 3U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_RESTART_PCM);
}

int main(void) {
  permanent_fatal_state_requests_one_bounded_restart();
  cleared_or_regressed_observations_cannot_trigger_early();
  each_replacement_control_generation_restarts_pcm_once();
  return 0;
}
