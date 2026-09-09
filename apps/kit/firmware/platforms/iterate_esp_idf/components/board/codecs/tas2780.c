/* Translated from FutureProofHomes Satellite1-ESPHome tas2780/tas2780.cpp:277-598 (GPLv3). */
#include "iterate/kit/platforms/tas2780.h"
#include "iterate/kit/capabilities/health.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static bool iterate_kit_tas2780_i2c_result(struct iterate_kit_tas2780 *amp, esp_err_t result) {
  if (result == ESP_OK) return true;
  if (amp->i2c_failures != UINT32_MAX) ++amp->i2c_failures;
  return false;
}

static bool iterate_kit_tas2780_write(struct iterate_kit_tas2780 *amp, uint8_t address, uint8_t value) {
  const uint8_t bytes[] = {address, value};
  return iterate_kit_tas2780_i2c_result(amp,
      i2c_master_transmit(amp->device, bytes, sizeof(bytes), 100));
}

static bool iterate_kit_tas2780_read(struct iterate_kit_tas2780 *amp, uint8_t address, uint8_t *value) {
  return iterate_kit_tas2780_i2c_result(amp,
      i2c_master_transmit_receive(amp->device, &address, 1, value, 1, 100));
}

static bool iterate_kit_tas2780_set_power_mode(
    struct iterate_kit_tas2780 *amp, enum iterate_kit_tas2780_power_mode mode) {
  uint8_t chnl_0, dc_blk0;
  struct iterate_kit_register_write writes[3];
  if (!iterate_kit_tas2780_read(amp, 0x03, &chnl_0) ||
      !iterate_kit_tas2780_read(amp, 0x04, &dc_blk0) ||
      !iterate_kit_tas2780_power_registers(mode, chnl_0, dc_blk0, writes)) return false;
  for (size_t i = 0; i < 3; ++i) {
    if (!iterate_kit_tas2780_write(amp, writes[i].address, writes[i].value)) return false;
  }
  amp->power_mode = mode;
  return true;
}

bool iterate_kit_tas2780_init(struct iterate_kit_tas2780 *amp, i2c_master_dev_handle_t device) {
  if (amp == NULL) return false;
  *amp = (struct iterate_kit_tas2780){
      .device = device, .power_mode = ITERATE_KIT_TAS2780_POWER_MODE_NONE, .volume = 100};
  if (device == NULL) return false;
  size_t count;
  const struct iterate_kit_register_write *writes = iterate_kit_tas2780_base_script(&count);
  for (size_t i = 0; i < count; ++i) {
    if (!iterate_kit_tas2780_write(amp, writes[i].address, writes[i].value)) return false;
  }
  uint8_t chip_id;
  if (!iterate_kit_tas2780_read(amp, 0x05, &chip_id) || chip_id != 0x41) return false;
  amp->initialized = true;
  return true;
}

bool iterate_kit_tas2780_activate(struct iterate_kit_tas2780 *amp) {
  if (amp == NULL || !amp->initialized) return false;
  if (!iterate_kit_tas2780_write(amp, 0x00, 0x00) ||
      !iterate_kit_tas2780_set_power_mode(amp, ITERATE_KIT_TAS2780_POWER_MODE_0) ||
      !iterate_kit_tas2780_write(amp, 0x5C, 0x1D) ||
      !iterate_kit_tas2780_write(amp, 0x02, 0x81)) goto failed;
  vTaskDelay(pdMS_TO_TICKS(100));
  uint8_t sar[4];
  for (size_t i = 0; i < sizeof(sar); ++i) {
    if (!iterate_kit_tas2780_read(amp, (uint8_t)(0x52 + i), &sar[i])) goto failed;
  }
  amp->vbat1s_centivolts = iterate_kit_tas2780_vbat1s_centivolts(sar[0], sar[1]);
  amp->pvdd_centivolts = iterate_kit_tas2780_pvdd_centivolts(sar[2], sar[3]);
  const enum iterate_kit_tas2780_power_mode mode = iterate_kit_tas2780_power_mode_for(
      amp->pvdd_centivolts, amp->vbat1s_centivolts);
  if (mode == ITERATE_KIT_TAS2780_POWER_MODE_NONE) goto failed;
  /* The reference only ever writes CDS/VBAT1S/UVLO from the post-reset
   * shutdown state (tas2780.cpp:375-379 re-runs init() on a mode change). A
   * live rewrite while ACTIVE_MUTED is a different sequence on a PD supply;
   * drop to software shutdown first when leaving the bootstrap mode. */
  if (mode != ITERATE_KIT_TAS2780_POWER_MODE_0 &&
      !iterate_kit_tas2780_write(amp, 0x02, 0x82)) goto failed;
  if (!iterate_kit_tas2780_set_power_mode(amp, mode) ||
      !iterate_kit_tas2780_write(amp, 0x02, 0x80)) goto failed;
  return true;

failed:
  /* The primary operation stays failed; recovery has one attempt and its
   * bus failures are counted, including failure to select page zero. */
  amp->power_mode = ITERATE_KIT_TAS2780_POWER_MODE_NONE;
  if (!iterate_kit_tas2780_shutdown(amp)) return false;
  return false;
}

