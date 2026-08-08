#ifndef ITERATE_KIT_AEC_REFERENCE_SCALER_H
#define ITERATE_KIT_AEC_REFERENCE_SCALER_H

#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

/**
 * Raises an electrical AEC reference to the DSP engine's expected scale.
 *
 * This is intentionally a memoryless, allocation-free primitive rather than
 * part of a device driver or adaptive filter. Some boards provide a physical
 * divider carrying the actual amplifier output; preserving that signal is
 * better than reconstructing it from pristine PCM, but its fixed attenuation
 * is board-specific. Keeping the calibration at this seam makes the cost and
 * clipping observable and lets host tests prove it cannot wrap.
 *
 * Input and output may be the same array. `clipped_samples` is a lifetime
 * saturating counter owned by the caller so abnormal board levels remain in
 * diagnostics instead of disappearing after the next metrics interval.
 */
enum iterate_kit_status iterate_kit_aec_reference_scale(
    const int16_t *input,
    int16_t *output,
    size_t sample_count,
    uint32_t multiplier,
    uint64_t *clipped_samples);

#endif
