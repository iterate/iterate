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

#ifdef __cplusplus
}
#endif

#endif
