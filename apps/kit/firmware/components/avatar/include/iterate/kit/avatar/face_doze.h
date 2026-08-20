#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/avatar/face_keyframe.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Shared, allocation-free visual language for an inactive voice device.
 *
 * A normal neutral face is ambiguous: it can mean “ready for a call”, “the
 * call is connected but quiet”, or “the renderer has stopped receiving PCM”.
 * The product instead treats closed eyes plus a small authored Z sprite as a
 * semantic state. Targets decide whether their conversation is inactive; this
 * module only turns that decision into identical render controls and pixels.
 *
 * Both calls are pure, bounded O(1) framebuffer work. They retain no state,
 * allocate nothing, and never touch audio or display hardware. `sample_clock`
 * is accepted in 16 kHz units so a future animation can remain deterministic;
 * the initial overlay is deliberately stable because low-refresh targets may
 * render idle state only once.
 */
void face_doze_prepare_render_key(face_render_key_t *render_key);
bool face_doze_apply_overlay(
    uint16_t *rgb565,
    size_t pixel_capacity,
    uint32_t sample_clock);

#ifdef __cplusplus
}
#endif
