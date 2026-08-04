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

static void idle_live_socket_remounts_without_interrupting_a_call(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);

  /*
   * This reproduces a production failure that ordinary socket keepalive
   * cannot see: Cloudflare has forgotten the live capability provider while
   * the device's WebSocket remains READY and continues answering protocol
   * pings. With no new generation or inbound dispatch, a person can walk up
   * to a device that looks connected but whose every remote action fails.
   *
   * A control remount is safe only while the conversation is idle. During a
   * call, replacing the Cap'n Web generation also invalidates the callback
   * exports owned by /pcm, so even an expired idle lease must wait until the
   * current audio session ends. This is why the conversation gate is part of
   * the portable supervisor rather than an ad-hoc target timer.
   */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 100U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 7U,
                         .served_dispatches = 12U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 90100U,
                         .control_ready = true,
                         .conversation_active = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 7U,
                         .served_dispatches = 12U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 90101U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 7U,
                         .served_dispatches = 12U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 180100U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 7U,
                         .served_dispatches = 12U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 180101U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 7U,
                         .served_dispatches = 12U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
  /* The 10 ms owner loop must not turn one expired lease into a retry storm. */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 180111U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 7U,
                         .served_dispatches = 12U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
}

static void inbound_dispatch_or_new_generation_renews_idle_lease(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);

  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 100U,
                         .control_ready = true,
                         .idle_remount_after_ms = 1000U,
                         .ready_generation = 1U,
                         .served_dispatches = 3U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 1099U,
                         .control_ready = true,
                         .idle_remount_after_ms = 1000U,
                         .ready_generation = 1U,
                         .served_dispatches = 4U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 2098U,
                         .control_ready = true,
                         .idle_remount_after_ms = 1000U,
                         .ready_generation = 1U,
                         .served_dispatches = 4U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 2099U,
                         .control_ready = true,
                         .idle_remount_after_ms = 1000U,
                         .ready_generation = 1U,
                         .served_dispatches = 4U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 2100U,
                         .control_ready = true,
                         .idle_remount_after_ms = 1000U,
                         .ready_generation = 2U,
                         .served_dispatches = 4U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
}

/*
 * THE DEFECT THIS FILE EXISTS TO STOP COMING BACK.
 *
 * Measured on the pinned Waveshare board on 2026-08-04: the device lost its
 * server-side mount and stayed unreachable for more than seven minutes with no
 * recovery and no intervention. The server held ZERO connections while the
 * device's console showed uptime climbing, `sent` climbing and an empty outbox —
 * a half-open socket it could not see.
 *
 * Nothing fired. That target had its own inline copy of this decision, and its
 * idle clock was refreshed inside `waveshare_health_json()` — which
 * `append_stats()` also calls every five seconds to build the `dev-stats`
 * telemetry body. The device reset its own "somebody asked us something" marker
 * twelve times a minute by talking to itself, so a 90s watchdog could never
 * expire. Serializing local statistics must never count as remote liveness.
 *
 * `served_dispatches` is the fix: a count of INBOUND capability dispatches, which
 * no amount of outbound telemetry can inflate.
 */
static void periodic_local_telemetry_cannot_suppress_idle_recovery(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);
  /* Arm the lease at t=0 with one dispatch already served. */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 0U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 1U,
                         .served_dispatches = 7U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  /*
   * Now publish telemetry every five seconds for three minutes. The dispatch
   * count does NOT move, because publishing is not being asked anything — so the
   * lease must expire on schedule rather than being renewed forever.
   */
  enum iterate_kit_control_recovery_action action =
      ITERATE_KIT_CONTROL_RECOVERY_NONE;
  uint64_t at = 0U;
  for (unsigned tick = 0U; tick < 36U; ++tick) {
    at += 5000U;
    action = iterate_kit_control_recovery_poll(
        &recovery, &(const struct iterate_kit_control_recovery_observation){
                       .now_ms = at,
                       .control_ready = true,
                       .idle_remount_after_ms = 90000U,
                       .ready_generation = 1U,
                       .served_dispatches = 7U,
                   });
    if (action == ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL) break;
  }
  assert(action == ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
  /* And it must arrive at the interval, not eventually: 90s, not 180s. */
  assert(at == 90000U);
}

