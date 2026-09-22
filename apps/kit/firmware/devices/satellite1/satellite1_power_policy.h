#ifndef ITERATE_KIT_SATELLITE1_POWER_POLICY_H
#define ITERATE_KIT_SATELLITE1_POWER_POLICY_H

#include <stdbool.h>
#include <stdint.h>

enum {
  ITERATE_KIT_SATELLITE1_CONSERVATIVE_OUTPUT_LEVEL = 8,
  ITERATE_KIT_SATELLITE1_HIGH_POWER_OUTPUT_LEVEL = 18,
};

/** Select a safe amplifier output level after TAS2780 has measured PVDD.
 * A PD contract is a requested upstream supply, not proof it reaches PVDD.
 * Keep 15 dBV on a low measured rail; use 20 dBV only when both agree. */
uint8_t iterate_kit_satellite1_output_level_for_power(
    bool pd_ready, uint16_t contract_millivolts, uint16_t contract_milliamps,
    uint16_t pvdd_centivolts);

/** True when a ready contract does not reach 90 percent at the amplifier. */
bool iterate_kit_satellite1_pd_rail_is_low(
    bool pd_ready, uint16_t contract_millivolts, uint16_t pvdd_centivolts);

#endif