bool iterate_kit_tas2780_set_volume(struct iterate_kit_tas2780 *amp, uint8_t percent, uint8_t *applied) {
  if (amp == NULL || !amp->initialized || applied == NULL) return false;
  const uint8_t volume = percent > 100 ? 100 : percent;
  const uint8_t dvc = amp->muted ? ITERATE_KIT_TAS2780_DVC_MUTE :
      iterate_kit_tas2780_dvc_for_percent(volume);
  if (!iterate_kit_tas2780_write(amp, 0x00, 0x00) ||
      !iterate_kit_tas2780_write(amp, 0x1A, dvc)) return false;
  amp->volume = volume;
  *applied = volume;
  return true;
}

bool iterate_kit_tas2780_mute(struct iterate_kit_tas2780 *amp, bool muted) {
  if (amp == NULL || !amp->initialized) return false;
  const uint8_t dvc = muted ? ITERATE_KIT_TAS2780_DVC_MUTE :
      iterate_kit_tas2780_dvc_for_percent(amp->volume);
  if (!iterate_kit_tas2780_write(amp, 0x00, 0x00) ||
      !iterate_kit_tas2780_write(amp, 0x1A, dvc)) return false;
  amp->muted = muted;
  return true;
}

bool iterate_kit_tas2780_shutdown(struct iterate_kit_tas2780 *amp) {
  return amp != NULL && amp->device != NULL &&
      iterate_kit_tas2780_write(amp, 0x00, 0x00) &&
      iterate_kit_tas2780_write(amp, 0x02, 0x82);
}

bool iterate_kit_tas2780_read_faults(struct iterate_kit_tas2780 *amp, uint32_t *faults) {
  if (amp == NULL || !amp->initialized || faults == NULL) return false;
  static const uint8_t addresses[] = {0x49, 0x4A, 0x4B, 0x4F};
  uint8_t latches[4];
  if (!iterate_kit_tas2780_write(amp, 0x00, 0x00)) return false;
  for (size_t i = 0; i < sizeof(addresses); ++i) {
    if (!iterate_kit_tas2780_read(amp, addresses[i], &latches[i])) return false;
  }
  amp->faults = iterate_kit_tas2780_decode_faults(latches[0], latches[1], latches[2], latches[3]);
  *faults = amp->faults;
  return true;
}

size_t iterate_kit_tas2780_health(const struct iterate_kit_tas2780 *amp, char *out, size_t capacity) {
  if (amp == NULL || out == NULL) return 0;
  const struct iterate_kit_health_field fields[] = {
    {"ampPowerMode", amp->power_mode},
    {"ampPvddCentiVolts", amp->pvdd_centivolts},
    {"ampVbat1sCentiVolts", amp->vbat1s_centivolts},
    {"ampFaults", amp->faults},
    {"ampI2cFailures", amp->i2c_failures},
  };
  return iterate_kit_health_append_fields(out, capacity, fields, sizeof(fields) / sizeof(fields[0]));
}
