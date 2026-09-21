#include "satellite1_power_policy.h"
#include <assert.h>

int main(void) {
  /* Regression: Satellite1's 20 V / 30 W PD contract can legitimately feed
   * a measured 4.78 V amplifier rail. Keep it audible at 15 dBV instead of
   * refusing codec startup and leaving the amp shut down forever. */
  assert(iterate_kit_satellite1_pd_rail_is_low(true, 20000, 478));
  assert(iterate_kit_satellite1_output_level_for_power(true, 20000, 1500, 478) ==
      ITERATE_KIT_SATELLITE1_CONSERVATIVE_OUTPUT_LEVEL);
  assert(iterate_kit_satellite1_output_level_for_power(false, 0, 0, 478) ==
      ITERATE_KIT_SATELLITE1_CONSERVATIVE_OUTPUT_LEVEL);
  assert(iterate_kit_satellite1_output_level_for_power(true, 20000, 1500, 1800) ==
      ITERATE_KIT_SATELLITE1_HIGH_POWER_OUTPUT_LEVEL);
  assert(iterate_kit_satellite1_output_level_for_power(true, 20000, 1000, 2000) ==
      ITERATE_KIT_SATELLITE1_CONSERVATIVE_OUTPUT_LEVEL);
  assert(iterate_kit_satellite1_output_level_for_power(true, 20000, 1500, 1799) ==
      ITERATE_KIT_SATELLITE1_CONSERVATIVE_OUTPUT_LEVEL);
  return 0;
}
