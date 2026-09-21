#include "satellite1_power_policy.h"

bool iterate_kit_satellite1_pd_rail_is_low(
    bool pd_ready, uint16_t contract_millivolts, uint16_t pvdd_centivolts) {
  return pd_ready && (uint32_t)pvdd_centivolts * 10U <
      (uint32_t)contract_millivolts * 9U / 10U;
}

uint8_t iterate_kit_satellite1_output_level_for_power(
    bool pd_ready, uint16_t contract_millivolts, uint16_t contract_milliamps,
    uint16_t pvdd_centivolts) {
  if (iterate_kit_satellite1_pd_rail_is_low(
          pd_ready, contract_millivolts, pvdd_centivolts)) {
    return ITERATE_KIT_SATELLITE1_CONSERVATIVE_OUTPUT_LEVEL;
  }
  const uint32_t contract_mw =
      (uint32_t)contract_millivolts * contract_milliamps / 1000U;
  return pd_ready && contract_mw >= 30000U && pvdd_centivolts >= 1800U
      ? ITERATE_KIT_SATELLITE1_HIGH_POWER_OUTPUT_LEVEL
      : ITERATE_KIT_SATELLITE1_CONSERVATIVE_OUTPUT_LEVEL;
}
