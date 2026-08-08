#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_RESTART_NOTE_H
#define ITERATE_KIT_PLATFORMS_ESP_IDF_RESTART_NOTE_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * A LINE THE DEVICE LEAVES ITSELF BEFORE RESTARTING.
 *
 * `esp_reset_reason()` answers "software" for every restart this firmware asks
 * for, and there are several — a transport that latched fatal, a round trip
 * that never came back. They are different faults with different fixes and one
 * reason code, so from the outside they are the same event.
 *
 * The note is kept in RTC memory, which survives `esp_restart()` and is lost on
 * a power cycle. That is exactly the right lifetime: it answers "why did it
 * just restart itself", not "what happened last week".
 */

/** Longest note kept, including the terminator. Long enough for a sentence. */
#define ITERATE_KIT_RESTART_NOTE_CAPACITY 64

/**
 * Leave `why`, then restart. Does not return.
 *
 * Every `esp_restart()` in this firmware goes through here; a bare one is a
 * restart that cannot be told apart from the others afterwards.
 */
void iterate_kit_esp_restart_with_note(const char *why);

/**
 * The note left by the restart that brought this boot up. "" when there is
 * none — a power-on, a panic, or a flash.
 *
 * Never NULL, so it can go straight into a health document.
 */
const char *iterate_kit_esp_last_restart_note(void);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_PLATFORMS_ESP_IDF_RESTART_NOTE_H */
