/* Translated from FutureProofHomes Satellite1-ESPHome satellite1/satellite1.cpp:118-212 (GPLv3), and Satellite1-XMOS device_control_spi.c:12-90 (XMOS PL). */
#include "iterate/kit/platforms/xmos_spi_registers.h"
#include <string.h>

size_t iterate_kit_xmos_spi_frame(uint8_t *out, size_t capacity,
    uint8_t resource, uint8_t command, const uint8_t *payload, size_t payload_length) {
  if (out == NULL || payload_length > ITERATE_KIT_XMOS_SPI_MAX_PAYLOAD ||
      (payload == NULL && payload_length != 0)) return 0;
  const size_t length = payload_length < 4 ? 7 : payload_length + 3;
  if (capacity < length) return 0;
  memset(out, 0, length);
  out[0] = resource;
  out[1] = command;
  out[2] = (uint8_t)(payload_length + ((command & 0x80U) != 0));
  if (payload_length != 0) memcpy(out + 3, payload, payload_length);
  return length;
}

enum iterate_kit_xmos_spi_reply iterate_kit_xmos_spi_classify(
    const uint8_t *rx, size_t length, uint8_t status_register_out[4]) {
  if (rx == NULL || length < 3) return ITERATE_KIT_XMOS_SPI_ERROR;
  if (rx[0] == 7) return ITERATE_KIT_XMOS_SPI_BUSY;
  if (rx[0] == 0 && rx[1] == 0 && rx[2] == 0) return ITERATE_KIT_XMOS_SPI_NO_DEVICE;
  if (rx[0] == 1 && rx[1] != 23) {
    if (length < 6) return ITERATE_KIT_XMOS_SPI_ERROR;
    if (status_register_out != NULL) memcpy(status_register_out, rx + 2, 4);
    return ITERATE_KIT_XMOS_SPI_STATUS_REPORT;
  }
  if (rx[0] == 0) return ITERATE_KIT_XMOS_SPI_OK;
  return ITERATE_KIT_XMOS_SPI_ERROR;
}

bool iterate_kit_xmos_spi_parse_version(const uint8_t *payload, size_t length,
    struct iterate_kit_xmos_version *version) {
  if (payload == NULL || version == NULL || length != 5) return false;
  if ((payload[0] | payload[1] | payload[2] | payload[3] | payload[4]) == 0) return false;
  const uint8_t response[] = {0, payload[0], payload[1], payload[2]};
  return iterate_kit_xmos_parse_version(response, sizeof(response), version) == ITERATE_KIT_OK;
}
