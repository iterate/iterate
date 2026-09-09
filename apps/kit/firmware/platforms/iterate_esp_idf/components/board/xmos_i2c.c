#include "iterate/kit/platforms/xmos_i2c.h"

esp_err_t iterate_kit_xmos_i2c_configure_pipeline(
    i2c_master_dev_handle_t device, uint8_t channel, enum iterate_kit_xmos_stage stage) {
  uint8_t command[4];
  if (iterate_kit_xmos_pipeline_command(
          channel, stage, command, sizeof(command)) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  esp_err_t status = i2c_master_transmit(
      device, command, sizeof(command), 50);
  if (status != ESP_OK) {
    return status;
  }
  uint8_t read_command[3];
  uint8_t response[2] = {0xffU, 0xffU};
  if (iterate_kit_xmos_pipeline_read_command(
          channel, read_command, sizeof(read_command)) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  status = i2c_master_transmit(
      device, read_command, sizeof(read_command), 50);
  if (status != ESP_OK) {
    return status;
  }
  status = i2c_master_receive(
      device, response, sizeof(response), 50);
  if (status != ESP_OK) {
    return status;
  }
  return iterate_kit_xmos_pipeline_response_matches(
             response, sizeof(response), stage)
      ? ESP_OK
      : ESP_ERR_INVALID_RESPONSE;
}

enum iterate_kit_status iterate_kit_xmos_i2c_read_vnr(
    i2c_master_dev_handle_t device, uint8_t *vnr) {
  uint8_t command[3];
  uint8_t response[2] = {0xffU, 0xffU};
  if (vnr == NULL) return ITERATE_KIT_INVALID_ARGUMENT;
  if (device == NULL) return ITERATE_KIT_UNAVAILABLE;
  if (iterate_kit_xmos_vnr_command(command, sizeof(command)) !=
      ITERATE_KIT_OK) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (i2c_master_transmit(
          device, command, sizeof(command), 50) != ESP_OK ||
      i2c_master_receive(
          device, response, sizeof(response), 50) != ESP_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  return iterate_kit_xmos_parse_vnr(response, sizeof(response), vnr);
}

esp_err_t iterate_kit_xmos_i2c_verify_version(
    i2c_master_dev_handle_t device, struct iterate_kit_xmos_version *version) {
  uint8_t command[3];
  uint8_t response[4] = {0xffU, 0xffU, 0xffU, 0xffU};
  if (version == NULL ||
      iterate_kit_xmos_version_command(command, sizeof(command)) !=
          ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  esp_err_t status = i2c_master_transmit(
      device, command, sizeof(command), 50);
  if (status != ESP_OK) {
    return status;
  }
  status = i2c_master_receive(
      device, response, sizeof(response), 50);
  if (status != ESP_OK) {
    return status;
  }
  if (iterate_kit_xmos_parse_version(
          response, sizeof(response), version) != ITERATE_KIT_OK ||
      !iterate_kit_xmos_version_is_supported(version)) {
    return ESP_ERR_INVALID_VERSION;
  }
  return ESP_OK;
}
