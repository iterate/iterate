#include "iterate/kit/configuration.h"

#include <stdint.h>
#include <stdio.h>

int main(void) {
  uint8_t image[4096];
  struct iterate_kit_configuration configuration;
  const size_t image_size =
      fread(image, 1U, sizeof(image), stdin);
  enum iterate_kit_configuration_error error;

  if (ferror(stdin) != 0) {
    fputs("failed to read configuration image\n", stderr);
    return 2;
  }
  if (image_size == sizeof(image) && fgetc(stdin) != EOF) {
    fputs("configuration image exceeds fixture capacity\n", stderr);
    return 2;
  }

  error = iterate_kit_configuration_decode(
      &configuration, image, image_size);
  if (error != ITERATE_KIT_CONFIGURATION_OK) {
    fprintf(
        stderr,
        "configuration decode failed: %s\n",
        iterate_kit_configuration_error_name(error));
    return 1;
  }

  printf(
      "%s\n%s\n%s\n%s\n%s\n%s\n",
      configuration.wifi_ssid,
      configuration.wifi_password,
      configuration.os_base_url,
      configuration.pcm_base_url,
      configuration.project_id,
      configuration.project_api_key);
  return 0;
}
