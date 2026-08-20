#include "iterate/kit/platforms/esp_idf_restart_note.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_system.h"

/*
 * RTC memory is not initialised on ANY reset, power-on included, so the magic
 * is what separates a note from whatever the RAM happened to hold. Both live in
 * NOINIT for the same reason: a zeroed magic would be indistinguishable from a
 * cold boot that happened to read zero.
 */
enum { NOTE_MAGIC = 0x1EA7E101U };

static RTC_NOINIT_ATTR uint32_t note_magic;
static RTC_NOINIT_ATTR char note_text[ITERATE_KIT_RESTART_NOTE_CAPACITY];

/** Read once at first ask, before anything can overwrite it. */
static const char *read_note_once(void) {
  static bool read;
  static char kept[ITERATE_KIT_RESTART_NOTE_CAPACITY];

  if (!read) {
    read = true;
    if (note_magic == NOTE_MAGIC) {
      /* Terminate defensively: this crossed a restart and is not trusted. */
      note_text[ITERATE_KIT_RESTART_NOTE_CAPACITY - 1U] = '\0';
      (void)snprintf(kept, sizeof(kept), "%s", note_text);
    } else {
      kept[0] = '\0';
    }
    /*
     * CONSUMED. The next boot's note is whatever the next restart writes, and
     * a note left lying around would make an unrelated power-on look like a
     * repeat of a fault that happened once, hours ago.
     */
    note_magic = 0U;
  }
  return kept;
}

void iterate_kit_esp_restart_with_note(const char *why) {
  (void)snprintf(note_text, sizeof(note_text), "%s", why == NULL ? "" : why);
  note_magic = NOTE_MAGIC;
  esp_restart();
}

const char *iterate_kit_esp_last_restart_note(void) { return read_note_once(); }
