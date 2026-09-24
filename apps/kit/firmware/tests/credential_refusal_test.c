/*
 * A REFUSED KEY WAITS; A FAILED NETWORK DOES NOT.
 *
 * The ESP transport asks a failed upgrade again on the reconnect gate, 250 ms
 * doubling to 30 s. A 401 or 403 is the OS refusing the key itself, which
 * the same key cannot change, so the network task holds the next attempt on a
 * second gate built from these constants. The two decisions it rests on are
 * pure and tested here: which answers are refusals, and how long one waits.
 */

#include "iterate/kit/platforms/esp_idf_websocket_connection.h"
#include "iterate/kit/platforms/itx_transport.h"
#include "iterate/kit/retry_gate.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

static void only_a_401_or_403_refuses_the_key(void) {
  /*
   * 0 is no answer (DNS, TCP or TLS failed first) and -1 an unparsable one;
   * a 5xx or 429 is the server's trouble, which a prompt retry can outlast.
   */
  static const int32_t refused[] = {401, 403};
  static const int32_t not_refused[] = {
    0, -1, 101, 200, 301, 400, 404, 408, 426, 429, 500, 502, 503, 504,
  };
  size_t index;
  for (index = 0U; index < sizeof(refused) / sizeof(refused[0]); ++index) {
    assert(iterate_kit_esp_idf_websocket_refused_credential(refused[index]));
  }
  for (index = 0U; index < sizeof(not_refused) / sizeof(not_refused[0]);
       ++index) {
    assert(!iterate_kit_esp_idf_websocket_refused_credential(
        not_refused[index]));
  }
}

static void a_refused_key_waits_a_minute_doubling_to_ten(void) {
  static const int64_t waits_ms[] = {
    60000, 120000, 240000, 480000, 600000, 600000,
  };
  struct iterate_kit_retry_gate gate;
  int64_t now_us = 1000000;
  size_t index;

  assert(
      iterate_kit_retry_gate_init(
          &gate,
          (uint32_t)ITERATE_KIT_ITX_CREDENTIAL_RETRY_MS,
          (uint32_t)ITERATE_KIT_ITX_CREDENTIAL_RETRY_MAX_MS) ==
      ITERATE_KIT_OK);
  /* A boot's first upgrade is never held back: the key may be new. */
  assert(iterate_kit_retry_gate_ready(&gate, now_us));

  for (index = 0U; index < sizeof(waits_ms) / sizeof(waits_ms[0]); ++index) {
    const int64_t wait_us = waits_ms[index] * 1000;
    iterate_kit_retry_gate_defer(&gate, now_us);
    assert(!iterate_kit_retry_gate_ready(&gate, now_us + wait_us - 1));
    assert(iterate_kit_retry_gate_ready(&gate, now_us + wait_us));
    now_us += wait_us;
  }

  /*
   * A mounted session proves the key, and the network task resets this gate
   * with the reconnect gate: a later refusal starts again at a minute.
   */
  iterate_kit_retry_gate_reset(&gate);
  assert(iterate_kit_retry_gate_ready(&gate, now_us));
  iterate_kit_retry_gate_defer(&gate, now_us);
  assert(!iterate_kit_retry_gate_ready(
      &gate,
      now_us + (int64_t)ITERATE_KIT_ITX_CREDENTIAL_RETRY_MS * 1000 - 1));
  assert(iterate_kit_retry_gate_ready(
      &gate, now_us + (int64_t)ITERATE_KIT_ITX_CREDENTIAL_RETRY_MS * 1000));
}

int main(void) {
  only_a_401_or_403_refuses_the_key();
  a_refused_key_waits_a_minute_doubling_to_ten();
  return 0;
}
