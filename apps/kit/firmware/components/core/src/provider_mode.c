#include "iterate/kit/provider_mode.h"

#include <stddef.h>

static bool mode_is_valid(
    const struct iterate_kit_provider_mode_options *options, uint8_t mode) {
  return options != NULL && options->mode_count > 0U &&
      options->default_mode < options->mode_count && mode < options->mode_count;
}

uint8_t iterate_kit_provider_mode_load(
    const struct iterate_kit_provider_mode_options *options,
    const struct iterate_kit_provider_mode_store *store) {
  uint8_t mode;
  if (options == NULL || options->mode_count == 0U ||
      options->default_mode >= options->mode_count) {
    return 0U;
  }
  mode = options->default_mode;
  if (store != NULL && store->read != NULL && store->read(store->context, &mode) &&
      mode_is_valid(options, mode)) {
    return mode;
  }
  return options->default_mode;
}

enum iterate_kit_provider_mode_adoption iterate_kit_provider_mode_adopt(
    const struct iterate_kit_provider_mode_options *options,
    const struct iterate_kit_provider_mode_store *store,
    uint8_t *current_mode,
    uint8_t selected_mode,
    bool settled,
    iterate_kit_provider_mode_apply_fn apply,
    iterate_kit_provider_mode_announce_fn announce,
    void *context) {
  if (!mode_is_valid(options, selected_mode) || current_mode == NULL ||
      apply == NULL || (settled && announce == NULL)) {
    return ITERATE_KIT_PROVIDER_MODE_ADOPTION_INVALID;
  }

  apply(context, selected_mode);
  if (settled) {
    bool persisted = true;
    if (selected_mode != *current_mode) {
      persisted = store != NULL && store->write != NULL &&
          store->write(store->context, selected_mode);
    }
    announce(context, selected_mode);
    *current_mode = selected_mode;
    return persisted ? ITERATE_KIT_PROVIDER_MODE_ADOPTION_APPLIED
                     : ITERATE_KIT_PROVIDER_MODE_ADOPTION_PERSISTENCE_FAILED;
  }
  *current_mode = selected_mode;
  return ITERATE_KIT_PROVIDER_MODE_ADOPTION_APPLIED;
}
