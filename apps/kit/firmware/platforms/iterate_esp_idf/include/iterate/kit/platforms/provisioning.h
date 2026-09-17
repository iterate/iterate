#ifndef ITERATE_KIT_PLATFORMS_PROVISIONING_H
#define ITERATE_KIT_PLATFORMS_PROVISIONING_H

#include "iterate/kit/configuration.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Separates flash-layout failures from portable image-format failures.
 *
 * Provisioning tools need to distinguish "the custom partition was never
 * flashed" from "bytes were present but failed CRC/schema validation". Folding
 * both into a generic boot error would make field recovery guesswork and could
 * encourage retrying a permanently corrupt image forever.
 */
enum iterate_kit_platform_provisioning_status {
  ITERATE_KIT_PLATFORM_PROVISIONING_OK = 0,
  ITERATE_KIT_PLATFORM_PROVISIONING_INVALID_ARGUMENT,
  ITERATE_KIT_PLATFORM_PROVISIONING_PARTITION_NOT_FOUND,
  ITERATE_KIT_PLATFORM_PROVISIONING_PARTITION_TOO_SMALL,
  ITERATE_KIT_PLATFORM_PROVISIONING_MMAP_FAILED,
  ITERATE_KIT_PLATFORM_PROVISIONING_DECODE_FAILED,
};

/**
 * Complete, allocation-free provisioning diagnostic.
 *
 * configuration_error is meaningful for DECODE_FAILED (and describes the
 * portable validation class); platform_error carries the ESP-IDF error for
 * MMAP_FAILED. The explicit outer status tells callers which secondary field
 * is evidence rather than forcing them to interpret a coincidental zero.
 */
struct iterate_kit_platform_provisioning_result {
  enum iterate_kit_platform_provisioning_status status;
  enum iterate_kit_configuration_error configuration_error;
  int32_t platform_error;
};

/**
 * Finds the custom `iterate_kit` partition, maps it directly from flash,
 * decodes it into fixed-capacity caller storage, and immediately unmaps it.
 * No filesystem, heap allocation, or full-partition RAM copy is involved.
 * The output is cleared for every non-OK result, so a failed reprovision cannot
 * leave an earlier project's bearer secret live in caller-visible state.
 *
 * Call only during boot/provisioning setup. The returned configuration is a
 * caller-owned copy; it remains valid after the flash mapping is released.
 */
struct iterate_kit_platform_provisioning_result
iterate_kit_platform_read_provisioning(
    struct iterate_kit_configuration *configuration);

/** Stable human-readable classification for boot logs; never returns NULL. */
const char *iterate_kit_platform_provisioning_status_name(
    enum iterate_kit_platform_provisioning_status status);

#ifdef __cplusplus
}
#endif

#endif
