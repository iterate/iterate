#ifndef ITERATE_KIT_PROVIDER_MODE_H
#define ITERATE_KIT_PROVIDER_MODE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** A board-owned byte store for its selected provider mode. */
struct iterate_kit_provider_mode_store {
  const void *context;
  bool (*read)(const void *context, uint8_t *mode);
  bool (*write)(const void *context, uint8_t mode);
};

/** The ordinal domain and fallback for one board's provider menu. */
struct iterate_kit_provider_mode_options {
  uint8_t default_mode;
  uint8_t mode_count;
};

/**
 * Restore a provider mode from a board's store. Missing or out-of-range values
 * select the board's default. `default_mode` must be in `mode_count`.
 */
uint8_t iterate_kit_provider_mode_load(
    const struct iterate_kit_provider_mode_options *options,
    const struct iterate_kit_provider_mode_store *store);

/**
 * Apply a mode to the board's live loop. A board's callback must move every
 * property coupled to its stream path (such as turn posture) together.
 */
typedef void (*iterate_kit_provider_mode_apply_fn)(
    void *context, uint8_t mode);

/** Announce a settled selection with the board's own asset/output. */
typedef void (*iterate_kit_provider_mode_announce_fn)(
    void *context, uint8_t mode);

enum iterate_kit_provider_mode_adoption {
  ITERATE_KIT_PROVIDER_MODE_ADOPTION_INVALID,
  ITERATE_KIT_PROVIDER_MODE_ADOPTION_APPLIED,
  ITERATE_KIT_PROVIDER_MODE_ADOPTION_PERSISTENCE_FAILED,
};

/**
 * Adopt a valid menu selection. Boot restores pass `settled=false`, so they
 * configure silently and never rewrite NVS. A settled selection always
 * announces; it writes only when it actually changes the current mode.
 * Returns a persistence failure after adopting live state, so callers can
 * report it without leaving path and turn posture half-changed.
 */
enum iterate_kit_provider_mode_adoption iterate_kit_provider_mode_adopt(
    const struct iterate_kit_provider_mode_options *options,
    const struct iterate_kit_provider_mode_store *store,
    uint8_t *current_mode,
    uint8_t selected_mode,
    bool settled,
    iterate_kit_provider_mode_apply_fn apply,
    iterate_kit_provider_mode_announce_fn announce,
    void *context);

#ifdef __cplusplus
}
#endif

#endif
