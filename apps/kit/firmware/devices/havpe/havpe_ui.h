#ifndef ITERATE_KIT_HAVPE_UI_H
#define ITERATE_KIT_HAVPE_UI_H
#include "iterate/kit/voice/loop.h"
#ifdef __cplusplus
extern "C" {
#endif
/** Seed the dial from live GPIO16/18 levels with pull-ups; no phantom turn. */
bool havpe_ui_init(void);
/** Sample quadrature each app pass and borrow the idle mode quadrant after
 * board.c paints the ring. A timed dial overlay wins for one second.
 */
void havpe_ui_present(const struct iterate_kit_voice_view *view);
/** Borrow one bright quadrant for the selected mode, for one second. */
void havpe_ui_show_mode(uint8_t mode);
/** Adopt the dim idle quadrant; the next press's posture is glanceable. */
void havpe_ui_set_mode(uint8_t mode);
/** Drain signed counts at the 25 ms control cadence; app task only. */
int havpe_ui_take_dial(void);
#ifdef __cplusplus
}
#endif
#endif