/* A real inbound call is proof of reachability, and starts the lease again. */
static void a_real_inbound_dispatch_resets_the_idle_interval(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);
  (void)iterate_kit_control_recovery_poll(
      &recovery, &(const struct iterate_kit_control_recovery_observation){
                     .now_ms = 0U,
                     .control_ready = true,
                     .idle_remount_after_ms = 90000U,
                     .ready_generation = 1U,
                     .served_dispatches = 1U,
                 });
  /* 80s of silence, then somebody asks something. */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 80000U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 1U,
                         .served_dispatches = 2U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  /* 89s after THAT dispatch is still inside the lease. */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 169000U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 1U,
                         .served_dispatches = 2U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  /* 90s after it is not. */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 170000U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 1U,
                         .served_dispatches = 2U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
}

/*
 * A live call is a hard exclusion. Remounting invalidates session-scoped
 * callback exports, so a preventive watchdog that fires mid-conversation turns
 * itself into the audible fault it was written to prevent.
 */
static void an_active_call_is_never_spuriously_remounted(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);
  uint64_t at = 0U;
  for (unsigned tick = 0U; tick < 60U; ++tick) {
    at += 5000U;
    assert(
        iterate_kit_control_recovery_poll(
            &recovery, &(const struct iterate_kit_control_recovery_observation){
                           .now_ms = at,
                           .control_ready = true,
                           .conversation_active = true,
                           .idle_remount_after_ms = 90000U,
                           .ready_generation = 1U,
                           .served_dispatches = 3U,
                       }) != ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
  }
  /* Five minutes of a silent call, and not one remount. When the call ends, the
   * quiet window starts over rather than firing immediately. */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = at + 1000U,
                         .control_ready = true,
                         .idle_remount_after_ms = 90000U,
                         .ready_generation = 1U,
                         .served_dispatches = 3U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
}

/*
 * Recovery is BOUNDED: one remount per idle episode, so a device that cannot
 * re-mount does not thrash its transport forever — and it is OBSERVABLE, because
 * the caller counts each action it is handed.
 */
static void idle_recovery_is_requested_once_per_episode(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);
  unsigned remounts = 0U;
  uint64_t at = 0U;
  (void)iterate_kit_control_recovery_poll(
      &recovery, &(const struct iterate_kit_control_recovery_observation){
                     .now_ms = 0U,
                     .control_ready = true,
                     .idle_remount_after_ms = 90000U,
                     .ready_generation = 1U,
                     .served_dispatches = 1U,
                 });
  for (unsigned tick = 0U; tick < 120U; ++tick) {
    at += 5000U;
    if (iterate_kit_control_recovery_poll(
            &recovery, &(const struct iterate_kit_control_recovery_observation){
                           .now_ms = at,
                           .control_ready = true,
                           .idle_remount_after_ms = 90000U,
                           .ready_generation = 1U,
                           .served_dispatches = 1U,
                       }) == ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL) {
      ++remounts;
    }
  }
  /* Ten minutes of unbroken silence asks for exactly one remount. */
  assert(remounts == 1U);
}

/*
 * And when replacing the transport does not help, the escalation is the
 * transport's own latched failure — which this decision turns into ONE bounded
 * restart carrying a durable reason, not an endless quiet retry.
 */
static void recovery_that_does_not_help_escalates_once_with_a_reason(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);
  /* The remount was asked for and the transport came back latched-failed. */
  (void)iterate_kit_control_recovery_poll(
      &recovery, &(const struct iterate_kit_control_recovery_observation){
                     .now_ms = 0U,
                     .control_ready = true,
                     .idle_remount_after_ms = 90000U,
                     .ready_generation = 1U,
                     .served_dispatches = 1U,
                 });
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 1000U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 120000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 121001U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 120000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_RESTART_PROCESS);
  /* Once. A reboot loop is not an escalation. */
  assert(
      iterate_kit_control_recovery_poll(
          &recovery, &(const struct iterate_kit_control_recovery_observation){
                         .now_ms = 300000U,
                         .fatal_latched = true,
                         .fatal_restart_after_ms = 120000U,
                     }) == ITERATE_KIT_CONTROL_RECOVERY_NONE);
}

