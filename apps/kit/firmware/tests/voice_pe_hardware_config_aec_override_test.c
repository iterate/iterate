#include "iterate/kit/platforms/voice_pe_hardware_config.h"

#include <assert.h>

/*
 * A diagnostic A/B must not require an engineer to edit the production stage
 * literal and then remember to put it back. That workflow previously left
 * evidence whose tap identity could only be inferred from git archaeology.
 * Compile this second copy with the explicit AEC selector and prove the
 * hardware-policy accessor reports it; the ordinary test remains the guard
 * that an unqualified production build defaults to NS.
 */
int main(void) {
  assert(
      iterate_kit_voice_pe_xmos_uplink_stage() ==
      ITERATE_KIT_VOICE_PE_XMOS_STAGE_AEC);
  return 0;
}
