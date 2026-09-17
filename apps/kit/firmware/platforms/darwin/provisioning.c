/* provisioning.c: the board's provisioning image, read from a file. */
#include "iterate/kit/platforms/provisioning.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

enum { IMAGE_CAPACITY = 4096 };

static const char *image_path;

void iterate_kit_darwin_provisioning_set_path(const char *path) {
  image_path = path;
}

static struct iterate_kit_platform_provisioning_result result(
    enum iterate_kit_platform_provisioning_status status,
    enum iterate_kit_configuration_error configuration_error,
    int32_t platform_error) {
  const struct iterate_kit_platform_provisioning_result value = {
    .status = status,
    .configuration_error = configuration_error,
    .platform_error = platform_error,
  };
  return value;
}

struct iterate_kit_platform_provisioning_result
iterate_kit_platform_read_provisioning(
    struct iterate_kit_configuration *configuration) {
  static uint8_t image[IMAGE_CAPACITY];
  FILE *file;
  size_t size;
  enum iterate_kit_configuration_error decode_error;
  if (configuration == NULL) {
    return result(
        ITERATE_KIT_PLATFORM_PROVISIONING_INVALID_ARGUMENT,
        ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT, 0);
  }
  /* Cleared before any failure, so nothing continues on a previous read. */
  memset(configuration, 0, sizeof(*configuration));
  if (image_path == NULL || image_path[0] == '\0') {
    return result(
        ITERATE_KIT_PLATFORM_PROVISIONING_NO_PATH,
        ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT, 0);
  }
  file = fopen(image_path, "rb");
  if (file == NULL) {
    return result(
        ITERATE_KIT_PLATFORM_PROVISIONING_OPEN_FAILED,
        ITERATE_KIT_CONFIGURATION_INVALID_ARGUMENT, (int32_t)errno);
  }
  size = fread(image, 1U, sizeof(image), file);
  if (ferror(file) != 0) {
    const int error = errno;
    (void)fclose(file);
    return result(
        ITERATE_KIT_PLATFORM_PROVISIONING_READ_FAILED,
        ITERATE_KIT_CONFIGURATION_TRUNCATED, (int32_t)error);
  }
  (void)fclose(file);
  decode_error = iterate_kit_configuration_decode(configuration, image, size);
  memset(image, 0, sizeof(image)); /* the key never lingers in a second buffer */
  if (decode_error != ITERATE_KIT_CONFIGURATION_OK) {
    return result(ITERATE_KIT_PLATFORM_PROVISIONING_DECODE_FAILED, decode_error, 0);
  }
  return result(ITERATE_KIT_PLATFORM_PROVISIONING_OK, ITERATE_KIT_CONFIGURATION_OK, 0);
}

const char *iterate_kit_platform_provisioning_status_name(
    enum iterate_kit_platform_provisioning_status status) {
  switch (status) {
    case ITERATE_KIT_PLATFORM_PROVISIONING_OK: return "ok";
    case ITERATE_KIT_PLATFORM_PROVISIONING_INVALID_ARGUMENT: return "invalid-argument";
    case ITERATE_KIT_PLATFORM_PROVISIONING_NO_PATH: return "no --config path";
    case ITERATE_KIT_PLATFORM_PROVISIONING_OPEN_FAILED: return "open-failed";
    case ITERATE_KIT_PLATFORM_PROVISIONING_READ_FAILED: return "read-failed";
    case ITERATE_KIT_PLATFORM_PROVISIONING_DECODE_FAILED: return "decode-failed";
  }
  return "unknown";
}
