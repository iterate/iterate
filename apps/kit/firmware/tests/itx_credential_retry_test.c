/*
 * A REFUSED KEY WAITS; A FAILED NETWORK DOES NOT.
 *
 * Every platform's transport asks this gate before it opens an upgrade, beside
 * its own reconnect gate, and tells it how each upgrade ended. These are the
 * decisions it makes for all of them: which answers refuse the key, how long a
 * refused key waits, and what clears the refusal.
 */

#include "iterate/kit/itx_credential_retry.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>

static void only_a_401_or_403_refuses_the_key(void) {
  /*
   * 0 is no answer (DNS, TCP or TLS failed first) and -1 an unparsable one;
   * a 5xx or 429 is the server's trouble, which a prompt retry can outlast.
   */
  static const int32_t refused[] = {401, 403};
  static const int32_t not_refused[] = {
    0, -1, 101, 200, 301, 400, 404, 408, 426, 429, 500, 502, 503, 504,
  };
  struct iterate_kit_itx_credential_retry retry;
  size_t index;

  assert(iterate_kit_itx_credential_retry_init(&retry) == ITERATE_KIT_OK);
  for (index = 0U; index < sizeof(not_refused) / sizeof(not_refused[0]);
       ++index) {
    assert(!iterate_kit_itx_credential_retry_upgrade_failed(
        &retry, not_refused[index], 0));
  }
  assert(!iterate_kit_itx_credential_retry_refused(&retry));
  assert(iterate_kit_itx_credential_retry_refusals(&retry) == 0U);
  assert(iterate_kit_itx_credential_retry_ready(&retry, 0));

  for (index = 0U; index < sizeof(refused) / sizeof(refused[0]); ++index) {
    assert(iterate_kit_itx_credential_retry_init(&retry) == ITERATE_KIT_OK);
    assert(iterate_kit_itx_credential_retry_upgrade_failed(
        &retry, refused[index], 0));
    assert(iterate_kit_itx_credential_retry_refused(&retry));
    assert(iterate_kit_itx_credential_retry_refusals(&retry) == 1U);
    assert(!iterate_kit_itx_credential_retry_ready(&retry, 0));
  }
}

static void a_refused_key_waits_a_minute_doubling_to_ten(void) {
  static const int64_t waits_ms[] = {
    60000, 120000, 240000, 480000, 600000, 600000,
  };
  struct iterate_kit_itx_credential_retry retry;
  int64_t now_us = 1000000;
  size_t index;

  assert(iterate_kit_itx_credential_retry_init(&retry) == ITERATE_KIT_OK);
  /* A boot's first upgrade is never held back: the key may be new. */
  assert(iterate_kit_itx_credential_retry_ready(&retry, now_us));

  for (index = 0U; index < sizeof(waits_ms) / sizeof(waits_ms[0]); ++index) {
    const int64_t wait_us = waits_ms[index] * 1000;
    assert(iterate_kit_itx_credential_retry_upgrade_failed(
        &retry, 401, now_us));
    assert(!iterate_kit_itx_credential_retry_ready(
        &retry, now_us + wait_us - 1));
    assert(iterate_kit_itx_credential_retry_ready(&retry, now_us + wait_us));
    now_us += wait_us;
  }
  assert(iterate_kit_itx_credential_retry_refusals(&retry) == 6U);

  /* A network failure between refusals neither waits nor clears the key. */
  assert(!iterate_kit_itx_credential_retry_upgrade_failed(&retry, 0, now_us));
  assert(iterate_kit_itx_credential_retry_ready(&retry, now_us));
  assert(iterate_kit_itx_credential_retry_refused(&retry));
}

static void an_accepted_key_clears_and_a_mount_restarts_the_wait(void) {
  struct iterate_kit_itx_credential_retry retry;
  const int64_t minute_us =
      (int64_t)ITERATE_KIT_ITX_CREDENTIAL_RETRY_MS * 1000;
  int64_t now_us = 0;

  assert(iterate_kit_itx_credential_retry_init(&retry) == ITERATE_KIT_OK);
  assert(iterate_kit_itx_credential_retry_upgrade_failed(&retry, 403, now_us));
  now_us += minute_us;
  assert(iterate_kit_itx_credential_retry_upgrade_failed(&retry, 403, now_us));
  now_us += 2 * minute_us;

  /* The OS took the key: the refusal is over, whatever the wait had grown to. */
  iterate_kit_itx_credential_retry_upgraded(&retry);
  assert(!iterate_kit_itx_credential_retry_refused(&retry));
  assert(iterate_kit_itx_credential_retry_refusals(&retry) == 2U);

  /* A mounted session proves the key: a later refusal waits a minute again. */
  iterate_kit_itx_credential_retry_mounted(&retry);
  assert(iterate_kit_itx_credential_retry_upgrade_failed(&retry, 401, now_us));
  assert(!iterate_kit_itx_credential_retry_ready(
      &retry, now_us + minute_us - 1));
  assert(iterate_kit_itx_credential_retry_ready(&retry, now_us + minute_us));
}

int main(void) {
  only_a_401_or_403_refuses_the_key();
  a_refused_key_waits_a_minute_doubling_to_ten();
  an_accepted_key_clears_and_a_mount_restarts_the_wait();
  return 0;
}
