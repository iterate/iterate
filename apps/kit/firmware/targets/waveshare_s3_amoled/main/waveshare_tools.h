#ifndef ITERATE_KIT_WAVESHARE_TOOLS_H
#define ITERATE_KIT_WAVESHARE_TOOLS_H

#include "iterate/kit/peer.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The device's live tools: `setBackground(colour)`, `startCall()`, `hangUp()`.
 * Stateless — every method acts on the UI module — so the returned value is
 * safe to pass straight to a peer.
 */
struct iterate_kit_module waveshare_tools_module(void);

/**
 * How the device is, as a JSON object, written into `out`. Returns the length
 * written, or 0 if it would not fit.
 *
 * Provided by main.c because that is where the state lives. This is the same
 * object the device pushes as `voicelab/dev-stats`, deliberately: telemetry
 * stops exactly when the device stops working, and being able to PULL it is
 * the difference between a diagnosis and a serial cable (which, on this
 * board, reboots the evidence away).
 */
size_t waveshare_health_json(char *out, size_t capacity);

#ifdef __cplusplus
}
#endif

#endif
