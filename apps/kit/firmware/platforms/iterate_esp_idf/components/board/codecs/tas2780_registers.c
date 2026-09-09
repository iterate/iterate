/* Translated from FutureProofHomes Satellite1-ESPHome tas2780/tas2780.cpp:161-598 (GPLv3). */
#include "iterate/kit/platforms/tas2780_registers.h"

static const struct iterate_kit_register_write iterate_kit_tas2780_base_writes[] = {
  {0x00, 0x00}, {0x01, 0x01}, {0x00, 0x00}, {0x0E, 0x44},
  {0x0F, 0x40}, {0x00, 0x01}, {0x19, 0x00}, {0x17, 0xC8},
  {0x21, 0x00}, {0x35, 0x74}, {0x00, 0xFD}, {0x0D, 0x0D},
  {0x3E, 0x4A}, {0x0D, 0x00}, {0x00, 0x00}, {0x3D, 0xFF},
  {0x40, 0xFF}, {0x41, 0xFF}, {0x3C, 0xFF}, {0x0A, 0x3E},
};

const struct iterate_kit_register_write *iterate_kit_tas2780_base_script(size_t *count) {
  if (count != NULL) {
    *count = sizeof(iterate_kit_tas2780_base_writes) / sizeof(iterate_kit_tas2780_base_writes[0]);
  }
  return iterate_kit_tas2780_base_writes;
}

uint8_t iterate_kit_tas2780_dvc_for_percent(uint8_t percent) {
  return percent >= 100U ? 0U : (uint8_t)((100U - percent) * 2U);
}

enum iterate_kit_tas2780_power_mode iterate_kit_tas2780_power_mode_for(
    uint16_t pvdd_centivolts, uint16_t vbat1s_centivolts) {
  if (pvdd_centivolts >= 740U) return ITERATE_KIT_TAS2780_POWER_MODE_2;
  if (vbat1s_centivolts > 290U && vbat1s_centivolts <= 550U) {
    return ITERATE_KIT_TAS2780_POWER_MODE_0;
  }
  return ITERATE_KIT_TAS2780_POWER_MODE_NONE;
}

bool iterate_kit_tas2780_power_registers(
    enum iterate_kit_tas2780_power_mode mode, uint8_t chnl_0, uint8_t dc_blk0,
    struct iterate_kit_register_write out[3]) {
  if (out == NULL || (mode != ITERATE_KIT_TAS2780_POWER_MODE_0 &&
                      mode != ITERATE_KIT_TAS2780_POWER_MODE_2)) return false;
  const bool mode_2 = mode == ITERATE_KIT_TAS2780_POWER_MODE_2;
  out[0] = (struct iterate_kit_register_write){0x03,
      (uint8_t)((chnl_0 & 0x01U) | (mode_2 ? 0xC0U : 0x80U) | (8U << 1))};
  out[1] = (struct iterate_kit_register_write){0x04,
      (uint8_t)((dc_blk0 & 0x7FU) | (mode_2 ? 0x80U : 0U))};
  out[2] = (struct iterate_kit_register_write){0x71, mode_2 ? 0x11 : 0x03};
  return true;
}

uint16_t iterate_kit_tas2780_sar_raw(uint8_t msb, uint8_t lsb) {
  return (uint16_t)(((uint16_t)msb << 4) | (lsb >> 4));
}

uint16_t iterate_kit_tas2780_vbat1s_centivolts(uint8_t msb, uint8_t lsb) {
  return (uint16_t)((uint32_t)iterate_kit_tas2780_sar_raw(msb, lsb) * 100U / 128U);
}

uint16_t iterate_kit_tas2780_pvdd_centivolts(uint8_t msb, uint8_t lsb) {
  return (uint16_t)((uint32_t)iterate_kit_tas2780_sar_raw(msb, lsb) * 100U / 64U);
}

uint32_t iterate_kit_tas2780_decode_faults(
    uint8_t latch_0, uint8_t latch_1, uint8_t latch_1_0, uint8_t latch_2) {
  return (uint32_t)latch_0 | ((uint32_t)(latch_1 & 0x79U) << 8) |
      ((uint32_t)(latch_1_0 & 0xA0U) << 16) | ((uint32_t)(latch_2 & 0x0FU) << 24);
}
