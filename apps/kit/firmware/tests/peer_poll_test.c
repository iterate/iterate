#include "iterate/kit/peer.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>

struct poll_fixture {
  struct iterate_kit_poll_result result;
  size_t calls;
};

static struct iterate_kit_poll_result poll_module(
    void *context, uint64_t now_ms) {
  struct poll_fixture *fixture = context;
  (void)now_ms;
  ++fixture->calls;
  return fixture->result;
}

static void test_callback_rejection_ends_only_that_subscription(void) {
  struct poll_fixture expired_subscription = {
    {ITERATE_KIT_POLL_CALLBACK_REJECTED, CAPNWEB_OK},
    0U,
  };
  struct poll_fixture independent_module = {
    {ITERATE_KIT_POLL_OK, CAPNWEB_OK},
    0U,
  };
  const struct iterate_kit_module modules[] = {
    {NULL, 0U, &expired_subscription, poll_module, NULL, NULL},
    {NULL, 0U, &independent_module, poll_module, NULL, NULL},
  };
  const struct iterate_kit_peer_options options = {
    "{}",
    2U,
    modules,
    sizeof(modules) / sizeof(modules[0]),
  };
  struct iterate_kit_peer peer = {0};
  struct iterate_kit_poll_result result;

  assert(iterate_kit_peer_init(&peer, &options) == CAPNWEB_OK);

  /*
   * A rejected remote callback means its owning JS subscription ended. It is
   * not a fault in the physical device, and it must not starve later modules
   * for one owner-loop turn. Starvation matters here because a later module
   * may own button events or another realtime-adjacent callback lifecycle.
   */
  result = iterate_kit_peer_poll(&peer, 100U);
  assert(result.status == ITERATE_KIT_POLL_CALLBACK_REJECTED);
  assert(expired_subscription.calls == 1U);
  assert(independent_module.calls == 1U);
  assert(iterate_kit_peer_subscription_callback_rejections(&peer) == 1U);

  expired_subscription.result = (struct iterate_kit_poll_result){
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
  result = iterate_kit_peer_poll(&peer, 101U);
  assert(result.status == ITERATE_KIT_POLL_OK);
  assert(independent_module.calls == 2U);
  assert(iterate_kit_peer_subscription_callback_rejections(&peer) == 1U);
}

static void test_actual_failure_still_stops_and_wins(void) {
  struct poll_fixture expired_subscription = {
    {ITERATE_KIT_POLL_CALLBACK_REJECTED, CAPNWEB_OK},
    0U,
  };
  struct poll_fixture failed_module = {
    {ITERATE_KIT_POLL_DRIVER_ERROR, CAPNWEB_OK},
    0U,
  };
  struct poll_fixture must_not_run = {
    {ITERATE_KIT_POLL_OK, CAPNWEB_OK},
    0U,
  };
  const struct iterate_kit_module modules[] = {
    {NULL, 0U, &expired_subscription, poll_module, NULL, NULL},
    {NULL, 0U, &failed_module, poll_module, NULL, NULL},
    {NULL, 0U, &must_not_run, poll_module, NULL, NULL},
  };
  const struct iterate_kit_peer_options options = {
    "{}",
    2U,
    modules,
    sizeof(modules) / sizeof(modules[0]),
  };
  struct iterate_kit_peer peer = {0};
  const struct iterate_kit_poll_result result =
      iterate_kit_peer_init(&peer, &options) == CAPNWEB_OK
          ? iterate_kit_peer_poll(&peer, 200U)
          : (struct iterate_kit_poll_result){
              ITERATE_KIT_POLL_CAPNWEB_ERROR,
              CAPNWEB_E_STATE,
            };

  /*
   * Continuing past an ended subscription is safe because that module already
   * released its import. Continuing past a driver/Cap'n Web fault would hide
   * an unclassified state transition, so the ordinary fail-fast contract is
   * deliberately preserved for every non-lifecycle result.
   */
  assert(result.status == ITERATE_KIT_POLL_DRIVER_ERROR);
  assert(expired_subscription.calls == 1U);
  assert(failed_module.calls == 1U);
  assert(must_not_run.calls == 0U);
  assert(iterate_kit_peer_subscription_callback_rejections(&peer) == 1U);
}

int main(void) {
  test_callback_rejection_ends_only_that_subscription();
  test_actual_failure_still_stops_and_wins();
  return 0;
}
