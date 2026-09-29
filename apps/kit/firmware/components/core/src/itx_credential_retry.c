#include "iterate/kit/itx_credential_retry.h"

#include "iterate/kit/atomic.h"

#include <stddef.h>

enum iterate_kit_status iterate_kit_itx_credential_retry_init(
    struct iterate_kit_itx_credential_retry *retry) {
  if (retry == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  retry->refusals = 0U;
  retry->refused = 0U;
  return iterate_kit_retry_gate_init(
      &retry->gate,
      (uint32_t)ITERATE_KIT_ITX_CREDENTIAL_RETRY_MS,
      (uint32_t)ITERATE_KIT_ITX_CREDENTIAL_RETRY_MAX_MS);
}

bool iterate_kit_itx_credential_retry_ready(
    const struct iterate_kit_itx_credential_retry *retry,
    int64_t now_us) {
  return retry != NULL && iterate_kit_retry_gate_ready(&retry->gate, now_us);
}

bool iterate_kit_itx_credential_retry_upgrade_failed(
    struct iterate_kit_itx_credential_retry *retry,
    int32_t upgrade_status,
    int64_t now_us) {
  if (retry == NULL || (upgrade_status != 401 && upgrade_status != 403)) {
    return false;
  }
  iterate_kit_atomic_saturating_increment_relaxed_u32(&retry->refusals);
  __atomic_store_n(&retry->refused, 1U, __ATOMIC_RELAXED);
  iterate_kit_retry_gate_defer(&retry->gate, now_us);
  return true;
}

void iterate_kit_itx_credential_retry_upgraded(
    struct iterate_kit_itx_credential_retry *retry) {
  if (retry != NULL) {
    __atomic_store_n(&retry->refused, 0U, __ATOMIC_RELAXED);
  }
}

void iterate_kit_itx_credential_retry_mounted(
    struct iterate_kit_itx_credential_retry *retry) {
  if (retry != NULL) {
    iterate_kit_retry_gate_reset(&retry->gate);
  }
}

bool iterate_kit_itx_credential_retry_refused(
    const struct iterate_kit_itx_credential_retry *retry) {
  return retry != NULL &&
      iterate_kit_atomic_load_relaxed_u32(&retry->refused) != 0U;
}

uint32_t iterate_kit_itx_credential_retry_refusals(
    const struct iterate_kit_itx_credential_retry *retry) {
  return retry == NULL
      ? 0U
      : iterate_kit_atomic_load_relaxed_u32(&retry->refusals);
}
