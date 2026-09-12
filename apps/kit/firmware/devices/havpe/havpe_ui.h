#ifndef ITERATE_KIT_HAVPE_UI_H
#define ITERATE_KIT_HAVPE_UI_H
#include "iterate/kit/voice/loop.h"
#ifdef __cplusplus
extern "C" {
#endif
/** Seed the dial from live GPIO16/18 levels with pull-ups; no phantom turn. */
bool havpe_ui_init(void);
/** Sample quadrature each app pass and present board status. */
void havpe_ui_present(const struct iterate_kit_voice_view *view);
/** Drain signed counts at the 25 ms control cadence; app task only. */
int havpe_ui_take_dial(void);
#ifdef __cplusplus
}
#endif
#endif
