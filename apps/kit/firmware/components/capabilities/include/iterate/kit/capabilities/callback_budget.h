#ifndef ITERATE_KIT_CAPABILITIES_CALLBACK_BUDGET_H
#define ITERATE_KIT_CAPABILITIES_CALLBACK_BUDGET_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * One allocation-free admission counter shared by callback-producing modules.
 *
 * A Cap'n Web callback is not one transport message: calling a remote
 * capability emits push+pull, and its completion can return resolve+release.
 * Counting subscriptions independently therefore permits a valid combination
 * of modules to overflow a fixed transport mailbox even when each module is
 * locally bounded. Device profiles size this budget from the complete
 * transport burst proof and share it across metrics, events, and future
 * callback producers.
 *
 * The budget is cooperative-owner state, not an atomic cross-task primitive.
 * Acquire and release must run on the same task that polls the Cap'n Web
 * session. Backpressure means "try on a later poll"; no work is queued here.
 */
struct iterate_kit_callback_budget {
  size_t capacity;
  size_t in_flight;
  bool initialized;
};

enum iterate_kit_status iterate_kit_callback_budget_init(
    struct iterate_kit_callback_budget *budget,
    size_t capacity);

enum iterate_kit_status iterate_kit_callback_budget_acquire(
    struct iterate_kit_callback_budget *budget);

enum iterate_kit_status iterate_kit_callback_budget_release(
    struct iterate_kit_callback_budget *budget);

#ifdef __cplusplus
}
#endif

#endif
