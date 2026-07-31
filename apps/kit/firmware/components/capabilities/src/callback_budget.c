#include "iterate/kit/capabilities/callback_budget.h"

#include <string.h>

enum iterate_kit_status iterate_kit_callback_budget_init(
    struct iterate_kit_callback_budget *budget,
    size_t capacity) {
  if (budget == NULL || capacity == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(budget, 0, sizeof(*budget));
  budget->capacity = capacity;
  budget->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_callback_budget_acquire(
    struct iterate_kit_callback_budget *budget) {
  if (budget == NULL || !budget->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (budget->in_flight == budget->capacity) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  ++budget->in_flight;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_callback_budget_release(
    struct iterate_kit_callback_budget *budget) {
  if (budget == NULL ||
      !budget->initialized ||
      budget->in_flight == 0U) {
    /*
     * Underflow means a module lost callback ownership accounting. Clamping it
     * to zero would hide a defect and could admit more wire work than the
     * device profile proved its transport can hold.
     */
    return ITERATE_KIT_STATE_ERROR;
  }
  --budget->in_flight;
  return ITERATE_KIT_OK;
}
