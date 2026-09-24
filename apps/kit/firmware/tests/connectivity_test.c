#include "iterate/kit/connectivity.h"

#include <assert.h>
#include <stddef.h>
#include <string.h>

/* A wrong Wi-Fi password: connecting for 15 s from boot, then no-wifi. */
static void a_board_that_never_joins_wifi_says_so_after_fifteen_seconds(void) {
  struct iterate_kit_connectivity_tracker tracker = {0};
  const enum iterate_kit_network_stage stage = ITERATE_KIT_NETWORK_STAGE_JOINING_WIFI;
  assert(iterate_kit_connectivity_update(&tracker, 1200U, false, stage) ==
         ITERATE_KIT_CONNECTIVITY_CONNECTING);
  assert(iterate_kit_connectivity_update(&tracker, 16199U, false, stage) ==
         ITERATE_KIT_CONNECTIVITY_CONNECTING);
  assert(iterate_kit_connectivity_update(&tracker, 16200U, false, stage) ==
         ITERATE_KIT_CONNECTIVITY_NO_WIFI);
  assert(iterate_kit_connectivity_offline(ITERATE_KIT_CONNECTIVITY_NO_WIFI));
  assert(strcmp(iterate_kit_connectivity_name(ITERATE_KIT_CONNECTIVITY_NO_WIFI), "no-wifi") == 0);
}

/* The verdict follows the newest attempt's stage, not the first one's. */
static void the_verdict_names_where_the_newest_attempt_got_stuck(void) {
  struct iterate_kit_connectivity_tracker tracker = {0};
  (void)iterate_kit_connectivity_update(
      &tracker, 0U, false, ITERATE_KIT_NETWORK_STAGE_JOINING_WIFI);
  assert(iterate_kit_connectivity_update(
             &tracker, 20000U, false, ITERATE_KIT_NETWORK_STAGE_REACHING_HOST) ==
         ITERATE_KIT_CONNECTIVITY_NO_INTERNET);
  assert(iterate_kit_connectivity_update(
             &tracker, 21000U, false, ITERATE_KIT_NETWORK_STAGE_REACHING_ITERATE) ==
         ITERATE_KIT_CONNECTIVITY_NO_ITERATE);
  assert(strcmp(
             iterate_kit_connectivity_status(ITERATE_KIT_CONNECTIVITY_NO_ITERATE),
             "couldn't reach iterate") == 0);
}

/* Mounting clears the verdict at once; losing it starts a fresh 15 s. */
static void a_mount_clears_the_verdict_and_a_drop_gets_a_fresh_grace_period(void) {
  struct iterate_kit_connectivity_tracker tracker = {0};
  const enum iterate_kit_network_stage stage = ITERATE_KIT_NETWORK_STAGE_REACHING_HOST;
  (void)iterate_kit_connectivity_update(&tracker, 0U, false, stage);
  assert(iterate_kit_connectivity_update(&tracker, 30000U, false, stage) ==
         ITERATE_KIT_CONNECTIVITY_NO_INTERNET);
  assert(iterate_kit_connectivity_update(&tracker, 30050U, true, stage) ==
         ITERATE_KIT_CONNECTIVITY_ONLINE);
  assert(iterate_kit_connectivity_update(&tracker, 90000U, false, stage) ==
         ITERATE_KIT_CONNECTIVITY_CONNECTING);
  assert(iterate_kit_connectivity_update(&tracker, 104999U, false, stage) ==
         ITERATE_KIT_CONNECTIVITY_CONNECTING);
  assert(iterate_kit_connectivity_update(&tracker, 105000U, false, stage) ==
         ITERATE_KIT_CONNECTIVITY_NO_INTERNET);
}

static void only_the_three_failures_are_offline(void) {
  assert(!iterate_kit_connectivity_offline(ITERATE_KIT_CONNECTIVITY_ONLINE));
  assert(!iterate_kit_connectivity_offline(ITERATE_KIT_CONNECTIVITY_CONNECTING));
  assert(iterate_kit_connectivity_status(ITERATE_KIT_CONNECTIVITY_ONLINE) == NULL);
  assert(iterate_kit_connectivity_status(ITERATE_KIT_CONNECTIVITY_CONNECTING) == NULL);
}

int main(void) {
  a_board_that_never_joins_wifi_says_so_after_fifteen_seconds();
  the_verdict_names_where_the_newest_attempt_got_stuck();
  a_mount_clears_the_verdict_and_a_drop_gets_a_fresh_grace_period();
  only_the_three_failures_are_offline();
  return 0;
}
