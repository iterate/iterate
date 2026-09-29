#ifndef ITERATE_KIT_ITX_CREDENTIAL_RETRY_H
#define ITERATE_KIT_ITX_CREDENTIAL_RETRY_H

#include "iterate/kit/retry_gate.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * A refused key is asked again after a minute, doubling to ten. Setting the
   * device up again is what mends it, and that rewrites the key and restarts,
   * so a retry serves only a refusal that ends on its own: a key minted
   * moments ago that has not reached every location yet, or an OS that
   * refused in error and was fixed. Ten minutes bounds how long either
   * outlives its cause.
   */
  ITERATE_KIT_ITX_CREDENTIAL_RETRY_MS = 60000,
  ITERATE_KIT_ITX_CREDENTIAL_RETRY_MAX_MS = 600000,
};

/**
 * The gate every platform's transport asks, beside its own reconnect gate,
 * before it opens an `/api` upgrade.
 *
 * A 401 or 403 answer to the upgrade is the OS refusing the key the upgrade
 * carried, before any session exists: unknown, expired, ended, or without the
 * scope `/api` needs. The same key gets the same answer however soon it is
 * asked again, so a refusal holds the next upgrade back on this gate. A network
 * failure, a 5xx or a 429 leaves it alone: a prompt retry can outlast those.
 *
 * The task that opens upgrades alone calls init, ready, upgrade_failed,
 * upgraded and mounted. refused and refusals may be sampled from any task.
 */
struct iterate_kit_itx_credential_retry {
  struct iterate_kit_retry_gate gate;
  /** Upgrades answered 401 or 403, saturating. */
  uint32_t refusals;
  /** 1 from a refused upgrade until an upgrade succeeds. */
  uint32_t refused;
};

enum iterate_kit_status iterate_kit_itx_credential_retry_init(
    struct iterate_kit_itx_credential_retry *retry);

/** False while a refused key waits. A boot's first upgrade never does. */
bool iterate_kit_itx_credential_retry_ready(
    const struct iterate_kit_itx_credential_retry *retry,
    int64_t now_us);

/**
 * An upgrade failed, and `upgrade_status` is its answer's HTTP status (0 when
 * none arrived, -1 when it did not parse). Returns whether it refused the key.
 */
bool iterate_kit_itx_credential_retry_upgrade_failed(
    struct iterate_kit_itx_credential_retry *retry,
    int32_t upgrade_status,
    int64_t now_us);

/** The OS accepted the key, so it is no longer refused. */
void iterate_kit_itx_credential_retry_upgraded(
    struct iterate_kit_itx_credential_retry *retry);

/**
 * A session mounted on the key, which proves it: a later refusal waits a
 * minute again.
 */
void iterate_kit_itx_credential_retry_mounted(
    struct iterate_kit_itx_credential_retry *retry);

bool iterate_kit_itx_credential_retry_refused(
    const struct iterate_kit_itx_credential_retry *retry);

uint32_t iterate_kit_itx_credential_retry_refusals(
    const struct iterate_kit_itx_credential_retry *retry);

#ifdef __cplusplus
}
#endif

#endif
