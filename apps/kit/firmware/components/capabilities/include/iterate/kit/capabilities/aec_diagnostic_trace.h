#ifndef ITERATE_KIT_CAPABILITIES_AEC_DIAGNOSTIC_TRACE_H
#define ITERATE_KIT_CAPABILITIES_AEC_DIAGNOSTIC_TRACE_H

#include "iterate/kit/aec_diagnostic_trace.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ITERATE_KIT_AEC_TRACE_WIRE_SCHEMA = 1,
  ITERATE_KIT_AEC_TRACE_METADATA_WORDS = 16,
};

/**
 * Bounded control-plane adapter for one realtime-owned diagnostic trace.
 *
 * The caller supplies a single scratch region holding five planes for at most
 * maximum_read_samples. A reply borrows that region until Cap'n Web finishes
 * serializing it, so concurrent reads receive explicit backpressure rather
 * than allocating or corrupting a previous response. This capability never
 * runs on the audio task and cannot backpressure sample production.
 */
struct iterate_kit_aec_diagnostic_trace_capability_options {
  struct iterate_kit_aec_diagnostic_trace *trace;
  int16_t *read_scratch;
  size_t read_scratch_values;
  size_t maximum_read_samples;
};

struct iterate_kit_aec_diagnostic_trace_capability {
  struct iterate_kit_aec_diagnostic_trace *trace;
  int16_t *read_scratch;
  size_t read_scratch_values;
  size_t maximum_read_samples;
  volatile uint32_t scratch_borrowed;
  uint32_t initialized;
};

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_capability_init(
    struct iterate_kit_aec_diagnostic_trace_capability *capability,
    const struct iterate_kit_aec_diagnostic_trace_capability_options *options);

struct iterate_kit_module iterate_kit_aec_diagnostic_trace_module(
    struct iterate_kit_aec_diagnostic_trace_capability *capability);

#ifdef __cplusplus
}
#endif

#endif