/*
 * A REMOUNT BUMPS THE GENERATION, WHICH STARTS A NEW EPISODE.
 *
 * This is the case `idle_recovery_is_requested_once_per_episode` cannot see: it
 * holds `ready_generation` fixed, so the latch it checks never clears. Reality
 * clears it every time — replacing the socket is what a remount DOES — and the
 * result was a healthy board that reconnected every 90s for as long as nobody
 * called it. Measured on the pinned device: idleRemounts 29, sessionGeneration
 * 30, uptime 47 minutes, servedDispatches 5.
 *
 * The wait must therefore double while nothing inbound arrives.
 */
static void an_idle_device_backs_off_instead_of_churning(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);
  uint32_t generation = 1U;
  uint64_t at = 0U;
  const uint64_t base = 90000U;

  const struct iterate_kit_control_recovery_observation quiet = {
    .control_ready = true,
    .idle_remount_after_ms = base,
    .served_dispatches = 4U,
  };
  struct iterate_kit_control_recovery_observation now = quiet;
  now.now_ms = at;
  now.ready_generation = generation;
  (void)iterate_kit_control_recovery_poll(&recovery, &now);

  /* Each remount is expected after a wait that doubles: 90s, 180s, 360s, 720s. */
  const uint64_t expected[] = {base, base * 2U, base * 4U, base * 8U, base * 8U};
  for (unsigned round = 0U; round < 5U; ++round) {
    const uint64_t wait = expected[round];
    /* One tick short of the wait must NOT remount... */
    now.now_ms = at + wait - 1000U;
    now.ready_generation = generation;
    assert(
        iterate_kit_control_recovery_poll(&recovery, &now) !=
        ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
    /* ...and reaching it must. */
    now.now_ms = at + wait;
    assert(
        iterate_kit_control_recovery_poll(&recovery, &now) ==
        ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
    /* The remount replaces the socket, so the generation moves on. */
    at = now.now_ms;
    generation++;
    now.now_ms = at;
    now.ready_generation = generation;
    (void)iterate_kit_control_recovery_poll(&recovery, &now);
  }
  /* Capped: the fifth wait is the same as the fourth, not sixteen times base. */
  assert(expected[4] == base * 8U);
}

/* And one real inbound call makes the device responsive again immediately. */
static void an_inbound_dispatch_clears_the_backoff(void) {
  struct iterate_kit_control_recovery recovery;
  iterate_kit_control_recovery_init(&recovery);
  struct iterate_kit_control_recovery_observation now = {
    .control_ready = true,
    .idle_remount_after_ms = 90000U,
    .ready_generation = 1U,
    .served_dispatches = 1U,
  };
  (void)iterate_kit_control_recovery_poll(&recovery, &now);
  /* Two remounts deep, so the wait is out at 360s. */
  for (unsigned round = 0U; round < 2U; ++round) {
    now.now_ms += 90000U << round;
    assert(
        iterate_kit_control_recovery_poll(&recovery, &now) ==
        ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
    now.ready_generation++;
    (void)iterate_kit_control_recovery_poll(&recovery, &now);
  }
  /* Somebody calls the device. */
  now.now_ms += 1000U;
  now.served_dispatches = 2U;
  (void)iterate_kit_control_recovery_poll(&recovery, &now);
  /* The next idle wait is the short one again: 89s is not enough, 90s is. */
  now.now_ms += 89000U;
  assert(
      iterate_kit_control_recovery_poll(&recovery, &now) !=
      ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
  now.now_ms += 1000U;
  assert(
      iterate_kit_control_recovery_poll(&recovery, &now) ==
      ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL);
}

int main(void) {
  permanent_fatal_state_requests_one_bounded_restart();
  cleared_or_regressed_observations_cannot_trigger_early();
  idle_live_socket_remounts_without_interrupting_a_call();
  inbound_dispatch_or_new_generation_renews_idle_lease();
  periodic_local_telemetry_cannot_suppress_idle_recovery();
  a_real_inbound_dispatch_resets_the_idle_interval();
  an_active_call_is_never_spuriously_remounted();
  idle_recovery_is_requested_once_per_episode();
  recovery_that_does_not_help_escalates_once_with_a_reason();
  an_idle_device_backs_off_instead_of_churning();
  an_inbound_dispatch_clears_the_backoff();
  return 0;
}
