/* restart.c: reset reason and restart note for a process — it starts because it
 * was started, and it restarts by leaving with the reason on stderr. */
#include "iterate/kit/platforms/reset_reason.h"
#include "iterate/kit/platforms/restart_note.h"
#include "iterate/kit/platforms/system_update.h"

#include "esp_idf.h"
#include "esp_system.h"

const char *iterate_kit_platform_reset_reason_name(void) { return "started"; }

bool iterate_kit_platform_reset_by_person(void) { return true; }

void iterate_kit_platform_restart_with_note(const char *why) {
  iterate_kit_host_esp_idf_set_restart_note(why);
  esp_restart();
}

const char *iterate_kit_platform_last_restart_note(void) { return ""; }

enum iterate_kit_status iterate_kit_platform_system_update_begin(
    void *context, const char *url, const char *sha256_hex) {
  (void)context;
  (void)url;
  (void)sha256_hex;
  return ITERATE_KIT_UNAVAILABLE;
}
