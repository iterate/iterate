#ifndef ITERATE_KIT_PLATFORMS_PROVIDER_MODE_NVS_H
#define ITERATE_KIT_PLATFORMS_PROVIDER_MODE_NVS_H

#include "iterate/kit/provider_mode.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** One board's existing NVS location for its selected provider mode. */
struct iterate_kit_provider_mode_nvs {
  const char *namespace_name;
  const char *key;
  /** StackChan starts before the transport, so it initialises NVS on restore. */
  bool initialize_flash_on_load;
};

/** Build the core store adapter for this board's NVS location. */
struct iterate_kit_provider_mode_store iterate_kit_provider_mode_nvs_store(
    const struct iterate_kit_provider_mode_nvs *nvs);

#ifdef __cplusplus
}
#endif

#endif
