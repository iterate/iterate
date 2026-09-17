#ifndef ITERATE_KIT_PLATFORMS_RESTART_NOTE_H
#define ITERATE_KIT_PLATFORMS_RESTART_NOTE_H
#ifdef __cplusplus
extern "C" {
#endif
#define ITERATE_KIT_RESTART_NOTE_CAPACITY 64
/** Says why, then ends the process (esp_restart on this platform): the person
 * at the keyboard is the reboot. */
void iterate_kit_platform_restart_with_note(const char *why);
/** A fresh process carries no note. */
const char *iterate_kit_platform_last_restart_note(void);
#ifdef __cplusplus
}
#endif
#endif
